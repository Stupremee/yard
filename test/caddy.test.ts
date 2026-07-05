import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { renderCaddyConfigFromState } from "../src/commands/daemon.ts";
import { ConfigInvalid } from "../src/domain/errors.ts";
import { GlobalConfig, Instance, InstancesFile } from "../src/domain/model.ts";
import {
  Caddy,
  type CaddyJsonConfig,
  encodeCaddyConfig,
  generateCaddyConfig,
} from "../src/services/Caddy.ts";
import { Output } from "../src/services/Output.ts";
import { StateStore } from "../src/services/StateStore.ts";
import { Systemd } from "../src/services/Systemd.ts";
import { Xdg } from "../src/services/Xdg.ts";

const globalConfig = new GlobalConfig({
  version: 1,
  zone: "example.test",
  caddyHttpPort: 8600,
  caddyAdminPort: 2019,
  tunnel: { name: "yard", id: "uuid", credentialsFile: "creds.json" },
});

const instance = (ports: Record<string, number>, routedProcess = "web") =>
  new Instance({
    repoName: "app",
    word: null,
    worktreeRoot: "/repo",
    primaryRoot: "/repo",
    ports,
    processes: ["web"],
    routedProcess,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
  });

const routesOf = (config: ReturnType<typeof generateCaddyConfig>) =>
  config.apps.http.servers.yard.routes;

const firstHandler = (config: ReturnType<typeof generateCaddyConfig>, index: number) =>
  routesOf(config)[index]?.handle[0];

const makeHttpClient = (
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
) =>
  HttpClient.makeWith(
    Effect.fnUntraced(function* (requestEffect) {
      const request = yield* requestEffect;
      return yield* handler(request);
    }),
    Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>,
  );

const jsonResponse = (request: HttpClientRequest.HttpClientRequest, body: unknown) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

const readRequestBody = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    if (request.body._tag !== "Uint8Array") {
      return yield* Effect.die(new Error("Expected Uint8Array request body"));
    }
    return yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
      new TextDecoder().decode(request.body.body),
    );
  });

const streamText = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  Effect.gen(function* () {
    const chunks = yield* Stream.runCollect(stream);
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  });

const withTempXdg = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const oldConfig = process.env.XDG_CONFIG_HOME;
    const oldState = process.env.XDG_STATE_HOME;
    process.env.XDG_CONFIG_HOME = `${dir}/config`;
    process.env.XDG_STATE_HOME = `${dir}/state`;
    return yield* effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
          else process.env.XDG_CONFIG_HOME = oldConfig;
          if (oldState === undefined) delete process.env.XDG_STATE_HOME;
          else process.env.XDG_STATE_HOME = oldState;
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const renderLayer = (activeUnits: ReadonlySet<string>) => {
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    makeHttpClient((request) => Effect.succeed(jsonResponse(request, {}))),
  );
  const systemdLayer = Layer.succeed(Systemd, {
    writeAppTemplate: () => Effect.void,
    writeAppDropin: () => Effect.succeed(false),
    writeCaddyUnit: () => Effect.void,
    writeTunnelUnit: () => Effect.void,
    daemonReload: () => Effect.void,
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    enable: () => Effect.void,
    disable: () => Effect.void,
    resetFailed: () => Effect.void,
    removeAppDropins: () => Effect.void,
    isActive: (unit: string) => Effect.succeed(activeUnits.has(unit)),
    show: () => Effect.succeed({}),
    listYardUnits: () => Effect.succeed([]),
    journal: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
    journalFollow: () => Effect.void,
    enableLinger: () => Effect.void,
  });
  const caddyLayer = Caddy.layer.pipe(Layer.provide(Xdg.layer), Layer.provide(httpLayer));
  const stateStoreLayer = StateStore.layer.pipe(Layer.provide(Xdg.layer));
  return Layer.merge(
    Xdg.layer,
    Layer.merge(
      caddyLayer,
      Layer.merge(stateStoreLayer, Layer.merge(systemdLayer, Output.layer(false))),
    ),
  ).pipe(Layer.provide(NodeServices.layer));
};

const readRenderedConfig = Effect.fn("test.readRenderedConfig")(function* () {
  const caddy = yield* Caddy;
  const fs = yield* FileSystem.FileSystem;
  return (yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
    yield* fs.readFileString(yield* caddy.configPath()),
  )) as CaddyJsonConfig;
});

