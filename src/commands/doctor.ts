import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Clock from "effect/Clock";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Command } from "effect/unstable/cli";
import { Binaries } from "../services/Binaries.ts";
import { Caddy } from "../services/Caddy.ts";
import { Output } from "../services/Output.ts";
import { StateStore } from "../services/StateStore.ts";
import { Systemd } from "../services/Systemd.ts";
import { Tunnel } from "../services/Tunnel.ts";
import { expandHome } from "../services/Tunnel.ts";
import { instanceHostnames } from "../domain/slug.ts";

export type DoctorCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
};

class DoctorProbeFailed extends Schema.TaggedErrorClass<DoctorProbeFailed>()("DoctorProbeFailed", {
  message: Schema.String,
}) {}

const errorMessage = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);

const randomLabel = Effect.gen(function* () {
  const millis = yield* Clock.currentTimeMillis;
  const random = yield* Random.nextInt;
  return `yard-${millis.toString(36)}-${Math.abs(random).toString(36)}`;
});

const hasActiveTunnelConnections = (info: string) => {
  const lower = info.toLowerCase();
  return /\b[1-9][0-9]*\s+connection/.test(lower) || lower.includes("healthy");
};

export const formatDoctorChecks = (checks: ReadonlyArray<DoctorCheck>): ReadonlyArray<string> =>
  checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);

export const doctorFailed = (checks: ReadonlyArray<DoctorCheck>) =>
  checks.some((check) => !check.ok);

const check = <R>(
  name: string,
  effect: Effect.Effect<string, object, R>,
): Effect.Effect<DoctorCheck, never, R> =>
  Effect.catch(effect.pipe(Effect.map((detail) => ({ name, ok: true, detail }))), (error) =>
    Effect.succeed({ name, ok: false, detail: errorMessage(error) }),
  );

const runCommand = (command: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(ChildProcess.make(command, [...args]));
      yield* Effect.all([Stream.runDrain(handle.stdout), Stream.runDrain(handle.stderr)], {
        concurrency: 2,
      });
      const exitCode = yield* handle.exitCode;
      if (Number(exitCode) !== 0) {
        return yield* new DoctorProbeFailed({
          message: `${command} ${args.join(" ")} exited ${Number(exitCode)}`,
        });
      }
    }),
  );

const streamText = (stream: Stream.Stream<Uint8Array, object>) =>
  Effect.gen(function* () {
    const chunks = yield* Stream.runCollect(stream);
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
  });

export const runCommandOutput = (command: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(ChildProcess.make(command, [...args]));
      const [stdout, stderr] = yield* Effect.all(
        [streamText(handle.stdout), streamText(handle.stderr)],
        { concurrency: 2 },
      );
      const exitCode = yield* handle.exitCode;
      if (Number(exitCode) !== 0) {
        return yield* new DoctorProbeFailed({
          message: `${command} ${args.join(" ")} exited ${Number(exitCode)}: ${stderr}`,
        });
      }
      return stdout;
    }),
  );

const portRangeSane = (range: readonly [number, number]) =>
  range[0] > 0 && range[1] <= 65535 && range[0] <= range[1];

const probeFreePort = (port: number) =>
  Effect.tryPromise({
    try: async () => {
      const net = await import("node:net");
      await new Promise<void>((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
      });
    },
    catch: (error) => new DoctorProbeFailed({ message: errorMessage(error) }),
  });

const resolveDns = (host: string) =>
  Effect.tryPromise({
    try: async () => {
      const dns = await import("node:dns/promises");
      const result = await dns.lookup(host);
      return result.address;
    },
    catch: (error) => new DoctorProbeFailed({ message: errorMessage(error) }),
  });

