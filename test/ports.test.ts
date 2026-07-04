import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { createServer, type Server } from "node:net";
import { GlobalConfig, Instance, InstancesFile } from "../src/domain/model.js";
import { Ports } from "../src/services/Ports.js";
import { StateStore } from "../src/services/StateStore.js";
import { Xdg } from "../src/services/Xdg.js";

const withTempXdg = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const oldConfig = process.env.XDG_CONFIG_HOME;
    const oldState = process.env.XDG_STATE_HOME;
    const oldData = process.env.XDG_DATA_HOME;
    process.env.XDG_CONFIG_HOME = `${dir}/config`;
    process.env.XDG_STATE_HOME = `${dir}/state`;
    process.env.XDG_DATA_HOME = `${dir}/data`;
    return yield* effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
          else process.env.XDG_CONFIG_HOME = oldConfig;
          if (oldState === undefined) delete process.env.XDG_STATE_HOME;
          else process.env.XDG_STATE_HOME = oldState;
          if (oldData === undefined) delete process.env.XDG_DATA_HOME;
          else process.env.XDG_DATA_HOME = oldData;
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const occupy = (port: number) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer();
      server.once("listening", () => resume(Effect.succeed(server)));
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen(port, "127.0.0.1");
    }),
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

const testLayer = Ports.layer.pipe(
  Layer.provideMerge(StateStore.layer),
  Layer.provideMerge(Xdg.layer),
  Layer.provide(NodeServices.layer),
);

const globalConfig = (range: readonly [number, number]) =>
  new GlobalConfig({
    version: 1,
    zone: "example.de",
    portRange: range,
    tunnel: { name: "yard", id: "uuid", credentialsFile: "creds.json" },
  });

const instance = (ports: Record<string, number>) =>
  new Instance({
    repoName: "yard",
    word: null,
    worktreeRoot: "/repo",
    primaryRoot: "/repo",
    ports,
    processes: ["web"],
    createdAt: "now",
    updatedAt: "now",
  });

describe("Ports", () => {
  it.effect("reuses an existing usable port for the same instance route", () =>
    withTempXdg(
      Effect.gen(function* () {
        const store = yield* StateStore;
        yield* store.saveGlobalConfig(globalConfig([3100, 3105]));
        yield* store.saveInstances(
          new InstancesFile({ version: 1, instances: { yard: instance({ web: 3102 }) } }),
        );
        const ports = yield* Ports;
        expect(yield* ports.allocate("yard", "web")).toBe(3102);
      }).pipe(Effect.provide(testLayer)),
    ),
  );

  it.effect("reuses an existing bound port for the same instance route", () =>
    withTempXdg(
      Effect.gen(function* () {
        const store = yield* StateStore;
        yield* store.saveGlobalConfig(globalConfig([3100, 3105]));
        yield* store.saveInstances(
          new InstancesFile({ version: 1, instances: { yard: instance({ web: 3102 }) } }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* occupy(3102);
            const ports = yield* Ports;
            expect(yield* ports.allocate("yard", "web")).toBe(3102);
          }),
        );
      }).pipe(Effect.provide(testLayer)),
    ),
  );

  it.effect("skips ports recorded by other instances", () =>
    withTempXdg(
      Effect.gen(function* () {
        const store = yield* StateStore;
        yield* store.saveGlobalConfig(globalConfig([3100, 3102]));
        yield* store.saveInstances(
          new InstancesFile({
            version: 1,
            instances: {
              other: instance({ web: 3100 }),
              yard: instance({}),
            },
          }),
        );
        const ports = yield* Ports;
        expect(yield* ports.allocate("yard", "web")).toBe(3101);
      }).pipe(Effect.provide(testLayer)),
    ),
  );

  it.effect("skips a real occupied port", () =>
    withTempXdg(
      Effect.gen(function* () {
        const store = yield* StateStore;
        yield* store.saveGlobalConfig(globalConfig([3100, 3102]));
        yield* store.saveInstances(new InstancesFile({ version: 1, instances: {} }));
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* occupy(3100);
            const ports = yield* Ports;
            expect(yield* ports.allocate("yard", "web")).toBe(3101);
          }),
        );
      }).pipe(Effect.provide(testLayer)),
    ),
  );

  it.effect("honors an available port override", () =>
    withTempXdg(
      Effect.gen(function* () {
        const store = yield* StateStore;
        yield* store.saveGlobalConfig(globalConfig([3100, 3102]));
        yield* store.saveInstances(new InstancesFile({ version: 1, instances: {} }));
        const ports = yield* Ports;
        expect(yield* ports.allocate("yard", "web", { override: 3102 })).toBe(3102);
      }).pipe(Effect.provide(testLayer)),
    ),
  );

  it.effect("fails with NoFreePort when a tiny range is exhausted", () =>
    withTempXdg(
      Effect.gen(function* () {
        const store = yield* StateStore;
        yield* store.saveGlobalConfig(globalConfig([3100, 3100]));
        yield* store.saveInstances(
          new InstancesFile({ version: 1, instances: { other: instance({ web: 3100 }) } }),
        );
        const ports = yield* Ports;
        const result = yield* Effect.exit(ports.allocate("yard", "web"));
        expect(result._tag).toBe("Failure");
      }).pipe(Effect.provide(testLayer)),
    ),
  );
});
