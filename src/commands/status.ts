import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { Instance } from "../domain/model.js";
import { primaryHostname, routeHostname } from "../domain/slug.js";
import { appUnitName } from "../services/Systemd.js";
import { Caddy } from "../services/Caddy.js";
import { Output } from "../services/Output.js";
import { StateStore } from "../services/StateStore.js";
import { Systemd } from "../services/Systemd.js";
import { lookupInstance, resolveContext } from "./context.js";

export type ProcessStatus = {
  readonly name: string;
  readonly unit: string;
  readonly active: boolean;
  readonly loadState: string | null;
  readonly subState: string | null;
};

export type RouteStatus = {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly present: boolean;
};

export type InstanceStatus = {
  readonly slug: string;
  readonly repoName: string;
  readonly word: string | null;
  readonly worktreeRoot: string;
  readonly primaryRoot: string;
  readonly visibility: "protected" | "public";
  readonly processes: ReadonlyArray<ProcessStatus>;
  readonly routes: ReadonlyArray<RouteStatus>;
  readonly caddy: {
    readonly reachable: boolean;
  };
};

const collectHosts = (value: unknown): ReadonlySet<string> => {
  const hosts = new Set<string>();
  const visit = (input: unknown) => {
    if (Array.isArray(input)) {
      for (const item of input) visit(item);
    } else if (typeof input === "object" && input !== null) {
      const record = input as Record<string, unknown>;
      if (Array.isArray(record.host)) {
        for (const host of record.host) {
          if (typeof host === "string") hosts.add(host);
        }
      }
      for (const item of Object.values(record)) visit(item);
    }
  };
  visit(value);
  return hosts;
};

export const shapeInstanceStatus = (input: {
  readonly slug: string;
  readonly instance: Instance;
  readonly zone: string;
  readonly activeByProcess: Readonly<Record<string, boolean>>;
  readonly showByProcess: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly caddyReachable: boolean;
  readonly caddyHosts: ReadonlySet<string>;
}): InstanceStatus => {
  const routes = Object.entries(input.instance.ports)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, port]) => {
      const host =
        name === "web"
          ? primaryHostname(input.slug, input.zone)
          : routeHostname(input.slug, name, input.zone);
      return { name, host, port, present: input.caddyHosts.has(host) };
    });
  const processes = input.instance.processes
    .slice()
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const show = input.showByProcess[name] ?? {};
      return {
        name,
        unit: appUnitName(input.slug, name),
        active: input.activeByProcess[name] ?? false,
        loadState: show.LoadState ?? null,
        subState: show.SubState ?? null,
      };
    });
  return {
    slug: input.slug,
    repoName: input.instance.repoName,
    word: input.instance.word,
    worktreeRoot: input.instance.worktreeRoot,
    primaryRoot: input.instance.primaryRoot,
    visibility: input.instance.visibility,
    processes,
    routes,
    caddy: { reachable: input.caddyReachable },
  };
};

export const formatInstanceStatus = (status: InstanceStatus): ReadonlyArray<string> => [
  `${status.slug} ${status.processes.some((process) => process.active) ? "active" : "inactive"}`,
  `worktree ${status.worktreeRoot}`,
  `caddy ${status.caddy.reachable ? "reachable" : "unreachable"}`,
  ...status.processes.map(
    (process) =>
      `process ${process.name} ${process.active ? "active" : "inactive"} ${process.unit}`,
  ),
  ...status.routes.map(
    (route) =>
      `route ${route.name} https://${route.host} -> ${route.port} ${route.present ? "present" : "missing"}`,
  ),
];

export const loadInstanceStatus = Effect.fn("commands.status.loadInstanceStatus")(function* (
  slug: string,
  instance: Instance,
) {
  const store = yield* StateStore;
  const systemd = yield* Systemd;
  const caddy = yield* Caddy;
  const config = yield* store.loadGlobalConfig();
  const caddyConfig = yield* caddy.getConfig(config).pipe(
    Effect.map((config) => ({ reachable: true as const, config })),
    Effect.orElseSucceed(() => ({ reachable: false as const, config: undefined })),
  );
  const caddyHosts = caddyConfig.reachable ? collectHosts(caddyConfig.config) : new Set<string>();
  const activeByProcess: Record<string, boolean> = {};
  const showByProcess: Record<string, Readonly<Record<string, string>>> = {};
  for (const processName of instance.processes) {
    const unit = appUnitName(slug, processName);
    activeByProcess[processName] = yield* systemd.isActive(unit);
    showByProcess[processName] = yield* systemd.show(unit).pipe(Effect.orElseSucceed(() => ({})));
  }
  return shapeInstanceStatus({
    slug,
    instance,
    zone: config.zone,
    activeByProcess,
    showByProcess,
    caddyReachable: caddyConfig.reachable,
    caddyHosts,
  });
});

export const statusCommand = Command.make(
  "status",
  {},
  Effect.fn("commands.status")(function* () {
    const context = yield* resolveContext();
    const instance = yield* lookupInstance(context.slug);
    const output = yield* Output;
    const status = yield* loadInstanceStatus(context.slug, instance);
    yield* output.emit({ json: status, human: formatInstanceStatus(status) });
  }),
).pipe(Command.withDescription("Show live status for the current yard instance"));
