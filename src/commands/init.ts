import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { AuthConfig, BinariesConfig, GlobalConfig, TunnelConfig } from "../domain/model.js";
import { Binaries } from "../services/Binaries.js";
import { Caddy } from "../services/Caddy.js";
import { Output } from "../services/Output.js";
import { StateStore } from "../services/StateStore.js";
import { Systemd } from "../services/Systemd.js";
import { Tunnel } from "../services/Tunnel.js";
import { Xdg } from "../services/Xdg.js";
import { collectDoctorChecks, doctorFailed, formatDoctorChecks } from "./doctor.js";

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
}) =>
  new GlobalConfig({
    version: 1,
    zone: input.zone,
    caddyHttpPort: defaultCaddyHttpPort,
    caddyAdminPort: defaultCaddyAdminPort,
    portRange: defaultPortRange,
    tunnel: new TunnelConfig({
      name: tunnelName,
      id: input.tunnelId,
      credentialsFile: input.credentialsFile,
    }),
    binaries: new BinariesConfig({ caddy: "auto", cloudflared: "auto" }),
    auth: new AuthConfig({ mode: "public" }),
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

      yield* state.saveGlobalConfig(
        buildInitConfig({
          zone: selectedZone,
          tunnelId: "pending",
          credentialsFile,
        }),
      );

      const resolved = yield* binaries.resolveAll();
      const loginOutput = yield* tunnel.login();
      yield* output.emit({
        json: { step: "cloudflare-login", output: loginOutput },
        human: loginOutput.trim().length === 0 ? "Cloudflare login completed" : loginOutput.trim(),
      });

      const created = yield* tunnel.create(tunnelName);
      yield* tunnel.routeDns(tunnelName, selectedZone);
      yield* fs.makeDirectory(paths.stateDir, { recursive: true });
      yield* copyIfDifferent(fs, created.credentialsFile, credentialsFile);

      const finalConfig = buildInitConfig({
        zone: selectedZone,
        tunnelId: created.id,
        credentialsFile,
      });
      yield* state.saveGlobalConfig(finalConfig);
      yield* tunnel.writeConfig();
      const caddyConfig = caddy.generateConfig(finalConfig, {});
      yield* caddy.persistConfig(caddyConfig);
      const caddyConfigPath = yield* caddy.configPath();
      const tunnelConfigPath = path.join(paths.stateDir, "tunnel.yml");

      yield* systemd.writeCaddyUnit({
        executable: resolved.caddy,
        args: ["run", "--config", caddyConfigPath],
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
          units: ["yard-caddy.service", "yard-tunnel.service"],
          checks,
        },
        human: [
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
