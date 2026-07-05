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
import { GlobalConfig, Instance } from "../src/domain/model.ts";
import { Caddy, encodeCaddyConfig, generateCaddyConfig } from "../src/services/Caddy.ts";
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
    const oldState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = `${dir}/state`;
    return yield* effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (oldState === undefined) delete process.env.XDG_STATE_HOME;
          else process.env.XDG_STATE_HOME = oldState;
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

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
  it.effect("posts generated config before persisting reboot-safe stopped routes", () => {
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
        expect(yield* fs.readFileString(path)).toBe(
          encodeCaddyConfig(
            generateCaddyConfig(globalConfig, {
              app: { instance: instance({ web: 3100 }), running: false },
            }),
          ),
        );
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
