import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import pkg from "../package.json" with { type: "json" };
import { caddyCommand, tunnelCommand } from "./commands/daemon.js";
import { doctorCommand } from "./commands/doctor.js";
import { downCommand } from "./commands/down.js";
import { envCommand } from "./commands/env.js";
import { initCommand } from "./commands/init.js";
import { listCommand } from "./commands/list.js";
import { logsCommand } from "./commands/logs.js";
import { printViteConfigCommand } from "./commands/printViteConfig.js";
import { restartCommand } from "./commands/restart.js";
import { rmCommand } from "./commands/rm.js";
import { statusCommand } from "./commands/status.js";
import { upCommand } from "./commands/up.js";
import { urlCommand } from "./commands/url.js";
import { Binaries } from "./services/Binaries.js";
import { Caddy } from "./services/Caddy.js";
import { EnvLinker } from "./services/EnvLinker.js";
import { Git } from "./services/Git.js";
import { Lock } from "./services/Lock.js";
import { Output } from "./services/Output.js";
import { Ports } from "./services/Ports.js";
import { RepoConfig } from "./services/RepoConfig.js";
import { StateStore } from "./services/StateStore.js";
import { Systemd } from "./services/Systemd.js";
import { Tunnel } from "./services/Tunnel.js";
import { Xdg } from "./services/Xdg.js";

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
  Git.layer,
  Layer.merge(RepoConfig.layer, Layer.merge(EnvLinker.layer, stateBackedLayer)),
);

const outputLayer = Output.layer(process.argv.includes("--json"));
const completeAppLayer = Layer.merge(outputLayer, Layer.merge(FetchHttpClient.layer, appLayer));

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

const errorPayload = (error: unknown) => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const record = error as Record<string, unknown>;
    return {
      error: String(record._tag),
      ...Object.fromEntries(Object.entries(record).filter(([key]) => key !== "_tag")),
    };
  }
  if (error instanceof Error) {
    return { error: error.name, message: error.message };
  }
  return { error: "Error", message: String(error) };
};

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const record = error as Record<string, unknown>;
    if (record._tag === "InstanceNotFound") {
      return `Unknown yard instance: ${String(record.slug)}`;
    }
    if (record._tag === "ConfigInvalid") {
      const nested = record.error instanceof Error ? record.error.message : String(record.error);
      return `Invalid config ${String(record.path)}: ${nested}`;
    }
    if (record._tag === "ProcessFailed") {
      return `${String(record.command)} failed with exit ${String(record.exitCode)}: ${String(record.stderr).trim()}`;
    }
    return String(record._tag);
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
