import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import pkg from "../package.json" with { type: "json" };
import { caddyCommand, tunnelCommand } from "./commands/daemon.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { downCommand } from "./commands/down.ts";
import { envCommand } from "./commands/env.ts";
import { initCommand } from "./commands/init.ts";
import { listCommand } from "./commands/list.ts";
import { logsCommand } from "./commands/logs.ts";
import { printViteConfigCommand } from "./commands/printViteConfig.ts";
import { restartCommand } from "./commands/restart.ts";
import { rmCommand } from "./commands/rm.ts";
import { statusCommand } from "./commands/status.ts";
import { upCommand } from "./commands/up.ts";
import { urlCommand } from "./commands/url.ts";
import { Binaries } from "./services/Binaries.ts";
import { Caddy } from "./services/Caddy.ts";
import { EnvLinker } from "./services/EnvLinker.ts";
import { Git } from "./services/Git.ts";
import { Lock } from "./services/Lock.ts";
import { Output } from "./services/Output.ts";
import { Ports } from "./services/Ports.ts";
import { RepoConfig } from "./services/RepoConfig.ts";
import { StateStore } from "./services/StateStore.ts";
import { Systemd } from "./services/Systemd.ts";
import { Tunnel } from "./services/Tunnel.ts";
import { Xdg } from "./services/Xdg.ts";

const json = Flag.boolean("json").pipe(Flag.withDescription("Print machine-readable JSON output"));

const stateStoreLayer = StateStore.layer.pipe(Layer.provide(Xdg.layer));
const lockLayer = Lock.layer.pipe(Layer.provide(Xdg.layer));
const systemdLayer = Systemd.layer.pipe(Layer.provide(Xdg.layer));
const caddyLayer = Caddy.layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Xdg.layer));
const binariesLayer = Binaries.layer.pipe(Layer.provide(Layer.merge(Xdg.layer, stateStoreLayer)));
const portsLayer = Ports.layer.pipe(Layer.provide(stateStoreLayer));
const tunnelLayer = Tunnel.layer.pipe(
  Layer.provide(Layer.merge(Xdg.layer, Layer.merge(stateStoreLayer, binariesLayer))),
);

const stateBackedLayer = Layer.merge(
  stateStoreLayer,
  Layer.merge(
    lockLayer,
    Layer.merge(
      systemdLayer,
      Layer.merge(caddyLayer, Layer.merge(binariesLayer, Layer.merge(portsLayer, tunnelLayer))),
    ),
  ),
);

const appLayer = Layer.merge(
  Xdg.layer,
  Layer.merge(
    Git.layer,
    Layer.merge(RepoConfig.layer, Layer.merge(EnvLinker.layer, stateBackedLayer)),
  ),
);

const outputLayer = Output.layer(process.argv.includes("--json"));
export const completeAppLayer = Layer.merge(
  outputLayer,
  Layer.merge(FetchHttpClient.layer, appLayer),
);

const provideWith = <CommandValue, LayerOut, LayerError, LayerIn>(
  command: CommandValue,
  layer: Layer.Layer<LayerOut, LayerError, LayerIn>,
): CommandValue => (command as { pipe: (f: unknown) => CommandValue }).pipe(Command.provide(layer));

const root = Command.make("yard").pipe(
  Command.withSharedFlags({ json }),
  Command.withDescription("Manage AI-assisted development environments"),
  Command.withSubcommands([
    provideWith(upCommand, completeAppLayer),
    provideWith(downCommand, completeAppLayer),
    provideWith(restartCommand, completeAppLayer),
    provideWith(rmCommand, completeAppLayer),
    provideWith(statusCommand, completeAppLayer),
    provideWith(listCommand, completeAppLayer),
    provideWith(logsCommand, completeAppLayer),
    provideWith(urlCommand, completeAppLayer),
    provideWith(envCommand, completeAppLayer),
    provideWith(initCommand, completeAppLayer),
    provideWith(doctorCommand, completeAppLayer),
    provideWith(caddyCommand, completeAppLayer),
    provideWith(tunnelCommand, completeAppLayer),
    provideWith(printViteConfigCommand, outputLayer),
  ]),
);

