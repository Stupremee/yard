import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { InstanceNotFound } from "../domain/errors.ts";
import { Caddy } from "../services/Caddy.ts";
import { Lock } from "../services/Lock.ts";
import { Output } from "../services/Output.ts";
import { StateStore } from "../services/StateStore.ts";
import { Systemd } from "../services/Systemd.ts";
import { resolveContext } from "./context.ts";
import { deriveCaddyInstances, instanceUnits, lifecycleSummary, summaryLines } from "./up.ts";

const runDown = Effect.fn("commands.down.run")(function* () {
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
        return yield* new InstanceNotFound({ slug: context.slug });
      }
      for (const unit of instanceUnits(context.slug, instance.processes)) {
        yield* systemd.stop(unit);
      }
      yield* caddy.syncConfig(
        globalConfig,
        yield* deriveCaddyInstances(state.instances, {
          [context.slug]: { instance, running: false },
        }),
      );
      return lifecycleSummary({ command: "down", slug: context.slug, globalConfig, instance });
    }),
  );

  yield* output.emit({ json: summary, human: summaryLines(summary) });
});

export const downCommand = Command.make("down", {}, runDown).pipe(
  Command.withDescription("Stop the current yard instance but keep its routes"),
);
