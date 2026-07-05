import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/unstable/http";
import * as Context from "effect/Context";
import { completeAppLayer } from "../src/bin.ts";
import { GlobalConfig, Instance, InstancesFile } from "../src/domain/model.ts";
import { isPidAlive, Lock, lockRetryTimeoutMillis } from "../src/services/Lock.ts";
import { StateStore } from "../src/services/StateStore.ts";
import { Xdg } from "../src/services/Xdg.ts";

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

const testLayer = StateStore.layer.pipe(
  Layer.provideMerge(Xdg.layer),
  Layer.provide(NodeServices.layer),
);
const lockLayer = Lock.layer.pipe(Layer.provideMerge(Xdg.layer), Layer.provide(NodeServices.layer));

describe("StateStore", () => {
  it.effect("complete app layer exposes Xdg for command handlers", () =>
    Effect.gen(function* () {
      const context = yield* Effect.scoped(Layer.build(completeAppLayer));
      expect(Context.get(context, Xdg)).toBeDefined();
    }).pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, NodeServices.layer))),
  );

  it.effect("loads defaults when instances file is missing", () =>
    withTempXdg(
      Effect.gen(function* () {
        const store = yield* StateStore;
        expect(yield* store.loadInstances()).toEqual(
          new InstancesFile({ version: 1, instances: {} }),
        );
      }).pipe(Effect.provide(testLayer)),
    ),
  );

  it.effect("round-trips state and writes config mode 0600", () =>
    withTempXdg(
      Effect.gen(function* () {
        const store = yield* StateStore;
        const fs = yield* FileSystem.FileSystem;
        const xdg = yield* Xdg;
        const paths = yield* xdg.paths();
        const instance = new Instance({
          repoName: "yard",
          word: null,
          worktreeRoot: "/repo",
          primaryRoot: "/repo",
          ports: { web: 3100 },
          processes: ["web"],
          createdAt: "now",
          updatedAt: "now",
        });
        yield* store.saveInstances(
          new InstancesFile({ version: 1, instances: { yard: instance } }),
        );
        expect((yield* store.loadInstances()).instances.yard?.ports.web).toBe(3100);
        yield* store.saveGlobalConfig(
          new GlobalConfig({
            version: 1,
            zone: "example.de",
            tunnel: { name: "yard", id: "uuid", credentialsFile: "creds.json" },
          }),
        );
        const stat = yield* fs.stat(paths.configFile);
        expect(Number(stat.mode & 0o777)).toBe(0o600);
        expect(
          yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GlobalConfig))(
            yield* fs.readFileString(paths.configFile),
          ),
        ).toMatchObject({
          zone: "example.de",
        });
      }).pipe(Effect.provide(testLayer)),
    ),
  );
});

describe("Lock", () => {
  it("detects current pid as alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it.effect(
    "waits on live held locks and clears stale locks",
    () =>
      withTempXdg(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const xdg = yield* Xdg;
          const paths = yield* xdg.paths();
          yield* fs.makeDirectory(paths.stateDir, { recursive: true });
          yield* fs.writeFileString(paths.lockFile, `${process.pid}\n`);
          const lock = yield* Lock;
          const [live, elapsed] = yield* TestClock.withLive(
            Effect.gen(function* () {
              const started = yield* Clock.currentTimeMillis;
              const exit = yield* Effect.exit(lock.withMutationLock(Effect.succeed("nope")));
              const ended = yield* Clock.currentTimeMillis;
              return [exit, ended - started] as const;
            }),
          );
          expect(elapsed).toBeGreaterThanOrEqual(lockRetryTimeoutMillis);
          expect(live._tag).toBe("Failure");

          yield* fs.writeFileString(paths.lockFile, "99999999\n");
          expect(yield* lock.withMutationLock(Effect.succeed("ok"))).toBe("ok");
          expect(yield* fs.exists(paths.lockFile)).toBe(false);
        }).pipe(Effect.provide(lockLayer)),
      ),
    10_000,
  );
});