const providedRoot = root.pipe(Command.provide(completeAppLayer));
const runtimeLayer = Layer.merge(FetchHttpClient.layer, NodeServices.layer);

const serializeCause = (value: unknown): unknown => {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === "object" && value !== null && "_tag" in value) {
    return errorPayload(value);
  }
  return value;
};

const errorPayload = (error: unknown) => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const record = error as Record<string, unknown>;
    const fields = Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== "_tag")
        .map(([key, value]) => [key === "error" ? "cause" : key, serializeCause(value)]),
    );
    return { ...fields, error: String(record._tag) };
  }
  if (error instanceof Error) {
    return { error: error.name, message: error.message };
  }
  return { error: "Error", message: String(error) };
};

const nestedMessage = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const record = error as Record<string, unknown>;
    if (record._tag === "InstanceNotFound") {
      return `Unknown yard instance: ${String(record.slug)}`;
    }
    if (record._tag === "ConfigInvalid") {
      return `Invalid config ${String(record.path)}: ${nestedMessage(record.error)}`;
    }
    if (record._tag === "ProcessFailed") {
      return `${String(record.command)} failed with exit ${String(record.exitCode)}: ${String(record.stderr).trim()}`;
    }
    if (record._tag === "NotAGitRepo") {
      const detail = record.message === undefined ? "" : ` (${String(record.message)})`;
      return `Not a git repository: ${String(record.cwd)}${detail}`;
    }
    if (record._tag === "NoFreePort") {
      return `No free ports available in range ${String(record.from)}-${String(record.to)}`;
    }
    if (record._tag === "StateLocked") {
      const holder = record.pid === undefined ? "" : ` held by pid ${String(record.pid)}`;
      return `Another yard command is running (lock ${String(record.path)}${holder}); try again shortly`;
    }
    if (record._tag === "CaddyUnreachable") {
      return `Caddy admin API unreachable at ${String(record.url)}: ${nestedMessage(record.error)} (is yard-caddy.service running? try \`yard caddy start\`)`;
    }
    if (record._tag === "TunnelNotConfigured") {
      return `Cloudflare tunnel not configured: ${String(record.message)} (run \`yard init --zone <zone>\`)`;
    }
    if (record._tag === "BinaryUnavailable") {
      const url = record.url === undefined ? "" : ` (${String(record.url)})`;
      return `Binary unavailable for ${String(record.name)}${url}: ${String(record.message)}`;
    }
    if (record._tag === "NoInstanceForWorktree") {
      return `No yard instance for this worktree: ${String(record.worktreeRoot)} (run \`yard up\`)`;
    }
    if (record._tag === "FilesystemError") {
      return `Filesystem error during ${String(record.operation)} at ${String(record.path)}: ${nestedMessage(record.error)}`;
    }
    if (record._tag === "WordlistExhausted") {
      return "No free worktree word left in the wordlist; remove unused instances with `yard rm`";
    }
    const fields = Object.entries(record)
      .filter(([key]) => key !== "_tag")
      .map(([key, value]) => `${key}=${nestedMessage(value)}`)
      .join(", ");
    return fields.length === 0 ? String(record._tag) : `${String(record._tag)}: ${fields}`;
  }
  return error instanceof Error ? error.message : String(error);
};

const renderFailure = (jsonMode: boolean, error: unknown) =>
  Effect.sync(() => {
    const text = jsonMode
      ? // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify(errorPayload(error), null, 2)
      : errorMessage(error);
    process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
  });

const main = Command.run(providedRoot, { version: pkg.version }).pipe(Effect.provide(runtimeLayer));

export const runCli = () =>
  main.pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      const jsonMode = process.argv.includes("--json");
      return renderFailure(jsonMode, error).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      );
    }),
    NodeRuntime.runMain,
  );

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
