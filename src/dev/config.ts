import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export type DevTask = { readonly label: string; readonly command: string };
export type DevDefinition = string | Readonly<Record<string, string>>;
type PackageJson = { readonly name?: unknown; readonly scripts?: unknown; readonly yard?: unknown };

export class NoDevTasksError extends Data.TaggedError("NoDevTasksError")<{
  readonly message: string;
}> {}

const readJson = Effect.fn("dev.readJson")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Schema.decodeEffect(Schema.UnknownFromJsonString)(yield* fs.readFileString(file));
});

const packageJson = Effect.fn("dev.packageJson")(function* (cwd: string) {
  const path = yield* Path.Path;
  return yield* readJson(path.join(cwd, "package.json")).pipe(
    Effect.map((value): PackageJson => (typeof value === "object" && value !== null ? value : {})),
    Effect.orElseSucceed((): PackageJson => ({})),
  );
});

const isDevDefinition = (value: unknown): value is DevDefinition =>
  typeof value === "string" ||
  (typeof value === "object" &&
    value !== null &&
    Object.values(value).every((command) => typeof command === "string"));

export const commandLabel = (command: string): string => {
  const words = command.trim().split(/\s+/);
  if (words.length >= 3 && words[1] === "run") return words[2] ?? words[0] ?? "dev";
  if (words.length >= 2 && ["npm", "pnpm", "yarn", "bun"].includes(words[0] ?? ""))
    return words[1] ?? "dev";
  return words[0] || "dev";
};

export const detectPackageManager = Effect.fn("dev.detectPackageManager")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pkg = yield* packageJson(cwd);
  const yardPath = path.join(cwd, "yard.json");
  const config = yield* fs.exists(yardPath)
    ? readJson(yardPath).pipe(Effect.orElseSucceed(() => pkg.yard))
    : Effect.succeed(pkg.yard);
  if (
    typeof config === "object" &&
    config !== null &&
    "name" in config &&
    typeof config.name === "string"
  )
    return config.name;
  return typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : path.basename(cwd);
});

export const resolveDevTasks = Effect.fn("dev.resolveDevTasks")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pkg = yield* packageJson(cwd);
  const configPath = path.join(cwd, "yard.json");
  const config = (yield* fs.exists(configPath)) ? yield* readJson(configPath) : pkg.yard;
  if (
    typeof config === "object" &&
    config !== null &&
    "dev" in config &&
    isDevDefinition(config.dev)
  )
    return typeof config.dev === "string"
      ? [{ label: commandLabel(config.dev), command: config.dev }]
      : Object.entries(config.dev).map(([label, command]) => ({ label, command }));
  if (
    typeof pkg.scripts === "object" &&
    pkg.scripts !== null &&
    "dev" in pkg.scripts &&
    typeof pkg.scripts.dev === "string"
  )
    return [{ label: "dev", command: `${yield* detectPackageManager(cwd)} run dev` }];
  return yield* new NoDevTasksError({
    message:
      "No dev tasks found. Add a dev entry to yard.json, a yard.dev field to package.json, or a package.json dev script.",
  });
});
