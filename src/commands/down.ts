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

const resolveSlug = Effect.fn("commands.down.resolveSlug")(function* (
  slugArg: Option.Option<string>,
) {
  if (Option.isSome(slugArg)) return slugArg.value;
  return (yield* resolveContext()).slug;
});

const runDown = Effect.fn("commands.down.run")(function* (options: {
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
        yield* systemd.stop(unit);
      }
      yield* caddy.syncConfig(
        globalConfig,
        yield* deriveCaddyInstances(state.instances, {
          [slug]: { instance, running: false },
        }),
      );
      return lifecycleSummary({ command: "down", slug, globalConfig, instance });
    }),
  );

  yield* output.emit({ json: summary, human: summaryLines(summary) });
});

export const downCommand = Command.make(
  "down",
  { slug: Argument.optional(Argument.string("slug")) },
  runDown,
).pipe(Command.withDescription("Stop a yard instance but keep its routes"));
