import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ConfigInvalid } from "../domain/errors.js";
import { GlobalConfig, Instance, InstancesFile, RepoConfig } from "../domain/model.js";
import { appUnitName } from "../services/Systemd.js";
import { primaryHostname, routeHostname } from "../domain/slug.js";
import { Caddy, type CaddyInstanceState } from "../services/Caddy.js";
import { EnvLinker, type EnvLinkerAction } from "../services/EnvLinker.js";
import { Lock } from "../services/Lock.js";
import { Output } from "../services/Output.js";
import { Ports } from "../services/Ports.js";
import { RepoConfig as RepoConfigService } from "../services/RepoConfig.js";
import { StateStore } from "../services/StateStore.js";
import { Systemd } from "../services/Systemd.js";
import { resolveContextForUp, type InstanceContext } from "./context.js";

export type PortPlan = {
  readonly routedProcess: string;
  readonly routePorts: ReadonlyArray<{
    readonly route: string;
    readonly process: string;
    readonly portEnv: string;
    readonly urlEnv?: string;
  }>;
};

export type LifecycleSummary = {
  readonly command: "up" | "down" | "restart" | "rm";
  readonly slug: string;
  readonly url: string;
  readonly ports: Readonly<Record<string, number>>;
  readonly units: ReadonlyArray<string>;
  readonly envActions: ReadonlyArray<EnvLinkerAction>;
  readonly ready?: boolean;
};

const noWait = Flag.boolean("no-wait").pipe(Flag.withDescription("Do not wait for HTTP readiness"));
const port = Flag.integer("port").pipe(
  Flag.optional,
  Flag.withDescription("Override the routed process port"),
);

const nowIso = Effect.fn("commands.lifecycle.nowIso")(function* () {
  return DateTime.formatIso(yield* DateTime.now);
});

export const routedProcessName = (config: RepoConfig): string => {
  const routed = Object.entries(config.processes).find(([, process]) => process.route === true);
  if (routed === undefined) {
    throw new Error("Repo config must declare exactly one routed process");
  }
  return routed[0];
};

export const buildPortPlan = (config: RepoConfig): PortPlan => ({
  routedProcess: routedProcessName(config),
  routePorts: Object.entries(config.routes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([route, spec]) => ({
      route,
      process: spec.process,
      portEnv: spec.portEnv,
      ...(spec.urlEnv === undefined ? {} : { urlEnv: spec.urlEnv }),
    })),
});

export const buildProcessEnvironment = (
  globalConfig: GlobalConfig,
  slug: string,
  ports: Readonly<Record<string, number>>,
  plan: PortPlan,
): Readonly<Record<string, string | number>> => {
  const environment: Record<string, string | number> = {
    DEV_HOST: primaryHostname(slug, globalConfig.zone),
    PORT: ports[plan.routedProcess] ?? "",
  };
  for (const route of plan.routePorts) {
    const routePort = ports[route.route];
    if (routePort !== undefined) {
      environment[route.portEnv] = routePort;
    }
    if (route.urlEnv !== undefined) {
      environment[route.urlEnv] = `https://${routeHostname(slug, route.route, globalConfig.zone)}`;
    }
  }
  return environment;
};

export const instanceUnits = (
  slug: string,
  processes: ReadonlyArray<string>,
): ReadonlyArray<string> => processes.map((processName) => appUnitName(slug, processName));

export const lifecycleSummary = (input: {
  readonly command: LifecycleSummary["command"];
  readonly slug: string;
  readonly globalConfig: GlobalConfig;
  readonly instance: Instance;
  readonly envActions?: ReadonlyArray<EnvLinkerAction>;
  readonly ready?: boolean;
}): LifecycleSummary => ({
  command: input.command,
  slug: input.slug,
  url: `https://${primaryHostname(input.slug, input.globalConfig.zone)}`,
  ports: input.instance.ports,
  units: instanceUnits(input.slug, input.instance.processes),
  envActions: input.envActions ?? [],
  ...(input.ready === undefined ? {} : { ready: input.ready }),
});

export const summaryLines = (summary: LifecycleSummary): ReadonlyArray<string> => [
  `${summary.command}: ${summary.slug}`,
  `url: ${summary.url}`,
  `ports: ${Object.entries(summary.ports)
    .map(([name, value]) => `${name}=${value}`)
    .join(" ")}`,
  `units: ${summary.units.join(" ")}`,
  ...(summary.ready === undefined
    ? []
    : [summary.ready ? "ready: yes" : "ready: no (timed out after 60s)"]),
];

/**
 * Instance running-state is never persisted; every Caddy sync derives the other
 * instances' state from systemd so a stopped instance keeps its 503 page when an
 * unrelated command regenerates the config. The current command's instance is
 * passed as an override because its state is known locally.
 */
