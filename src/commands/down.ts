import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { InstanceNotFound } from "../domain/errors.js";
import { Caddy } from "../services/Caddy.js";
import { Lock } from "../services/Lock.js";
import { Output } from "../services/Output.js";
import { StateStore } from "../services/StateStore.js";
import { Systemd } from "../services/Systemd.js";
import { resolveContext } from "./context.js";
import { instanceUnits, lifecycleSummary, summaryLines } from "./up.js";

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
      yield* caddy.syncConfig(globalConfig, {
        ...state.instances,
        [context.slug]: { instance, running: false },
      });
      return lifecycleSummary({ command: "down", slug: context.slug, globalConfig, instance });
    }),
  );

  yield* output.emit({ json: summary, human: summaryLines(summary) });
});

export const downCommand = Command.make("down", {}, runDown).pipe(
  Command.withDescription("Stop the current yard instance but keep its routes"),
);
