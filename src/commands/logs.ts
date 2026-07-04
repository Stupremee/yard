import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import { appUnitName } from "../services/Systemd.js";
import { Systemd } from "../services/Systemd.js";
import { lookupInstance, resolveContext } from "./context.js";

export const selectLogProcess = (
  processes: ReadonlyArray<string>,
  ports: Readonly<Record<string, number>>,
  requested?: string,
): string => {
  if (requested !== undefined) return requested;
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
    const processName = selectLogProcess(
      instance.processes,
      instance.ports,
      Option.getOrUndefined(requestedProcess),
    );
    const unit = appUnitName(context.slug, processName);
    if (follow) {
      yield* systemd.journalFollow({ unit, lines }, (chunk) =>
        Effect.sync(() => {
          process.stdout.write(chunk);
        }),
      );
      return;
    }
    const result = yield* systemd.journal({ unit, lines });
    yield* Effect.sync(() => {
      if (result.stdout.length > 0) process.stdout.write(result.stdout);
      if (result.stderr.length > 0) process.stderr.write(result.stderr);
    });
  }),
).pipe(Command.withDescription("Show journald logs for a yard app process"));
