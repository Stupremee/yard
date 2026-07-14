import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Prompt from "effect/unstable/cli/Prompt";
import * as Schema from "effect/Schema";
import {
  type DevDefinition,
  type DevScript,
  detectPackageManager,
  discoverDevScripts,
  loadPackageJson,
} from "./config.ts";

export class InitError extends Data.TaggedError("InitError")<{ readonly message: string }> {}

export type InitFlags = {
  readonly script: ReadonlyArray<string>;
  readonly target: Option.Option<"yard" | "package">;
  readonly yes: boolean;
  readonly force: boolean;
};

const isInteractive = (flags: InitFlags): boolean =>
  flags.script.length === 0 &&
  !flags.yes &&
  process.stdin.isTTY === true &&
  process.stdout.isTTY === true;

export const buildDevDefinition = (
  selected: ReadonlyArray<DevScript>,
  pm: string,
): DevDefinition => {
  if (selected.length === 1 && selected[0]!.script === "dev") {
    return `${pm} run dev`;
  }
  const rec: Record<string, string> = {};
  for (const d of selected) {
    rec[d.label] = `${pm} run ${d.script}`;
  }
  return rec;
};

const updateJsonFile = Effect.fn("dev.init.updateJsonFile")(function* (
  file: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  const RawJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
  const current = (yield* fs.exists(file))
    ? yield* Schema.decodeEffect(RawJson)(yield* fs.readFileString(file))
    : {};
  yield* fs.writeFileString(file, JSON.stringify(update(current), null, 2) + "\n");
});

export const runInit = Effect.fn("dev.init")(function* (cwd: string, flags: InitFlags) {
  return yield* Effect.gen(function* () {
    // 1. Load package.json strictly
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pkgFile = path.join(cwd, "package.json");
    if (!(yield* fs.exists(pkgFile))) {
      return yield* new InitError({ message: `No package.json found in ${cwd}` });
    }
    const pkg = yield* loadPackageJson(cwd).pipe(
      Effect.catchAll((err) =>
        Effect.fail(
          new InitError({
            message: `Failed to parse package.json: ${err instanceof Error ? err.message : String(err)}`,
          }),
        ),
      ),
    );

    // 2. Discover
    const discovered = discoverDevScripts(pkg.scripts);
    if (discovered.length === 0) {
      return yield* new InitError({
        message: 'No "dev" or "dev:*" scripts found in package.json.',
      });
    }

    // 3. PM
    const pm = yield* detectPackageManager(cwd);

    // 4. Selection
    let selected: ReadonlyArray<DevScript>;
    if (flags.script.length > 0) {
      const byScript = new Map(discovered.map((d) => [d.script, d] as const));
      const chosen: DevScript[] = [];
      for (const s of flags.script) {
        const d = byScript.get(s);
        if (!d) {
          const avail = discovered.map((d) => d.script).join(", ");
          return yield* new InitError({
            message: `Unknown script "${s}". Available: ${avail || "(none)"}`,
          });
        }
        chosen.push(d);
      }
      selected = chosen;
    } else if (flags.yes) {
      selected = discovered;
    } else if (isInteractive(flags)) {
      const scriptChoices = yield* Prompt.multiSelect({
        message: "Select dev scripts to run in parallel",
        choices: discovered.map((d) => ({
          title: d.script,
          value: d.script,
          description: d.body,
          selected: true,
        })),
        min: 1,
      });
      const byScript = new Map(discovered.map((d) => [d.script, d] as const));
      selected = scriptChoices.map((s) => byScript.get(s)!);
    } else {
      const avail = discovered.map((d) => d.script).join(", ");
      return yield* new InitError({
        message: `No dev scripts selected and not running interactively. Available: ${avail}. Example: yard init --yes`,
      });
    }

    // 5. Target
    let targetChoice: "yard" | "package";
    if (Option.isSome(flags.target)) {
      targetChoice = flags.target.value;
    } else if (isInteractive(flags)) {
      targetChoice = yield* Prompt.select({
        message: "Where to write the config?",
        choices: [
          { title: "yard.json", value: "yard" as const },
          { title: 'package.json "yard" key', value: "package" as const },
        ],
      });
    } else {
      targetChoice = "yard";
    }

    // 6. Conflict checks
    const yardFile = path.join(cwd, "yard.json");
    const hasYardJson = yield* fs.exists(yardFile);
    if (targetChoice === "package" && hasYardJson) {
      return yield* new InitError({
        message:
          "Cannot target package.json while yard.json exists (yard.json takes precedence). Remove yard.json or target yard.json.",
      });
    }

    const hasExistingConfig = targetChoice === "yard" ? hasYardJson : pkg.yard !== undefined;

    if (hasExistingConfig) {
      if (!flags.force) {
        if (isInteractive(flags)) {
          const confirmed = yield* Prompt.confirm({
            message: `Overwrite existing ${targetChoice === "yard" ? "yard.json" : 'package.json "yard"'} config?`,
            initial: false,
          });
          if (!confirmed) {
            yield* Console.log("Aborted.");
            return;
          }
        } else {
          return yield* new InitError({
            message: "Existing yard configuration found. Rerun with --force to overwrite.",
          });
        }
      }
    }

    // 7. Build
    const dev = buildDevDefinition(selected, pm);

    // 8. Write
    if (targetChoice === "package") {
      yield* updateJsonFile(pkgFile, (o) => ({ ...o, yard: { dev } }));
    } else {
      yield* updateJsonFile(yardFile, (o) => ({ ...o, dev }));
    }

    // 9. Summary
    const labels = selected.map((s) => s.label).join(", ");
    const wrote = targetChoice === "yard" ? "yard.json" : 'package.json "yard"';
    yield* Console.log(`Wrote ${wrote} (dev: ${labels}).`);
  }).pipe(Effect.catchTag("QuitError", () => Console.log("Aborted.")));
});