export const deriveCaddyInstances = Effect.fn("commands.lifecycle.deriveCaddyInstances")(function* (
  instances: Readonly<Record<string, Instance>>,
  overrides: Readonly<Record<string, CaddyInstanceState>> = {},
) {
  const systemd = yield* Systemd;
  const result: Record<string, CaddyInstanceState> = {};
  for (const [slug, instance] of Object.entries(instances)) {
    const override = overrides[slug];
    if (override !== undefined) {
      result[slug] = override;
      continue;
    }
    const running = yield* systemd
      .isActive(appUnitName(slug, instance.routedProcess))
      .pipe(Effect.orElseSucceed(() => false));
    result[slug] = { instance, running };
  }
  return result;
});

const failInvalid = (message: string) =>
  new ConfigInvalid({ path: "repo config", error: new Error(message) });

export const allocatePorts = Effect.fn("commands.lifecycle.allocatePorts")(function* (
  slug: string,
  config: RepoConfig,
  globalConfig: GlobalConfig,
  override: number | undefined,
) {
  const ports = yield* Ports;
  const store = yield* StateStore;
  const plan = buildPortPlan(config);
  const state = yield* store.loadInstances();
  const instance = state.instances[slug];
  const [from, to] = globalConfig.portRange;
  const reserved = new Set<number>();
  for (const [instanceSlug, other] of Object.entries(state.instances)) {
    for (const [routeName, portNumber] of Object.entries(other.ports)) {
      if (instanceSlug === slug && routeName === plan.routedProcess && override !== undefined) {
        continue;
      }
      reserved.add(portNumber);
    }
  }
  const allocated: Record<string, number> = {};

  const choosePort = Effect.fn("commands.lifecycle.allocatePorts.choosePort")(function* (
    routeName: string,
    requested: number | undefined,
  ) {
    const existing = instance?.ports[routeName];
    if (requested !== undefined) {
      if (requested < from || requested > to || reserved.has(requested)) {
        return yield* new ConfigInvalid({
          path: "--port",
          error: new Error(`Port ${requested} is not available in range ${from}-${to}`),
        });
      }
      if (existing === requested || (yield* ports.isUsable(requested))) {
        reserved.add(requested);
        return requested;
      }
      return yield* new ConfigInvalid({
        path: "--port",
        error: new Error(`Port ${requested} is already in use`),
      });
    }

    if (existing !== undefined && existing >= from && existing <= to) {
      reserved.add(existing);
      return existing;
    }

    // Ports.allocate scans state + probes a real bind; exhaustion surfaces as NoFreePort.
    const allocatedPort = yield* ports.allocate(slug, routeName, {
      range: [from, to],
      reserved,
    });
    reserved.add(allocatedPort);
    return allocatedPort;
  });

  allocated[plan.routedProcess] = yield* choosePort(plan.routedProcess, override);
  for (const route of plan.routePorts) {
    allocated[route.route] = yield* choosePort(route.route, undefined);
  }
  return allocated;
});

const adoptOrCreateInstance = Effect.fn("commands.lifecycle.adoptOrCreateInstance")(function* (
  state: InstancesFile,
  context: InstanceContext,
  config: RepoConfig,
  globalConfig: GlobalConfig,
  override: number | undefined,
) {
  const existing = state.instances[context.slug];
  const allocated = yield* allocatePorts(context.slug, config, globalConfig, override);
  const timestamp = yield* nowIso();
  const instance = new Instance({
    repoName: context.repoName,
    word: context.word,
    worktreeRoot: context.worktreeRoot,
    primaryRoot: context.primaryRoot,
    ports: allocated,
    processes: Object.keys(config.processes).sort((left, right) => left.localeCompare(right)),
    routedProcess: buildPortPlan(config).routedProcess,
    visibility:
      existing?.visibility ?? (globalConfig.auth.mode === "public" ? "public" : "protected"),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  });
  return new InstancesFile({
    version: 1,
    instances: { ...state.instances, [context.slug]: instance },
  });
});

export const waitForHttpReady = Effect.fn("commands.lifecycle.waitForHttpReady")(function* (
  portNumber: number,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  let elapsed = 0;
  while (elapsed < 60_000) {
    const ok = yield* httpAnyResponse(portNumber);
    if (ok) {
      return true;
    }
    yield* Effect.sleep("500 millis");
    elapsed = (yield* Clock.currentTimeMillis) - startedAt;
  }
  return false;
});

const httpAnyResponse = (portNumber: number) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const exit = yield* HttpClientRequest.get(`http://127.0.0.1:${portNumber}`).pipe(
      http.execute,
      Effect.timeout("1 second"),
      Effect.exit,
    );
    return exit._tag === "Success";
  });

