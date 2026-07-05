import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { RepoConfig } from "../src/services/RepoConfig.ts";

const withTempDir = <A, E, R>(effect: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    return yield* effect(dir);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const testLayer = RepoConfig.layer.pipe(Layer.provide(NodeServices.layer));

describe("RepoConfig", () => {
  it.effect("prefers yard.json over package.json#yard", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${dir}/package.json`,
          `{"yard":{"processes":{"web":{"command":"npm run dev","route":true}}}}`,
        );
        yield* fs.writeFileString(
          `${dir}/yard.json`,
          `{"processes":{"app":{"command":"vp run app","route":true}}}`,
        );
        const service = yield* RepoConfig;
        const config = yield* service.resolve(dir);
        expect(Object.keys(config.processes)).toEqual(["app"]);
        expect(config.processes.app?.command).toBe("vp run app");
      }).pipe(Effect.provide(testLayer)),
    ),
  );

  it.effect("uses package.json#yard when yard.json is absent", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${dir}/package.json`,
          `{"yard":{"processes":{"web":{"command":"yarn dev","route":true}}}}`,
        );
        const service = yield* RepoConfig;
        const config = yield* service.resolve(dir);
        expect(config.processes.web?.command).toBe("yarn dev");
      }).pipe(Effect.provide(testLayer)),
    ),
  );

  it.effect("detects vp defaults from vite-plus lockfile", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${dir}/package.json`, `{}`);
        yield* fs.writeFileString(`${dir}/vp-lock.yaml`, "");
        const service = yield* RepoConfig;
        const config = yield* service.resolve(dir);
        expect(config.processes.web?.command).toBe("vp run dev");
        expect(config.processes.web?.route).toBe(true);
      }).pipe(Effect.provide(testLayer)),
    ),
  );

  it.effect("detects package manager defaults from packageManager field", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${dir}/package.json`, `{"packageManager":"pnpm@9.0.0"}`);
        const service = yield* RepoConfig;
        const config = yield* service.resolve(dir);
        expect(config.processes.web?.command).toBe("pnpm run dev");
      }).pipe(Effect.provide(testLayer)),
    ),
  );

  it.effect("rejects configs without exactly one routed process", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${dir}/yard.json`,
          `{"processes":{"web":{"command":"vp run web","route":true},"docs":{"command":"vp run docs","route":true}}}`,
        );
        const service = yield* RepoConfig;
        const result = yield* Effect.exit(service.resolve(dir));
        expect(result._tag).toBe("Failure");
      }).pipe(Effect.provide(testLayer)),
    ),
  );

  it.effect("rejects routes that reference undeclared processes", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${dir}/yard.json`,
          `{"processes":{"web":{"command":"vp run dev","route":true}},"routes":{"api":{"process":"missing","portEnv":"API_PORT"}}}`,
        );
        const service = yield* RepoConfig;
        const error = yield* Effect.flip(service.resolve(dir));
        expect(error._tag).toBe("ConfigInvalid");
        expect(error.error).toBeInstanceOf(Error);
        expect((error.error as Error).message).toContain("unknown process");
      }).pipe(Effect.provide(testLayer)),
    ),
  );
});