export const collectDoctorChecks = Effect.fn("commands.doctor.collectDoctorChecks")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* StateStore;
  const config = yield* state.loadGlobalConfig();
  const binaries = yield* Binaries;
  const caddy = yield* Caddy;
  const systemd = yield* Systemd;
  const tunnel = yield* Tunnel;

  return yield* Effect.all(
    [
      check(
        "binaries",
        binaries
          .resolveAll()
          .pipe(
            Effect.map(
              (resolved) => `caddy ${resolved.caddy}; cloudflared ${resolved.cloudflared}`,
            ),
          ),
      ),
      check(
        "systemd user session",
        runCommand("systemctl", ["--user", "show-environment"]).pipe(Effect.as("available")),
      ),
      check(
        "linger",
        runCommandOutput("loginctl", ["show-user", process.env.USER ?? "", "-p", "Linger"]).pipe(
          Effect.flatMap((stdout) =>
            stdout.includes("Linger=yes")
              ? Effect.succeed("enabled")
              : new DoctorProbeFailed({ message: "disabled" }),
          ),
        ),
      ),
      check(
        "yard-caddy active",
        systemd
          .isActive("yard-caddy.service")
          .pipe(
            Effect.flatMap((active) =>
              active ? Effect.succeed("active") : new DoctorProbeFailed({ message: "inactive" }),
            ),
          ),
      ),
      check(
        "yard-tunnel active",
        systemd
          .isActive("yard-tunnel.service")
          .pipe(
            Effect.flatMap((active) =>
              active ? Effect.succeed("active") : new DoctorProbeFailed({ message: "inactive" }),
            ),
          ),
      ),
      check(
        "Caddy admin API",
        caddy
          .reachable(config)
          .pipe(
            Effect.flatMap((reachable) =>
              reachable
                ? Effect.succeed("reachable")
                : new DoctorProbeFailed({ message: "unreachable" }),
            ),
          ),
      ),
      check(
        "tunnel connections",
        tunnel
          .info(config.tunnel.name)
          .pipe(
            Effect.flatMap((info) =>
              hasActiveTunnelConnections(info)
                ? Effect.succeed("active connections found")
                : new DoctorProbeFailed({ message: "no active connections reported" }),
            ),
          ),
      ),
      check(
        "instance DNS",
        Effect.gen(function* () {
          const stateFile = yield* state.loadInstances();
          const hostnames = Object.entries(stateFile.instances).flatMap(([slug, instance]) =>
            instanceHostnames(slug, instance, config.zone),
          );
          if (hostnames.length === 0) {
            return "no instances";
          }
          const results = yield* Effect.all(
            hostnames.map((hostname) =>
              resolveDns(hostname).pipe(
                Effect.as({ hostname, ok: true as const }),
                Effect.orElseSucceed(() => ({ hostname, ok: false as const })),
              ),
            ),
            { concurrency: "unbounded" },
          );
          const unresolved = results
            .filter((result) => !result.ok)
            .map((result) => result.hostname);
          if (unresolved.length > 0) {
            return yield* new DoctorProbeFailed({
              message: `unresolved hostnames: ${unresolved.join(", ")}`,
            });
          }
          return `resolved ${results.length}/${hostnames.length} hostnames`;
        }),
      ),
      check(
        "no wildcard DNS",
        randomLabel.pipe(
          Effect.flatMap((label) =>
            Effect.exit(resolveDns(`${label}.${config.zone}`)).pipe(
              Effect.flatMap((exit) =>
                exit._tag === "Success"
                  ? new DoctorProbeFailed({
                      message:
                        "random label resolves; remove the wildcard DNS record or catch-all from Cloudflare because yard now uses per-hostname records",
                    })
                  : Effect.succeed("random label does not resolve"),
              ),
            ),
          ),
        ),
      ),
      check(
        "port range",
        Effect.gen(function* () {
          if (!portRangeSane(config.portRange)) {
            return yield* new DoctorProbeFailed({
              message: `invalid range ${config.portRange[0]}-${config.portRange[1]}`,
            });
          }
          const stateFile = yield* state.loadInstances();
          const used = new Set(
            Object.values(stateFile.instances).flatMap((instance) => Object.values(instance.ports)),
          );
          const candidate = Array.from(
            { length: config.portRange[1] - config.portRange[0] + 1 },
            (_, index) => config.portRange[0] + index,
          ).find((port) => !used.has(port));
          if (candidate === undefined) {
            return yield* new DoctorProbeFailed({
              message: "all configured ports are allocated in state",
            });
          }
          yield* probeFreePort(candidate);
          return `valid ${config.portRange[0]}-${config.portRange[1]}, ${candidate} is free`;
        }),
      ),
      check(
        "tunnel credentials",
        fs.exists(expandHome(config.tunnel.credentialsFile)).pipe(
          Effect.flatMap((exists) =>
            exists
              ? Effect.succeed("present")
              : new DoctorProbeFailed({
                  message: `missing ${expandHome(config.tunnel.credentialsFile)}`,
                }),
          ),
        ),
      ),
    ],
    { concurrency: "unbounded" },
  );
});

export const doctorCommand = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const output = yield* Output;
    const checks = yield* collectDoctorChecks();
    yield* output.emit({ json: checks, human: formatDoctorChecks(checks) });
    if (doctorFailed(checks)) {
      yield* Effect.sync(() => {
        process.exitCode = 1;
      });
    }
  }),
).pipe(Command.withDescription("Check yard daemon, tunnel, DNS, and port health"));