describe("generateCaddyConfig", () => {
  it("creates an empty baseline with only the 404 catch-all", () => {
    const config = generateCaddyConfig(globalConfig, {});
    expect(config.admin.listen).toBe("127.0.0.1:2019");
    expect(config.apps.http.servers.yard.listen).toEqual(["127.0.0.1:8600"]);
    expect(config.apps.http.servers.yard.automatic_https).toEqual({ disable: true });
    expect(routesOf(config)).toHaveLength(1);
    expect(firstHandler(config, 0)).toMatchObject({
      handler: "static_response",
      status_code: "404",
    });
  });

  it("routes one running instance to its web port", () => {
    const config = generateCaddyConfig(globalConfig, {
      app: instance({ web: 3100 }),
    });
    expect(routesOf(config)[0]?.match).toEqual([{ host: ["app.example.test"] }]);
    expect(firstHandler(config, 0)).toEqual({
      handler: "reverse_proxy",
      upstreams: [{ dial: "127.0.0.1:3100" }],
    });
  });

  it("adds extra routes with slug-route hostnames", () => {
    const config = generateCaddyConfig(globalConfig, {
      app: instance({ web: 3100, convex: 3210, "convex-site": 3211 }),
    });
    expect(routesOf(config).map((route) => route.match?.[0]?.host[0])).toEqual([
      "app.example.test",
      "app-convex.example.test",
      "app-convex-site.example.test",
      undefined,
    ]);
  });

  it("uses routedProcess for the primary hostname instead of assuming web", () => {
    const config = generateCaddyConfig(globalConfig, {
      app: instance({ app: 3100, convex: 3210 }, "app"),
    });
    expect(routesOf(config).map((route) => route.match?.[0]?.host[0])).toEqual([
      "app.example.test",
      "app-convex.example.test",
      undefined,
    ]);
    expect(firstHandler(config, 0)).toEqual({
      handler: "reverse_proxy",
      upstreams: [{ dial: "127.0.0.1:3100" }],
    });
  });

  it("serves a friendly stopped page for stopped instances", () => {
    const config = generateCaddyConfig(globalConfig, {
      app: { instance: instance({ web: 3100 }), running: false },
    });
    expect(firstHandler(config, 0)).toMatchObject({
      handler: "static_response",
      status_code: "503",
    });
    expect(JSON.stringify(firstHandler(config, 0))).toContain("yard instance stopped");
    expect(JSON.stringify(firstHandler(config, 0))).toContain("app.example.test");
  });

  it("keeps unknown hosts on the final 404 route", () => {
    const config = generateCaddyConfig(globalConfig, {
      app: instance({ web: 3100 }),
    });
    const finalRoute = routesOf(config).at(-1);
    expect(finalRoute?.match).toBeUndefined();
    expect(finalRoute?.handle[0]).toMatchObject({
      handler: "static_response",
      status_code: "404",
    });
  });

  it("has deterministic output ordering", () => {
    const left = encodeCaddyConfig(
      generateCaddyConfig(globalConfig, {
        zed: instance({ web: 3102, beta: 3202 }),
        app: instance({ web: 3100, convex: 3210, alpha: 3200 }),
      }),
    );
    const right = encodeCaddyConfig(
      generateCaddyConfig(globalConfig, {
        app: instance({ convex: 3210, web: 3100, alpha: 3200 }),
        zed: instance({ beta: 3202, web: 3102 }),
      }),
    );
    expect(left).toBe(right);
    expect(
      routesOf(
        generateCaddyConfig(globalConfig, {
          zed: instance({ web: 3102 }),
          app: instance({ web: 3100 }),
        }),
      ).map((route) => route.match?.[0]?.host[0]),
    ).toEqual(["app.example.test", "zed.example.test", undefined]);
  });
});

