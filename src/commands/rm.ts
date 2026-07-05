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

const runRm = Effect.fn("commands.rm.run")(function* () {
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
        yield* systemd.stop(unit).pipe(Effect.orElseSucceed(() => undefined));
        yield* systemd.disable(unit).pipe(Effect.orElseSucceed(() => undefined));
        yield* systemd.resetFailed(unit).pipe(Effect.orElseSucceed(() => undefined));
      }
      yield* systemd.removeAppDropins(context.slug, instance.processes);
      yield* systemd.daemonReload();
      const { [context.slug]: _removed, ...remaining } = state.instances;
      yield* caddy.syncConfig(globalConfig, yield* deriveCaddyInstances(remaining));
      yield* store.saveInstances({ ...state, instances: remaining });
      return lifecycleSummary({ command: "rm", slug: context.slug, globalConfig, instance });
    }),
  );

  yield* output.emit({ json: summary, human: summaryLines(summary) });
});

export const rmCommand = Command.make("rm", {}, runRm).pipe(
  Command.withDescription("Remove yard resources for the current instance"),
);
