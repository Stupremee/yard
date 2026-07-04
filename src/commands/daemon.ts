import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";
import { Output } from "../services/Output.js";
import { Systemd } from "../services/Systemd.js";

type DaemonName = "caddy" | "tunnel";

const unitFor = (daemon: DaemonName) => `yard-${daemon}.service`;

const daemonAction = (daemon: DaemonName, action: "start" | "stop" | "status") =>
  Effect.gen(function* () {
    const output = yield* Output;
    const systemd = yield* Systemd;
    const unit = unitFor(daemon);
    if (action === "start") {
      yield* systemd.start(unit);
      yield* output.emit({ json: { unit, action, ok: true }, human: `${unit} started` });
      return;
    }
    if (action === "stop") {
      yield* systemd.stop(unit);
      yield* output.emit({ json: { unit, action, ok: true }, human: `${unit} stopped` });
      return;
    }
    const active = yield* systemd.isActive(unit);
    const detail = yield* systemd.show(unit).pipe(Effect.orElseSucceed(() => ({})));
    yield* output.emit({
      json: { unit, active, detail },
      human: `${unit} ${active ? "active" : "inactive"}`,
    });
    if (!active) {
      yield* Effect.sync(() => {
        process.exitCode = 1;
      });
    }
  });

const daemonLogs = (
  daemon: DaemonName,
  options: { readonly follow: boolean; readonly lines: number },
) =>
  Effect.gen(function* () {
    const output = yield* Output;
    const systemd = yield* Systemd;
    const unit = unitFor(daemon);
    const isJson = yield* output.isJson();
    if (options.follow) {
      if (isJson) {
        yield* output.emit({ json: { unit, follow: true }, human: "" });
      }
      yield* systemd.journalFollow({ unit, lines: options.lines }, (chunk) =>
        Effect.sync(() => {
          process.stdout.write(chunk);
        }),
      );
      return;
    }
    const result = yield* systemd.journal({ unit, lines: options.lines });
    yield* output.emit({
      json: { unit, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      human: result.stdout.length > 0 ? result.stdout : result.stderr,
    });
  });

const makeDaemonGroup = (daemon: DaemonName) => {
  const start = Command.make("start", {}, () => daemonAction(daemon, "start"));
  const stop = Command.make("stop", {}, () => daemonAction(daemon, "stop"));
  const status = Command.make("status", {}, () => daemonAction(daemon, "status"));
  const logs = Command.make(
    "logs",
    {
      follow: Flag.boolean("follow").pipe(Flag.withAlias("f")),
      lines: Flag.integer("lines").pipe(Flag.withAlias("n"), Flag.withDefault(100)),
    },
    daemonLogs.bind(null, daemon),
  );
  return Command.make(daemon).pipe(Command.withSubcommands([start, stop, status, logs]));
};

export const caddyCommand = makeDaemonGroup("caddy").pipe(
  Command.withDescription("Manage the yard Caddy user service"),
);

export const tunnelCommand = makeDaemonGroup("tunnel").pipe(
  Command.withDescription("Manage the yard cloudflared user service"),
);
