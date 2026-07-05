import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ConfigInvalid, FilesystemError } from "../domain/errors.ts";
import { emptyInstancesFile, GlobalConfig, InstancesFile } from "../domain/model.ts";
import { Xdg } from "./Xdg.ts";

const readInstances = (fs: FileSystem.FileSystem, file: string) =>
  Effect.gen(function* () {
    const exists = yield* fs
      .exists(file)
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "exists", error })),
      );
    if (!exists) {
      return emptyInstancesFile();
    }
    const text = yield* fs
      .readFileString(file)
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "read", error })),
      );
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InstancesFile))(text).pipe(
      Effect.mapError((error) => new ConfigInvalid({ path: file, error })),
    );
  });

const readGlobalConfig = (fs: FileSystem.FileSystem, file: string) =>
  Effect.gen(function* () {
    const exists = yield* fs
      .exists(file)
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "exists", error })),
      );
    if (!exists) {
      return yield* new ConfigInvalid({ path: file, error: new Error("Missing global config") });
    }
    const text = yield* fs
      .readFileString(file)
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "read", error })),
      );
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GlobalConfig))(text).pipe(
      Effect.mapError((error) => new ConfigInvalid({ path: file, error })),
    );
  });

const atomicWrite = <S extends Schema.Constraint>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  schema: S,
  file: string,
  value: S["Type"],
  mode?: number,
) =>
  Effect.gen(function* () {
    const millis = yield* Clock.currentTimeMillis;
    const tmp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${millis}.tmp`,
    );
    const json = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(schema))(value).pipe(
      Effect.mapError((error) => new ConfigInvalid({ path: file, error })),
    );
    yield* fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "mkdir", error })),
      );
    yield* fs
      .writeFileString(tmp, `${json}\n`, mode === undefined ? undefined : { mode })
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "write", error })),
      );
    if (mode !== undefined) {
      yield* fs
        .chmod(tmp, mode)
        .pipe(
          Effect.mapError(
            (error) => new FilesystemError({ path: file, operation: "chmod", error }),
          ),
        );
    }
    yield* fs
      .rename(tmp, file)
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "rename", error })),
      );
  });

export class StateStore extends Context.Service<
  StateStore,
  {
    readonly loadInstances: () => Effect.Effect<InstancesFile, ConfigInvalid | FilesystemError>;
    readonly saveInstances: (
      state: InstancesFile,
    ) => Effect.Effect<void, ConfigInvalid | FilesystemError>;
    readonly loadGlobalConfig: () => Effect.Effect<GlobalConfig, ConfigInvalid | FilesystemError>;
    readonly saveGlobalConfig: (
      config: GlobalConfig,
    ) => Effect.Effect<void, ConfigInvalid | FilesystemError>;
  }
>()("yard/services/StateStore") {
  static readonly layer = Layer.effect(
    StateStore,
    Effect.gen(function* () {
      const xdg = yield* Xdg;
      const paths = yield* xdg.paths();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return {
        loadInstances: Effect.fn("StateStore.loadInstances")(function* () {
          return yield* readInstances(fs, paths.instancesFile);
        }),
        saveInstances: Effect.fn("StateStore.saveInstances")(function* (state: InstancesFile) {
          yield* atomicWrite(fs, path, InstancesFile, paths.instancesFile, state);
        }),
        loadGlobalConfig: Effect.fn("StateStore.loadGlobalConfig")(function* () {
          return yield* readGlobalConfig(fs, paths.configFile);
        }),
        saveGlobalConfig: Effect.fn("StateStore.saveGlobalConfig")(function* (
          config: GlobalConfig,
        ) {
          yield* atomicWrite(fs, path, GlobalConfig, paths.configFile, config, 0o600);
        }),
      };
    }),
  );
}
