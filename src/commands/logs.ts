import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import { ConfigInvalid } from "../domain/errors.ts";
import { Output } from "../services/Output.ts";
import { appUnitName } from "../services/Systemd.ts";
import { Systemd } from "../services/Systemd.ts";
import { lookupInstance, resolveContext } from "./context.ts";

export const selectLogProcess = (
  processes: ReadonlyArray<string>,
  ports: Readonly<Record<string, number>>,
  requested?: string,
): string | ConfigInvalid => {
  if (requested !== undefined) {
    return processes.includes(requested)
      ? requested
      : new ConfigInvalid({
          path: "--process",
          error: new Error(`Unknown process ${requested}; available: ${processes.join(", ")}`),
        });
  }
  if (processes.length === 1 && processes[0] !== undefined) return processes[0];
  if (processes.includes("web")) return "web";
  const routed = Object.keys(ports).find((name) => processes.includes(name));
  return routed ?? processes[0] ?? "web";
};

export const logsCommand = Command.make(
  "logs",
  {
    follow: Flag.boolean("follow").pipe(Flag.withAlias("f")),
    lines: Flag.integer("lines").pipe(Flag.withAlias("n"), Flag.withDefault(100)),
    process: Flag.string("process").pipe(Flag.optional),
  },
  Effect.fn("commands.logs")(function* ({ follow, lines, process: requestedProcess }) {
    const context = yield* resolveContext();
    const instance = yield* lookupInstance(context.slug);
    const systemd = yield* Systemd;
    const output = yield* Output;
    const processName = selectLogProcess(
      instance.processes,
      instance.ports,
      Option.getOrUndefined(requestedProcess),
    );
    if (typeof processName !== "string") {
      return yield* processName;
    }
    const unit = appUnitName(context.slug, processName);
    const isJson = yield* output.isJson();
    if (follow) {
      if (isJson) {
        yield* output.emit({
          json: { slug: context.slug, process: processName, unit, follow: true, lines },
          human: "",
        });
      }
      yield* systemd.journalFollow({ unit, lines }, (chunk) =>
        Effect.sync(() => {
          process.stdout.write(chunk);
        }),
      );
      return;
    }
    const result = yield* systemd.journal({ unit, lines });
    yield* output.emit({
      json: {
        slug: context.slug,
        process: processName,
        unit,
        follow: false,
        lines,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
      human: result.stdout.length > 0 ? result.stdout : result.stderr,
    });
  }),
).pipe(Command.withDescription("Show journald logs for a yard app process"));
