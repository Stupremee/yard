import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ConfigInvalid, FilesystemError } from "../domain/errors.ts";
import { ProcessSpec, RepoConfig as RepoConfigModel } from "../domain/model.ts";

type PackageJson = {
  readonly packageManager?: unknown;
  readonly yard?: unknown;
};

const readJson = (fs: FileSystem.FileSystem, file: string) =>
  Effect.gen(function* () {
    const text = yield* fs
      .readFileString(file)
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "read", error })),
      );
    return yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(
      Effect.mapError((error) => new ConfigInvalid({ path: file, error })),
    );
  });

const exists = (fs: FileSystem.FileSystem, file: string) =>
  fs
    .exists(file)
    .pipe(
      Effect.mapError((error) => new FilesystemError({ path: file, operation: "exists", error })),
    );

const validateRoutedProcess = (config: RepoConfigModel, source: string) =>
  Effect.gen(function* () {
    const routed = Object.entries(config.processes).filter(([, process]) => process.route === true);
    if (routed.length !== 1) {
      return yield* new ConfigInvalid({
        path: source,
        error: new Error(`Repo config must declare exactly one process with route: true`),
      });
    }
    return config;
  });

const decodeConfig = (source: string, input: unknown) =>
  Schema.decodeUnknownEffect(RepoConfigModel)(input).pipe(
    Effect.mapError((error) => new ConfigInvalid({ path: source, error })),
    Effect.flatMap((config) => validateRoutedProcess(config, source)),
  );

const detectPackageManager = (pkg: PackageJson, lockfiles: ReadonlySet<string>) => {
  if (lockfiles.has("pnpm-lock.yaml")) return "pnpm";
  if (lockfiles.has("bun.lockb") || lockfiles.has("bun.lock")) return "bun";
  if (lockfiles.has("yarn.lock")) return "yarn";
  if (lockfiles.has("package-lock.json") || lockfiles.has("npm-shrinkwrap.json")) return "npm";
  const packageManager = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  if (packageManager.startsWith("pnpm@")) return "pnpm";
  if (packageManager.startsWith("bun@")) return "bun";
  if (packageManager.startsWith("yarn@")) return "yarn";
  if (packageManager.startsWith("npm@")) return "npm";
  return "npm";
};

const detectDefaultCommand = Effect.fn("RepoConfig.detectDefaultCommand")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  pkg: PackageJson,
) {
  const names = [
    "vp-lock.yaml",
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.js",
    "vite.config.mjs",
    "pnpm-lock.yaml",
    "bun.lockb",
    "bun.lock",
    "yarn.lock",
    "package-lock.json",
    "npm-shrinkwrap.json",
  ] as const;
  const present = new Set<string>();
  for (const name of names) {
    if (yield* exists(fs, path.join(cwd, name))) {
      present.add(name);
    }
  }
  if (present.has("vp-lock.yaml")) {
    return "vp run dev";
  }
  return `${detectPackageManager(pkg, present)} run dev`;
});

export class RepoConfig extends Context.Service<
  RepoConfig,
  {
    readonly resolve: (
      cwd: string,
    ) => Effect.Effect<RepoConfigModel, ConfigInvalid | FilesystemError>;
  }
>()("yard/services/RepoConfig") {
  static readonly layer = Layer.effect(
    RepoConfig,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return {
        resolve: Effect.fn("RepoConfig.resolve")(function* (cwd: string) {
          const yardJson = path.join(cwd, "yard.json");
          if (yield* exists(fs, yardJson)) {
            return yield* decodeConfig(yardJson, yield* readJson(fs, yardJson));
          }

          const packageJson = path.join(cwd, "package.json");
          const pkg = (yield* exists(fs, packageJson))
            ? ((yield* readJson(fs, packageJson)) as PackageJson)
            : {};
          if (pkg.yard !== undefined) {
            return yield* decodeConfig(`${packageJson}#yard`, pkg.yard);
          }

          const command = yield* detectDefaultCommand(fs, path, cwd, pkg);
          return new RepoConfigModel({
            processes: { web: new ProcessSpec({ command, route: true }) },
          });
        }),
      };
    }),
  );
}
