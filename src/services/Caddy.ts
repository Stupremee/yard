import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { FetchHttpClient } from "effect/unstable/http";
import { CaddyUnreachable, FilesystemError } from "../domain/errors.js";
import { GlobalConfig, Instance } from "../domain/model.js";
import { primaryHostname, routeHostname } from "../domain/slug.js";
import { Xdg } from "./Xdg.js";

export type CaddyInstanceState = {
  readonly instance: Instance;
  readonly running: boolean;
};

export type CaddyInstances = Readonly<Record<string, Instance | CaddyInstanceState>>;

export type CaddyJsonConfig = {
  readonly admin: {
    readonly listen: string;
  };
  readonly apps: {
    readonly http: {
      readonly servers: {
        readonly yard: {
          readonly listen: ReadonlyArray<string>;
          readonly routes: ReadonlyArray<CaddyRoute>;
        };
      };
    };
  };
};

type CaddyRoute = {
  readonly match?: ReadonlyArray<{ readonly host: ReadonlyArray<string> }>;
  readonly handle: ReadonlyArray<CaddyHandler>;
};

type CaddyHandler =
  | {
      readonly handler: "reverse_proxy";
      readonly upstreams: ReadonlyArray<{ readonly dial: string }>;
    }
  | {
      readonly handler: "static_response";
      readonly status_code: string;
      readonly headers?: {
        readonly "Content-Type": ReadonlyArray<string>;
      };
      readonly body: string;
    };

