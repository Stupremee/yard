import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export type DevTask = { readonly label: string; readonly command: string };
export const DevDefinition = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.String),
]);
export type DevDefinition = typeof DevDefinition.Type;

export const YardConfig = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  dev: Schema.optionalKey(DevDefinition),
});
export type YardConfig = typeof YardConfig.Type;

export const PackageJson = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  yard: Schema.optionalKey(Schema.Unknown),
});
export type PackageJson = typeof PackageJson.Type;

export class NoDevTasksError extends Data.TaggedError("NoDevTasksError")<{
  readonly message: string;
}> {}

const readJsonFile = Effect.fn("dev.readJsonFile")(function* <S extends Schema.Top>(
  file: string,
  schema: S,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(yield* fs.readFileString(file));
});

export const loadPackageJson = Effect.fn("dev.loadPackageJson")(function* (cwd: string) {
  const path = yield* Path.Path;
  return yield* readJsonFile(path.join(cwd, "package.json"), PackageJson);
});

const packageJson = Effect.fn("dev.packageJson")(function* (cwd: string) {
  return yield* loadPackageJson(cwd).pipe(Effect.orElseSucceed((): PackageJson => ({})));
});

const yardConfig = Effect.fn("dev.yardConfig")(function* (cwd: string, pkg: PackageJson) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(cwd, "yard.json");
  if (yield* fs.exists(file)) return yield* readJsonFile(file, YardConfig);
  return yield* Schema.decodeUnknownEffect(YardConfig)(pkg.yard).pipe(
    Effect.orElseSucceed((): YardConfig => ({})),
  );
});

export const commandLabel = (command: string): string => {
  const words = command.trim().split(/\s+/);
  if (words.length >= 3 && words[1] === "run") return words[2] ?? words[0] ?? "dev";
  if (words.length >= 2 && ["npm", "pnpm", "yarn", "bun", "vp"].includes(words[0] ?? ""))
    return words[1] ?? "dev";
  return words[0] || "dev";
};

export type DevScript = { readonly script: string; readonly label: string; readonly body: string };

export const discoverDevScripts = (
  scripts: Record<string, string> | undefined,
): Array<DevScript> => {
  if (!scripts) return [];
  const result: DevScript[] = [];
  if (scripts.dev !== undefined) {
    result.push({ script: "dev", label: "dev", body: scripts.dev });
  }
  for (const [key, body] of Object.entries(scripts)) {
    if (key === "dev") continue;
    if (key.startsWith("dev:")) {
      const label = key === "dev:dev" ? key : key.slice(4);
      result.push({ script: key, label, body });
    }
  }
  return result;
};

export const detectPackageManager = Effect.fn("dev.detectPackageManager")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pkg = yield* packageJson(cwd);
  // Vite+ projects keep the underlying package manager's lockfile, so vp must win over lockfile detection.
  if (
    pkg.dependencies?.["vite-plus"] !== undefined ||
    pkg.devDependencies?.["vite-plus"] !== undefined
  )
    return "vp";
  if (yield* fs.exists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (yield* fs.exists(path.join(cwd, "bun.lock"))) return "bun";
  if (yield* fs.exists(path.join(cwd, "bun.lockb"))) return "bun";
  if (yield* fs.exists(path.join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
});

export const resolveStackName = Effect.fn("dev.resolveStackName")(function* (
  cwd: string,
  override?: string,
) {
  if (override) return override;
  const path = yield* Path.Path;
  const pkg = yield* packageJson(cwd);
  const config = yield* yardConfig(cwd, pkg).pipe(Effect.orElseSucceed((): YardConfig => ({})));
  return config.name ?? (pkg.name ? pkg.name : path.basename(cwd));
});

export const resolveDevTasks = Effect.fn("dev.resolveDevTasks")(function* (cwd: string) {
  const pkg = yield* packageJson(cwd);
  const config = yield* yardConfig(cwd, pkg);
  if (config.dev !== undefined) {
    const dev = config.dev;
    return typeof dev === "string"
      ? [{ label: commandLabel(dev), command: dev }]
      : Object.entries(dev).map(([label, command]) => ({ label, command }));
  }
  if (pkg.scripts?.dev !== undefined)
    return [{ label: "dev", command: `${yield* detectPackageManager(cwd)} run dev` }];
  return yield* new NoDevTasksError({
    message:
      "No dev tasks found. Add a dev entry to yard.json, a yard.dev field to package.json, or a package.json dev script.",
  });
});
