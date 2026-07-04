import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command } from "effect/unstable/cli";
import { ConfigInvalid } from "../domain/errors.js";
import { Caddy } from "../services/Caddy.js";
import { Lock } from "../services/Lock.js";
import { Output } from "../services/Output.js";
import { StateStore } from "../services/StateStore.js";
import { appDropinDirectoryName, Systemd } from "../services/Systemd.js";
import { Xdg } from "../services/Xdg.js";
import { resolveContext } from "./context.js";
import { instanceUnits, lifecycleSummary, summaryLines } from "./up.js";

const removeDropins = Effect.fn("commands.rm.removeDropins")(function* (
  slug: string,
  processes: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const xdg = yield* Xdg;
  const paths = yield* xdg.paths();
  const userUnitDir = path.join(path.dirname(paths.configDir), "systemd", "user");
  for (const processName of processes) {
    yield* fs.remove(path.join(userUnitDir, appDropinDirectoryName(slug, processName)), {
      recursive: true,
      force: true,
    });
  }
});

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
        return yield* new ConfigInvalid({
          path: "instances.json",
          error: new Error(`Unknown yard instance: ${context.slug}`),
        });
      }
      for (const unit of instanceUnits(context.slug, instance.processes)) {
        yield* systemd.stop(unit).pipe(Effect.orElseSucceed(() => undefined));
        yield* systemd.disable(unit).pipe(Effect.orElseSucceed(() => undefined));
      }
      yield* removeDropins(context.slug, instance.processes);
      yield* systemd.daemonReload();
      const { [context.slug]: _removed, ...remaining } = state.instances;
      yield* caddy.syncConfig(globalConfig, remaining);
      yield* store.saveInstances({ ...state, instances: remaining });
      return lifecycleSummary({ command: "rm", slug: context.slug, globalConfig, instance });
    }),
  );

  yield* output.emit({ json: summary, human: summaryLines(summary) });
});

export const rmCommand = Command.make("rm", {}, runRm).pipe(
  Command.withDescription("Remove yard resources for the current instance"),
);