const stoppedBody = (host: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>yard instance stopped</title></head>
<body>
<main>
<h1>yard instance stopped</h1>
<p>The development environment for <strong>${escapeHtml(host)}</strong> is stopped.</p>
<p>Run <code>yard up</code> in the worktree to start it again.</p>
</main>
</body>
</html>`;

const notFoundBody = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>yard route not found</title></head>
<body><main><h1>yard route not found</h1></main></body>
</html>`;

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const normalizeInstanceState = (value: Instance | CaddyInstanceState): CaddyInstanceState =>
  "instance" in value ? value : { instance: value, running: true };

const proxy = (port: number): CaddyHandler => ({
  handler: "reverse_proxy",
  upstreams: [{ dial: `127.0.0.1:${port}` }],
});

const staticResponse = (statusCode: number, body: string): CaddyHandler => ({
  handler: "static_response",
  status_code: String(statusCode),
  headers: { "Content-Type": ["text/html; charset=utf-8"] },
  body,
});

const hostRoute = (host: string, handler: CaddyHandler): CaddyRoute => ({
  match: [{ host: [host] }],
  handle: [handler],
});

const catchAllRoute = (): CaddyRoute => ({
  handle: [staticResponse(404, notFoundBody)],
});

const sortedEntries = <A>(record: Readonly<Record<string, A>>) =>
  Object.entries(record).sort(([left], [right]) => left.localeCompare(right));

export const generateCaddyConfig = (
  globalConfig: GlobalConfig,
  instances: CaddyInstances,
): CaddyJsonConfig => {
  const routes: Array<CaddyRoute> = [];
  for (const [slug, rawState] of sortedEntries(instances)) {
    const state = normalizeInstanceState(rawState);
    const primaryPort = state.instance.ports[state.instance.routedProcess];
    if (primaryPort !== undefined) {
      const host = primaryHostname(slug, globalConfig.zone);
      routes.push(
        hostRoute(
          host,
          state.running ? proxy(primaryPort) : staticResponse(503, stoppedBody(host)),
        ),
      );
    }

    for (const [route, port] of sortedEntries(state.instance.ports)) {
      if (route === state.instance.routedProcess) {
        continue;
      }
      const host = routeHostname(slug, route, globalConfig.zone);
      routes.push(
        hostRoute(host, state.running ? proxy(port) : staticResponse(503, stoppedBody(host))),
      );
    }
  }
  routes.push(catchAllRoute());

  return {
    admin: {
      listen: `127.0.0.1:${globalConfig.caddyAdminPort}`,
    },
    apps: {
      http: {
        servers: {
          yard: {
            listen: [`127.0.0.1:${globalConfig.caddyHttpPort}`],
            routes,
          },
        },
      },
    },
  };
};

export const encodeCaddyConfig = (config: CaddyJsonConfig): string =>
  `${JSON.stringify(config, null, 2)}\n`;

const atomicWriteString = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  file: string,
  contents: string,
) =>
  Effect.gen(function* () {
    const millis = yield* Clock.currentTimeMillis;
    const tmp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${millis}.tmp`,
    );
    yield* fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "mkdir", error })),
      );
    yield* fs
      .writeFileString(tmp, contents)
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "write", error })),
      );
    yield* fs
      .rename(tmp, file)
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "rename", error })),
      );
  });

const toCaddyUnreachable = (url: string, error: unknown) => new CaddyUnreachable({ url, error });

export class Caddy extends Context.Service<
  Caddy,
  {
    readonly generateConfig: (
      globalConfig: GlobalConfig,
      instances: CaddyInstances,
    ) => CaddyJsonConfig;
    readonly configPath: () => Effect.Effect<string>;
    readonly persistConfig: (config: CaddyJsonConfig) => Effect.Effect<void, FilesystemError>;
    readonly loadConfig: (
      globalConfig: GlobalConfig,
      config: CaddyJsonConfig,
    ) => Effect.Effect<void, CaddyUnreachable>;
    readonly getConfig: (globalConfig: GlobalConfig) => Effect.Effect<unknown, CaddyUnreachable>;
    readonly reachable: (globalConfig: GlobalConfig) => Effect.Effect<boolean>;
    readonly syncConfig: (
      globalConfig: GlobalConfig,
      instances: CaddyInstances,
    ) => Effect.Effect<void, FilesystemError | CaddyUnreachable>;
  }
>()("yard/services/Caddy") {
  static readonly layer = Layer.effect(
    Caddy,
    Effect.gen(function* () {
      const xdg = yield* Xdg;
      const paths = yield* xdg.paths();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

      const adminUrl = (globalConfig: GlobalConfig, suffix: string) =>
        `http://127.0.0.1:${globalConfig.caddyAdminPort}${suffix}`;

      const configPath = Effect.fn("Caddy.configPath")(() =>
        Effect.succeed(path.join(paths.stateDir, "caddy.json")),
      );

      const persistConfig = Effect.fn("Caddy.persistConfig")(function* (config: CaddyJsonConfig) {
        yield* atomicWriteString(fs, path, yield* configPath(), encodeCaddyConfig(config));
      });

      const loadConfig = Effect.fn("Caddy.loadConfig")(function* (
        globalConfig: GlobalConfig,
        config: CaddyJsonConfig,
      ) {
        const url = adminUrl(globalConfig, "/load");
        yield* HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyJsonUnsafe(config),
          http.execute,
          Effect.asVoid,
          Effect.mapError((error) => toCaddyUnreachable(url, error)),
        );
      });

      const getConfig = Effect.fn("Caddy.getConfig")(function* (globalConfig: GlobalConfig) {
        const url = adminUrl(globalConfig, "/config/");
        return yield* http.get(url).pipe(
          Effect.flatMap((response) => response.json),
          Effect.mapError((error) => toCaddyUnreachable(url, error)),
        );
      });

      const reachable = Effect.fn("Caddy.reachable")(function* (globalConfig: GlobalConfig) {
        const exit = yield* Effect.exit(getConfig(globalConfig));
        return exit._tag === "Success";
      });

      const syncConfig = Effect.fn("Caddy.syncConfig")(function* (
        globalConfig: GlobalConfig,
        instances: CaddyInstances,
      ) {
        const config = generateCaddyConfig(globalConfig, instances);
        yield* persistConfig(config);
        yield* loadConfig(globalConfig, config);
      });

      return {
        generateConfig: generateCaddyConfig,
        configPath,
        persistConfig,
        loadConfig,
        getConfig,
        reachable,
        syncConfig,
      };
    }),
  );

  static readonly liveLayer = Caddy.layer.pipe(Layer.provide(FetchHttpClient.layer));
}
