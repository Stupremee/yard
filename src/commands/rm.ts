import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command } from "effect/unstable/cli";
import { CloudflareDnsError, InstanceNotFound } from "../domain/errors.ts";
import { instanceHostnames } from "../domain/slug.ts";
import { Caddy } from "../services/Caddy.ts";
import { CloudflareDns } from "../services/CloudflareDns.ts";
import { Lock } from "../services/Lock.ts";
import { Output } from "../services/Output.ts";
import { StateStore } from "../services/StateStore.ts";
import { Systemd } from "../services/Systemd.ts";
import { Tunnel } from "../services/Tunnel.ts";
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
  const cloudflareDns = yield* CloudflareDns;
  const output = yield* Output;
  const tunnel = yield* Tunnel;

  const summary = yield* lock.withMutationLock(
    Effect.gen(function* () {
      const globalConfig = yield* store.loadGlobalConfig();
      const state = yield* store.loadInstances();
      const slug = yield* resolveSlug(options.slug);
      const instance = state.instances[slug];
      if (instance === undefined) {
        return yield* new InstanceNotFound({ slug });
      }
      const removedHostnames = instanceHostnames(slug, instance, globalConfig.zone);
      for (const unit of instanceUnits(slug, instance.processes)) {
        yield* systemd.stop(unit).pipe(Effect.orElseSucceed(() => undefined));
        yield* systemd.disable(unit).pipe(Effect.orElseSucceed(() => undefined));
        yield* systemd.resetFailed(unit).pipe(Effect.orElseSucceed(() => undefined));
      }
      yield* systemd.removeAppDropins(slug, instance.processes);
      yield* systemd.daemonReload();
      const { [slug]: _removed, ...remaining } = state.instances;
      yield* store.saveInstances({ ...state, instances: remaining });
      yield* caddy.syncConfig(globalConfig, yield* deriveCaddyInstances(remaining));
      const tunnelConfigChanged = yield* tunnel.writeConfig();
      if (tunnelConfigChanged) {
        const tunnelActive = yield* systemd
          .isActive("yard-tunnel.service")
          .pipe(Effect.orElseSucceed(() => false));
        if (tunnelActive) {
          yield* systemd.restart("yard-tunnel.service");
        }
      }

      const skippedNoToken: Array<string> = [];
      const warnings: Array<string> = [];
      for (const hostname of removedHostnames) {
        const outcome = yield* cloudflareDns
          .deleteHostname({
            zone: globalConfig.zone,
            tunnelId: globalConfig.tunnel.id,
            hostname,
          })
          .pipe(
            Effect.map((result) => ({ _tag: "ok" as const, result })),
            Effect.catch((error: CloudflareDnsError) =>
              Effect.succeed({ _tag: "failed" as const, error }),
            ),
          );
        if (outcome._tag === "failed") {
          warnings.push(`DNS record cleanup failed for ${hostname}: ${outcome.error.message}`);
        } else if (outcome.result === "skipped-no-token") {
          skippedNoToken.push(hostname);
        }
      }
      if (skippedNoToken.length > 0) {
        warnings.unshift(
          `DNS records not deleted (set CLOUDFLARE_API_TOKEN to enable cleanup): ${skippedNoToken.join(", ")}`,
        );
      }
      return lifecycleSummary({ command: "rm", slug, globalConfig, instance, warnings });
    }),
  );

  yield* output.emit({ json: summary, human: summaryLines(summary) });
});

export const rmCommand = Command.make(
  "rm",
  { slug: Argument.optional(Argument.string("slug")) },
  runRm,
).pipe(Command.withDescription("Remove yard resources for an instance"));
