import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";
import { ConfigInvalid } from "../domain/errors.js";
import { Caddy } from "../services/Caddy.js";
import { Lock } from "../services/Lock.js";
import { Output } from "../services/Output.js";
import { StateStore } from "../services/StateStore.js";
import { Systemd } from "../services/Systemd.js";
import { resolveContext } from "./context.js";
import { instanceUnits, lifecycleSummary, summaryLines, waitForHttpReady } from "./up.js";

const noWait = Flag.boolean("no-wait").pipe(Flag.withDescription("Do not wait for HTTP readiness"));

const runRestart = Effect.fn("commands.restart.run")(function* (options: {
  readonly noWait: boolean;
}) {
  const context = yield* resolveContext();
  const lock = yield* Lock;
  const store = yield* StateStore;
  const systemd = yield* Systemd;
  const caddy = yield* Caddy;
  const output = yield* Output;

  const summary = yield* lock.withMutationLock(
    Effect.gen(function* () {
      const globalConfig = yield* store.loadGlobalConfig();
      const state = yield* store.loadInstances();
      const instance = state.instances[context.slug];
      if (instance === undefined) {
        return yield* new ConfigInvalid({
          path: "instances.json",
          error: new Error(`Unknown yard instance: ${context.slug}`),
        });
      }
      for (const unit of instanceUnits(context.slug, instance.processes)) {
        yield* systemd.restart(unit);
      }
      yield* caddy.syncConfig(globalConfig, {
        ...state.instances,
        [context.slug]: { instance, running: true },
      });
      const routedPort = instance.ports.web;
      if (routedPort === undefined) {
        return yield* new ConfigInvalid({
          path: "instances.json",
          error: new Error(`Instance ${context.slug} has no routed port`),
        });
      }
      const ready = options.noWait ? undefined : yield* waitForHttpReady(routedPort);
      return lifecycleSummary({
        command: "restart",
        slug: context.slug,
        globalConfig,
        instance,
        ...(ready === undefined ? {} : { ready }),
      });
    }),
  );

  yield* output.emit({ json: summary, human: summaryLines(summary) });
});

export const restartCommand = Command.make("restart", { noWait }, runRestart).pipe(
  Command.withDescription("Restart the current yard instance"),
);