export const startInstanceUnits = Effect.fn("commands.lifecycle.startInstanceUnits")(function* (
  context: InstanceContext,
  config: RepoConfig,
  globalConfig: GlobalConfig,
  instance: Instance,
  forceRestart = false,
) {
  const systemd = yield* Systemd;
  const plan = buildPortPlan(config);
  const environment = buildProcessEnvironment(globalConfig, context.slug, instance.ports, plan);
  yield* systemd.writeAppTemplate();
  const dropinChanged: Record<string, boolean> = {};
  for (const [processName, processSpec] of Object.entries(config.processes)) {
    dropinChanged[processName] = yield* systemd.writeAppDropin({
      slug: context.slug,
      processName,
      command: processSpec.command,
      workingDirectory: context.worktreeRoot,
      environment,
    });
  }
  yield* systemd.daemonReload();
  for (const processName of instance.processes) {
    const unit = appUnitName(context.slug, processName);
    // A changed dropin (new command/env) must restart an already-running unit;
    // `systemctl start` is a no-op on active units. Restart also starts inactive ones.
    if (forceRestart || dropinChanged[processName] === true) {
      yield* systemd.restart(unit);
    } else {
      yield* systemd.start(unit);
    }
  }
});

const removeVanishedProcessUnits = Effect.fn("commands.lifecycle.removeVanishedProcessUnits")(
  function* (context: InstanceContext, previous: Instance | undefined, current: Instance) {
    if (previous === undefined) return;
    const systemd = yield* Systemd;
    const currentProcesses = new Set(current.processes);
    const removed = previous.processes.filter((processName) => !currentProcesses.has(processName));
    if (removed.length === 0) return;
    for (const processName of removed) {
      yield* systemd.stop(appUnitName(context.slug, processName)).pipe(Effect.ignore);
      yield* systemd.resetFailed(appUnitName(context.slug, processName)).pipe(Effect.ignore);
    }
    yield* systemd.removeAppDropins(context.slug, removed);
  },
);

const runUp = Effect.fn("commands.up.run")(function* (options: {
  readonly noWait: boolean;
  readonly port: Option.Option<number>;
}) {
  const lock = yield* Lock;
  const store = yield* StateStore;
  const repoConfig = yield* RepoConfigService;
  const envLinker = yield* EnvLinker;
  const caddy = yield* Caddy;
  const output = yield* Output;

  const result = yield* lock.withMutationLock(
    Effect.gen(function* () {
      const globalConfig = yield* store.loadGlobalConfig();
      const context = yield* resolveContextForUp();
      const config = yield* repoConfig.resolve(context.worktreeRoot);
      if (!Object.hasOwn(config.processes, buildPortPlan(config).routedProcess)) {
        return yield* failInvalid("Routed process does not exist");
      }
      const state = yield* store.loadInstances();
      const previousInstance = state.instances[context.slug];
      const nextState = yield* adoptOrCreateInstance(
        state,
        context,
        config,
        globalConfig,
        Option.getOrUndefined(options.port),
      );
      yield* store.saveInstances(nextState);
      const instance = nextState.instances[context.slug];
      if (instance === undefined) {
        return yield* failInvalid(`Failed to persist instance ${context.slug}`);
      }

      const envActions = yield* envLinker.linkForWorktree({
        worktreeRoot: context.worktreeRoot,
        primaryRoot: context.primaryRoot,
        env: config.env,
      });
      yield* startInstanceUnits(
        context,
        config,
        globalConfig,
        instance,
        Option.isSome(options.port),
      );
      yield* removeVanishedProcessUnits(context, previousInstance, instance);
      yield* caddy.syncConfig(
        globalConfig,
        yield* deriveCaddyInstances(nextState.instances, {
          [context.slug]: { instance, running: true },
        }),
      );

      const routedPort = instance.ports[instance.routedProcess];
      if (routedPort === undefined) {
        return yield* failInvalid(`Instance ${context.slug} has no routed port`);
      }
      return { context, globalConfig, instance, envActions, routedPort };
    }),
  );

  // The readiness poll can take up to 60s and mutates nothing, so it runs outside
  // the mutation lock: parallel `yard up` in other worktrees must not queue on it.
  const ready = options.noWait ? undefined : yield* waitForHttpReady(result.routedPort);
  const summary = lifecycleSummary({
    command: "up",
    slug: result.context.slug,
    globalConfig: result.globalConfig,
    instance: result.instance,
    envActions: result.envActions,
    ...(ready === undefined ? {} : { ready }),
  });

  yield* output.emit({ json: summary, human: summaryLines(summary) });
});

export const upCommand = Command.make("up", { noWait, port }, runUp).pipe(
  Command.withDescription("Start or update the current yard instance"),
);
