import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { TunnelNotConfigured } from "../domain/errors.ts";
import { AuthConfig, BinariesConfig, GlobalConfig, TunnelConfig } from "../domain/model.ts";
import { Binaries } from "../services/Binaries.ts";
import { Caddy } from "../services/Caddy.ts";
import { Output } from "../services/Output.ts";
import { StateStore } from "../services/StateStore.ts";
import { Systemd } from "../services/Systemd.ts";
import { Tunnel } from "../services/Tunnel.ts";
import { Xdg } from "../services/Xdg.ts";
import { collectDoctorChecks, doctorFailed, formatDoctorChecks } from "./doctor.ts";

const tunnelName = "yard";
const defaultCaddyHttpPort = 8600;
const defaultCaddyAdminPort = 2019;
const defaultPortRange = [3100, 3999] as const;

class InitInputInvalid extends Schema.TaggedErrorClass<InitInputInvalid>()("InitInputInvalid", {
  message: Schema.String,
}) {}

const expandHome = (value: string) =>
  value.startsWith("~/") ? `${process.env.HOME ?? ""}/${value.slice(2)}` : value;

const selectZone = (
  flag: Option.Option<string>,
  positional: Option.Option<string>,
): Effect.Effect<string, InitInputInvalid> => {
  const zone = Option.getOrUndefined(flag) ?? Option.getOrUndefined(positional);
  return zone === undefined || zone.trim().length === 0
    ? new InitInputInvalid({ message: "yard init requires --zone <zone> or a positional zone" })
    : Effect.succeed(zone.trim());
};

const copyIfDifferent = (fs: FileSystem.FileSystem, source: string | undefined, target: string) =>
  Effect.gen(function* () {
    if (source === undefined || expandHome(source) === target) return;
    const expandedSource = expandHome(source);
    const exists = yield* fs.exists(expandedSource);
    if (!exists) return;
    const bytes = yield* fs.readFile(expandedSource);
    yield* fs.writeFile(target, bytes, { mode: 0o600 });
  });

export const buildInitConfig = (input: {
  readonly zone: string;
  readonly tunnelId: string;
  readonly credentialsFile: string;
  readonly existing?: GlobalConfig;
}) =>
  new GlobalConfig({
    version: 1,
    zone: input.zone,
    caddyHttpPort: input.existing?.caddyHttpPort ?? defaultCaddyHttpPort,
    caddyAdminPort: input.existing?.caddyAdminPort ?? defaultCaddyAdminPort,
    portRange: input.existing?.portRange ?? defaultPortRange,
    tunnel: new TunnelConfig({
      name: tunnelName,
      id: input.tunnelId,
      credentialsFile: input.credentialsFile,
    }),
    binaries:
      input.existing?.binaries ?? new BinariesConfig({ caddy: "auto", cloudflared: "auto" }),
    auth: input.existing?.auth ?? new AuthConfig({ mode: "public" }),
  });

export const initCommand = Command.make(
  "init",
  {
    zone: Flag.optional(Flag.string("zone")),
    zoneArg: Argument.optional(Argument.string("zone")),
  },
  ({ zone, zoneArg }) =>
    Effect.gen(function* () {
      const selectedZone = yield* selectZone(zone, zoneArg);
      const binaries = yield* Binaries;
      const caddy = yield* Caddy;
      const fs = yield* FileSystem.FileSystem;
      const output = yield* Output;
      const path = yield* Path.Path;
      const state = yield* StateStore;
      const systemd = yield* Systemd;
      const tunnel = yield* Tunnel;
      const xdg = yield* Xdg;
      const paths = yield* xdg.paths();
      const credentialsFile = path.join(paths.stateDir, "tunnel-credentials.json");
      const existingConfig = yield* state
        .loadGlobalConfig()
        .pipe(
          Effect.catch((error) =>
            error._tag === "ConfigInvalid" ? Effect.void : Effect.fail(error),
          ),
        );
      const previousTunnel =
        existingConfig?.tunnel.id === "pending" ? undefined : existingConfig?.tunnel;

      const resolved = yield* binaries.resolveAll();
      // Login output (the authorization URL) streams live to stderr while cloudflared
      // waits for the browser flow; the returned value is just a status line.
      const loginOutput = yield* tunnel.login();

      const created = yield* tunnel.create(tunnelName);
      yield* tunnel.routeDns(tunnelName, selectedZone);
      yield* fs.makeDirectory(paths.stateDir, { recursive: true });
      yield* copyIfDifferent(fs, created.credentialsFile, credentialsFile);
      const adoptedCredentials = created.credentialsFile ?? previousTunnel?.credentialsFile;
      if (created.credentialsFile === undefined && adoptedCredentials === undefined) {
        return yield* new TunnelNotConfigured({
          message: `Tunnel ${tunnelName} already exists but no credentials file was found; copy ~/.cloudflared/${created.id}.json to ${credentialsFile} or delete and re-create the tunnel`,
        });
      }

      const finalConfig = buildInitConfig({
        zone: selectedZone,
        tunnelId: created.id,
        credentialsFile:
          created.credentialsFile === undefined && adoptedCredentials !== undefined
            ? adoptedCredentials
            : credentialsFile,
        ...(existingConfig === undefined ? {} : { existing: existingConfig }),
      });
      yield* state.saveGlobalConfig(finalConfig);
      yield* tunnel.writeConfig();
      const instances = yield* state.loadInstances();
      const caddyConfig = caddy.generateConfig(
        finalConfig,
        Object.fromEntries(
          Object.entries(instances.instances).map(([slug, instance]) => [
            slug,
            { instance, running: false },
          ]),
        ),
      );
      yield* caddy.persistConfig(caddyConfig);
      const caddyConfigPath = yield* caddy.configPath();
      const tunnelConfigPath = path.join(paths.stateDir, "tunnel.yml");

      yield* systemd.writeCaddyUnit({
        executable: resolved.caddy,
        args: ["run", "--config", caddyConfigPath],
        execStartPre: [
          {
            executable: process.execPath,
            args: [path.resolve(process.argv[1] ?? "dist/bin.mjs"), "caddy", "render"],
          },
        ],
      });
      yield* systemd.writeTunnelUnit({
        executable: resolved.cloudflared,
        args: ["tunnel", "--config", tunnelConfigPath, "run"],
      });
      yield* systemd.daemonReload();
      yield* systemd.enable("yard-caddy.service");
      yield* systemd.enable("yard-tunnel.service");
      yield* systemd.start("yard-caddy.service");
      yield* systemd.start("yard-tunnel.service");
      yield* systemd.enableLinger();

      const checks = yield* collectDoctorChecks();
      yield* output.emit({
        json: {
          zone: selectedZone,
          configFile: paths.configFile,
          stateDir: paths.stateDir,
          tunnel: finalConfig.tunnel,
          login: loginOutput,
          units: ["yard-caddy.service", "yard-tunnel.service"],
          checks,
        },
        human: [
          loginOutput,
          `yard initialized for *.${selectedZone}`,
          `config: ${paths.configFile}`,
          `state: ${paths.stateDir}`,
          ...formatDoctorChecks(checks),
        ],
      });
      if (doctorFailed(checks)) {
        yield* Effect.sync(() => {
          process.exitCode = 1;
        });
      }
    }),
).pipe(Command.withDescription("Bootstrap yard's Cloudflare tunnel and user daemons"));
