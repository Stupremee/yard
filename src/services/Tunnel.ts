import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { FilesystemError, ProcessFailed, TunnelNotConfigured } from "../domain/errors.js";
import { StateStore } from "./StateStore.js";
import { Xdg } from "./Xdg.js";
import { Binaries } from "./Binaries.js";

export type TunnelCreateResult = {
  readonly id: string;
  readonly credentialsFile?: string;
};

export type TunnelListEntry = {
  readonly id: string;
  readonly name: string;
};

const uuidPattern = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const decodeStream = Effect.fn("Tunnel.decodeStream")(function* (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
) {
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

export const renderTunnelConfig = (options: {
  readonly tunnelId: string;
  readonly credentialsFile: string;
  readonly zone: string;
  readonly caddyHttpPort: number;
}) =>
  [
    `tunnel: ${options.tunnelId}`,
    `credentials-file: ${options.credentialsFile}`,
    "ingress:",
    `  - hostname: "*.${options.zone}"`,
    `    service: http://127.0.0.1:${options.caddyHttpPort}`,
    "  - service: http_status:404",
    "",
  ].join("\n");

export const parseTunnelCreateOutput = (output: string): TunnelCreateResult | "already-exists" => {
  if (/already exists/i.test(output)) return "already-exists";
  const id = output.match(new RegExp(uuidPattern))?.[0];
  if (id === undefined) return "already-exists";
  const credentialsFile =
    output.match(/(?:credentials file|credentials).*?(\/[^\s'"]+\.json)/i)?.[1] ??
    output.match(/(\/[^\s'"]+\.json)/)?.[1];
  return credentialsFile === undefined ? { id } : { id, credentialsFile };
};

export const parseTunnelList = (output: string): ReadonlyArray<TunnelListEntry> => {
  const entries: Array<TunnelListEntry> = [];
  for (const line of output.split(/\r?\n/)) {
    const id = line.match(new RegExp(uuidPattern))?.[0];
    if (id === undefined) continue;
    const columns = line
      .trim()
      .replace(id, "")
      .trim()
      .split(/\s{2,}|\t+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const name = columns.find((part) => !/created|connections|id/i.test(part));
    if (name !== undefined) entries.push({ id, name });
  }
  return entries;
};

export const parseRouteDnsOutput = (output: string) =>
  /route|dns|cname|success|already/i.test(output);

const atomicWriteString = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  file: string,
  contents: string,
) =>
  Effect.gen(function* () {
    const millis = yield* Clock.currentTimeMillis;
    const tmp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${millis}.tmp`,
    );
    yield* fs
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "mkdir", error })),
      );
    yield* fs
      .writeFileString(tmp, contents)
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "write", error })),
      );
    yield* fs
      .rename(tmp, file)
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "rename", error })),
      );
  });

export const expandHome = (value: string) =>
  value.startsWith("~/") ? `${process.env.HOME ?? ""}/${value.slice(2)}` : value;

export class Tunnel extends Context.Service<
  Tunnel,
  {
    readonly login: () => Effect.Effect<
      string,
      PlatformError.PlatformError | ProcessFailed | TunnelNotConfigured
    >;
    readonly create: (
      name: string,
    ) => Effect.Effect<
      TunnelCreateResult,
      PlatformError.PlatformError | ProcessFailed | TunnelNotConfigured
    >;
    readonly routeDns: (
      name: string,
      zone: string,
    ) => Effect.Effect<void, PlatformError.PlatformError | ProcessFailed | TunnelNotConfigured>;
    readonly info: (
      name: string,
    ) => Effect.Effect<string, PlatformError.PlatformError | ProcessFailed | TunnelNotConfigured>;
    readonly writeConfig: () => Effect.Effect<void, FilesystemError | TunnelNotConfigured>;
  }
>()("yard/services/Tunnel") {
  static readonly layer = Layer.effect(
    Tunnel,
    Effect.gen(function* () {
      const binaries = yield* Binaries;
      const state = yield* StateStore;
      const xdg = yield* Xdg;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const run = Effect.fn("Tunnel.run")(function* (args: ReadonlyArray<string>) {
        const cloudflared = yield* binaries.resolve("cloudflared").pipe(Effect.orDie);
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(ChildProcess.make(cloudflared, [...args]));
            const [stdout, stderr] = yield* Effect.all(
              [decodeStream(handle.stdout), decodeStream(handle.stderr)],
              { concurrency: 2 },
            ).pipe(Effect.mapError((error) => new TunnelNotConfigured({ message: String(error) })));
            const exitCode = yield* handle.exitCode.pipe(
              Effect.mapError((error) => new TunnelNotConfigured({ message: String(error) })),
            );
            const output = `${stdout}${stderr}`;
            if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
              return yield* new ProcessFailed({
                command: cloudflared,
                args: [...args],
                exitCode: Number(exitCode),
                stderr,
              });
            }
            return output;
          }),
        );
      });

      // `cloudflared tunnel login` prints the authorization URL and then blocks until the
      // browser flow completes, so its output must reach the terminal live. Everything goes
      // to stderr so --json stdout stays machine-readable.
      const runInteractive = Effect.fn("Tunnel.runInteractive")(function* (
        args: ReadonlyArray<string>,
      ) {
        const cloudflared = yield* binaries.resolve("cloudflared").pipe(Effect.orDie);
        const pump = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
          Stream.runForEach(stream, (chunk) =>
            Effect.sync(() => {
              process.stderr.write(chunk);
            }),
          );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(ChildProcess.make(cloudflared, [...args]));
            yield* Effect.all([pump(handle.stdout), pump(handle.stderr)], {
              concurrency: 2,
            }).pipe(
              Effect.mapError((error) => new TunnelNotConfigured({ message: String(error) })),
            );
            const exitCode = yield* handle.exitCode.pipe(
              Effect.mapError((error) => new TunnelNotConfigured({ message: String(error) })),
            );
            if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
              return yield* new ProcessFailed({
                command: cloudflared,
                args: [...args],
                exitCode: Number(exitCode),
                stderr: "",
              });
            }
          }),
        );
      });

      const list = Effect.fn("Tunnel.list")(function* () {
        return parseTunnelList(yield* run(["tunnel", "list"]));
      });

      return {
        login: Effect.fn("Tunnel.login")(function* () {
          const certFile = path.join(process.env.HOME ?? "", ".cloudflared", "cert.pem");
          const certExists = yield* fs.exists(certFile).pipe(Effect.orElseSucceed(() => false));
          if (certExists) {
            return `Cloudflare certificate already present at ${certFile}; skipping login`;
          }
          yield* runInteractive(["tunnel", "login"]);
          return "Cloudflare login completed";
        }),
        create: Effect.fn("Tunnel.create")(function* (name: string) {
          const parsed = parseTunnelCreateOutput(yield* run(["tunnel", "create", name]));
          if (parsed !== "already-exists") return parsed;
          const entry = (yield* list()).find((tunnel) => tunnel.name === name);
          if (entry === undefined) {
            return yield* new TunnelNotConfigured({
              message: `Tunnel ${name} already exists but was not found in tunnel list`,
            });
          }
          return { id: entry.id };
        }),
        routeDns: Effect.fn("Tunnel.routeDns")(function* (name: string, zone: string) {
          const output = yield* run(["tunnel", "route", "dns", name, `*.${zone}`]);
          if (!parseRouteDnsOutput(output)) {
            return yield* new TunnelNotConfigured({ message: output });
          }
        }),
        info: Effect.fn("Tunnel.info")(function* (name: string) {
          return yield* run(["tunnel", "info", name]);
        }),
        writeConfig: Effect.fn("Tunnel.writeConfig")(function* () {
          const config = yield* state.loadGlobalConfig().pipe(Effect.orDie);
          const paths = yield* xdg.paths();
          const tunnelConfig = renderTunnelConfig({
            tunnelId: config.tunnel.id,
            credentialsFile: expandHome(config.tunnel.credentialsFile),
            zone: config.zone,
            caddyHttpPort: config.caddyHttpPort,
          });
          yield* atomicWriteString(fs, path, path.join(paths.stateDir, "tunnel.yml"), tunnelConfig);
        }),
      };
    }),
  );
}
