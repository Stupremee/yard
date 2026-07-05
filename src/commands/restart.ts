import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";
import { ConfigInvalid, InstanceNotFound } from "../domain/errors.ts";
import { Caddy } from "../services/Caddy.ts";
import { Lock } from "../services/Lock.ts";
import { Output } from "../services/Output.ts";
import { StateStore } from "../services/StateStore.ts";
import { Systemd } from "../services/Systemd.ts";
import { resolveContext } from "./context.ts";
import {
  deriveCaddyInstances,
  instanceUnits,
  lifecycleSummary,
  summaryLines,
  waitForHttpReady,
} from "./up.ts";

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

  const result = yield* lock.withMutationLock(
    Effect.gen(function* () {
      const globalConfig = yield* store.loadGlobalConfig();
      const state = yield* store.loadInstances();
      const instance = state.instances[context.slug];
      if (instance === undefined) {
        return yield* new InstanceNotFound({ slug: context.slug });
      }
      for (const unit of instanceUnits(context.slug, instance.processes)) {
        yield* systemd.restart(unit);
      }
      yield* caddy.syncConfig(
        globalConfig,
        yield* deriveCaddyInstances(state.instances, {
          [context.slug]: { instance, running: true },
        }),
      );
      const routedPort = instance.ports[instance.routedProcess];
      if (routedPort === undefined) {
        return yield* new ConfigInvalid({
          path: "instances.json",
          error: new Error(`Instance ${context.slug} has no routed port`),
        });
      }
      return { globalConfig, instance, routedPort };
    }),
  );

  // Readiness polling happens outside the mutation lock (see `up`).
  const ready = options.noWait ? undefined : yield* waitForHttpReady(result.routedPort);
  const summary = lifecycleSummary({
    command: "restart",
    slug: context.slug,
    globalConfig: result.globalConfig,
    instance: result.instance,
    ...(ready === undefined ? {} : { ready }),
  });

  yield* output.emit({ json: summary, human: summaryLines(summary) });
});

export const restartCommand = Command.make("restart", { noWait }, runRestart).pipe(
  Command.withDescription("Restart the current yard instance"),
);