describe("Caddy service", () => {
  it.effect("posts generated config before persisting the same live-derived routes", () => {
    const seen: Array<{ method: string; url: string; body: unknown }> = [];
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      makeHttpClient((request) =>
        Effect.gen(function* () {
          seen.push({
            method: request.method,
            url: request.url,
            body: yield* readRequestBody(request).pipe(Effect.orDie),
          });
          return jsonResponse(request, {});
        }),
      ),
    );
    const layer = Caddy.layer.pipe(
      Layer.provideMerge(Xdg.layer),
      Layer.provideMerge(httpLayer),
      Layer.provide(NodeServices.layer),
    );
    return withTempXdg(
      Effect.gen(function* () {
        const caddy = yield* Caddy;
        const config = generateCaddyConfig(globalConfig, { app: instance({ web: 3100 }) });
        yield* caddy.syncConfig(globalConfig, { app: instance({ web: 3100 }) });

        const fs = yield* FileSystem.FileSystem;
        const path = yield* caddy.configPath();
        expect(yield* fs.readFileString(path)).toBe(encodeCaddyConfig(config));
        expect(seen).toEqual([
          {
            method: "POST",
            url: "http://127.0.0.1:2019/load",
            body: config,
          },
        ]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it.effect("surfaces CaddyUnreachable when /load fails", () => {
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      makeHttpClient((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("nope", { status: 500 }))),
      ),
    );
    const layer = Caddy.layer.pipe(
      Layer.provideMerge(Xdg.layer),
      Layer.provideMerge(httpLayer),
      Layer.provide(NodeServices.layer),
    );
    return withTempXdg(
      Effect.gen(function* () {
        const caddy = yield* Caddy;
        const exit = yield* Effect.exit(
          caddy.loadConfig(globalConfig, generateCaddyConfig(globalConfig, {})),
        );
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(exit.cause.toString()).toContain("CaddyUnreachable");
        }
      }).pipe(Effect.provide(layer)),
    );
  });

  it.effect(
    "validates a generated host-route config with the system caddy binary when present",
    () =>
      withTempXdg(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const whichExit = yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(ChildProcess.make("which", ["caddy"]));
              yield* Effect.all([Stream.runDrain(handle.stdout), Stream.runDrain(handle.stderr)], {
                concurrency: 2,
              });
              return yield* handle.exitCode;
            }),
          );
          if (Number(whichExit) !== 0) return;

          const config = encodeCaddyConfig(
            generateCaddyConfig(globalConfig, { app: instance({ web: 3100 }) }),
          );
          const dir = yield* fs.makeTempDirectoryScoped();
          const file = path.join(dir, "caddy.json");
          yield* fs.writeFileString(file, config);
          const [exitCode, output] = yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make("caddy", ["validate", "--config", file]),
              );
              const [stdout, stderr] = yield* Effect.all(
                [streamText(handle.stdout), streamText(handle.stderr)],
                { concurrency: 2 },
              );
              return [yield* handle.exitCode, `${stdout}${stderr}`] as const;
            }),
          );
          expect(output).not.toContain(":80");
          expect(Number(exitCode)).toBe(0);
        }),
      ),
  );
});

describe("yard caddy render", () => {
  it.effect("writes a baseline 404 config when global and instance state are absent", () =>
    withTempXdg(
      Effect.gen(function* () {
        yield* renderCaddyConfigFromState();

        const rendered = yield* readRenderedConfig();
        expect(rendered.admin.listen).toBe("127.0.0.1:2019");
        expect(rendered.apps.http.servers.yard.listen).toEqual(["127.0.0.1:8600"]);
        expect(rendered.apps.http.servers.yard.routes).toHaveLength(1);
        expect(rendered.apps.http.servers.yard.routes[0]!.handle[0]).toMatchObject({
          handler: "static_response",
          status_code: "404",
        });
      }).pipe(Effect.provide(renderLayer(new Set()))),
    ),
  );

  it.effect("fails when the global config file is malformed", () =>
    withTempXdg(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const xdg = yield* Xdg;
        const paths = yield* xdg.paths();
        yield* fs.makeDirectory(paths.configDir, { recursive: true });
        yield* fs.writeFileString(paths.configFile, "{");

        const exit = yield* Effect.exit(renderCaddyConfigFromState());

        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const error = yield* Effect.failCause(exit.cause).pipe(Effect.flip);
          expect(error).toBeInstanceOf(ConfigInvalid);
          expect(error.path).toBe(paths.configFile);
        }
      }).pipe(Effect.provide(renderLayer(new Set()))),
    ),
  );

  it.effect("fails when the instances state file is malformed", () =>
    withTempXdg(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* StateStore;
        const xdg = yield* Xdg;
        const paths = yield* xdg.paths();
        yield* store.saveGlobalConfig(globalConfig);
        yield* fs.makeDirectory(paths.stateDir, { recursive: true });
        yield* fs.writeFileString(paths.instancesFile, "{");

        const exit = yield* Effect.exit(renderCaddyConfigFromState());

        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const error = yield* Effect.failCause(exit.cause).pipe(Effect.flip);
          expect(error).toBeInstanceOf(ConfigInvalid);
          expect(error.path).toBe(paths.instancesFile);
        }
      }).pipe(Effect.provide(renderLayer(new Set()))),
    ),
  );

  it.effect("renders stopped pages or proxy routes from live systemd state", () =>
    withTempXdg(
      Effect.gen(function* () {
        const store = yield* StateStore;
        yield* store.saveGlobalConfig(globalConfig);
        yield* store.saveInstances(
          new InstancesFile({
            version: 1,
            instances: {
              app: instance({ web: 3100 }),
              api: instance({ web: 3200 }),
            },
          }),
        );

        yield* renderCaddyConfigFromState();

        const rendered = yield* readRenderedConfig();
        expect(rendered.apps.http.servers.yard.routes[0]!.handle[0]).toMatchObject({
          handler: "static_response",
          status_code: "503",
        });
        expect(rendered.apps.http.servers.yard.routes[1]!.handle[0]).toEqual({
          handler: "reverse_proxy",
          upstreams: [{ dial: "127.0.0.1:3100" }],
        });
      }).pipe(Effect.provide(renderLayer(new Set(["yard-app@app--web.service"])))),
    ),
  );
});
