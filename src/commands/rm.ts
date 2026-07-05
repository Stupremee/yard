import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command } from "effect/unstable/cli";
import { InstanceNotFound } from "../domain/errors.ts";
import { Caddy } from "../services/Caddy.ts";
import { Lock } from "../services/Lock.ts";
import { Output } from "../services/Output.ts";
import { StateStore } from "../services/StateStore.ts";
import { Systemd } from "../services/Systemd.ts";
import { resolveContext } from "./context.ts";
import { deriveCaddyInstances, instanceUnits, lifecycleSummary, summaryLines } from "./up.ts";

const resolveSlug = Effect.fn("commands.rm.resolveSlug")(function* (
  slugArg: Option.Option<string>,
) {
  if (Option.isSome(slugArg)) return slugArg.value;
  return (yield* resolveContext()).slug;
});

const runRm = Effect.fn("commands.rm.run")(function* (options: {
  readonly slug: Option.Option<string>;
}) {
  const lock = yield* Lock;
  const store = yield* StateStore;
  const systemd = yield* Systemd;
  const caddy = yield* Caddy;
  const output = yield* Output;

  const summary = yield* lock.withMutationLock(
    Effect.gen(function* () {
      const globalConfig = yield* store.loadGlobalConfig();
      const state = yield* store.loadInstances();
      const slug = yield* resolveSlug(options.slug);
      const instance = state.instances[slug];
      if (instance === undefined) {
        return yield* new InstanceNotFound({ slug });
      }
      for (const unit of instanceUnits(slug, instance.processes)) {
        yield* systemd.stop(unit).pipe(Effect.orElseSucceed(() => undefined));
        yield* systemd.disable(unit).pipe(Effect.orElseSucceed(() => undefined));
        yield* systemd.resetFailed(unit).pipe(Effect.orElseSucceed(() => undefined));
      }
      yield* systemd.removeAppDropins(slug, instance.processes);
      yield* systemd.daemonReload();
      const { [slug]: _removed, ...remaining } = state.instances;
      yield* caddy.syncConfig(globalConfig, yield* deriveCaddyInstances(remaining));
      yield* store.saveInstances({ ...state, instances: remaining });
      return lifecycleSummary({ command: "rm", slug, globalConfig, instance });
    }),
  );

  yield* output.emit({ json: summary, human: summaryLines(summary) });
});

export const rmCommand = Command.make(
  "rm",
  { slug: Argument.optional(Argument.string("slug")) },
  runRm,
).pipe(Command.withDescription("Remove yard resources for an instance"));
