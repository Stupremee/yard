import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  BinaryUnavailable,
  FilesystemError,
  ProcessFailed,
  TunnelNotConfigured,
} from "../domain/errors.ts";
import { StateStore } from "./StateStore.ts";
import { Xdg } from "./Xdg.ts";

export type BinaryName = "caddy" | "cloudflared";
export type SupportedArch = "x64" | "arm64";

export type BinaryDownload = {
  readonly name: BinaryName;
  readonly version: string;
  readonly url: string;
  readonly archive: "tar.gz" | "binary";
  readonly executableName: string;
};

export const CADDY_VERSION = "2.10.0";
export const CLOUDFLARED_VERSION = "2025.6.1";

export const detectSupportedArch = (arch: string): SupportedArch | undefined => {
  if (arch === "x64") return "x64";
  if (arch === "arm64") return "arm64";
  return undefined;
};

const caddyArchName = (arch: SupportedArch) => (arch === "x64" ? "amd64" : "arm64");
const cloudflaredArchName = (arch: SupportedArch) => (arch === "x64" ? "amd64" : "arm64");

export const downloadFor = (name: BinaryName, arch: SupportedArch): BinaryDownload => {
  if (name === "caddy") {
    return {
      name,
      version: CADDY_VERSION,
      url: `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${caddyArchName(
        arch,
      )}.tar.gz`,
      archive: "tar.gz",
      executableName: "caddy",
    };
  }
  return {
    name,
    version: CLOUDFLARED_VERSION,
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${cloudflaredArchName(
      arch,
    )}`,
    archive: "binary",
    executableName: "cloudflared",
  };
};

export const pathCandidates = (
  binary: string,
  pathValue: string | undefined,
): ReadonlyArray<string> => {
  if (pathValue === undefined || pathValue.length === 0) return [];
  return pathValue
    .split(":")
    .filter((entry) => entry.length > 0)
    .map((entry) => `${entry}/${binary}`);
};

export const isAbsolutePath = (value: string) => value.startsWith("/");

const executableMode = 0o111;

const isExecutable = (fs: FileSystem.FileSystem, file: string) =>
  fs.stat(file).pipe(
    Effect.map((stat) => (Number(stat.mode) & executableMode) !== 0),
    Effect.orElseSucceed(() => false),
  );

const atomicWriteBytes = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  file: string,
  bytes: Uint8Array,
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
      .writeFile(tmp, bytes)
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "write", error })),
      );
    yield* fs
      .chmod(tmp, 0o755)
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "chmod", error })),
      );
    yield* fs
      .rename(tmp, file)
      .pipe(
        Effect.mapError((error) => new FilesystemError({ path: file, operation: "rename", error })),
      );
  });

export class Binaries extends Context.Service<
  Binaries,
  {
    readonly resolve: (
      name: BinaryName,
    ) => Effect.Effect<
      string,
      | BinaryUnavailable
      | FilesystemError
      | PlatformError.PlatformError
      | ProcessFailed
      | TunnelNotConfigured
    >;
    readonly resolveAll: () => Effect.Effect<
      { readonly caddy: string; readonly cloudflared: string },
      | BinaryUnavailable
      | FilesystemError
      | PlatformError.PlatformError
      | ProcessFailed
      | TunnelNotConfigured
    >;
  }
>()("yard/services/Binaries") {
  static readonly layer = Layer.effect(
    Binaries,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const xdg = yield* Xdg;
      const state = yield* StateStore;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;

      const findOnPath = Effect.fn("Binaries.findOnPath")(function* (name: BinaryName) {
        for (const candidate of pathCandidates(name, process.env.PATH)) {
          if (yield* isExecutable(fs, candidate)) return candidate;
        }
        return undefined;
      });

      const extractCaddy = Effect.fn("Binaries.extractCaddy")(function* (
        archiveFile: string,
        outputFile: string,
      ) {
        const workDir = `${archiveFile}.d`;
        yield* fs
          .makeDirectory(workDir, { recursive: true })
          .pipe(
            Effect.mapError(
              (error) => new FilesystemError({ path: workDir, operation: "mkdir", error }),
            ),
          );
        const command = ChildProcess.make("tar", ["-xzf", archiveFile, "-C", workDir, "caddy"]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(command);
            const exitCode = yield* handle.exitCode;
            if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
              return yield* new ProcessFailed({
                command: "tar",
                args: ["-xzf", archiveFile, "-C", workDir, "caddy"],
                exitCode: Number(exitCode),
                stderr: "failed to extract caddy archive",
              });
            }
          }),
        );
        const extracted = path.join(workDir, "caddy");
        yield* fs
          .chmod(extracted, 0o755)
          .pipe(
            Effect.mapError(
              (error) => new FilesystemError({ path: extracted, operation: "chmod", error }),
            ),
          );
        yield* fs
          .rename(extracted, outputFile)
          .pipe(
            Effect.mapError(
              (error) => new FilesystemError({ path: outputFile, operation: "rename", error }),
            ),
          );
        yield* fs.remove(workDir, { recursive: true }).pipe(Effect.ignore);
      });

      const downloadBytes = Effect.fn("Binaries.downloadBytes")(function* (url: string) {
        const response = yield* HttpClient.filterStatusOk(httpClient).execute(
          HttpClientRequest.get(url),
        );
        return new Uint8Array(yield* response.arrayBuffer);
      });

      const installPinned = Effect.fn("Binaries.installPinned")(function* (name: BinaryName) {
        const arch = detectSupportedArch(process.arch);
        if (arch === undefined) {
          return yield* new BinaryUnavailable({
            name,
            message: `Unsupported architecture: ${process.arch}`,
          });
        }
        const paths = yield* xdg.paths();
        const download = downloadFor(name, arch);
        const target = path.join(paths.shareBinDir, name);
        if (yield* isExecutable(fs, target)) return target;

        const bytes = yield* downloadBytes(download.url).pipe(
          Effect.mapError(
            (error) =>
              new BinaryUnavailable({
                name,
                url: download.url,
                message: `Failed to download pinned binary; check network/proxy access: ${String(error)}`,
              }),
          ),
        );
        if (download.archive === "binary") {
          yield* atomicWriteBytes(fs, path, target, bytes);
        } else {
          const archiveFile = `${target}.${download.version}.tar.gz`;
          yield* atomicWriteBytes(fs, path, archiveFile, bytes);
          yield* extractCaddy(archiveFile, target);
          yield* fs.remove(archiveFile).pipe(Effect.ignore);
        }
        if (!(yield* isExecutable(fs, target))) {
          return yield* new FilesystemError({
            path: target,
            operation: "chmod",
            error: new Error("Installed binary is not executable"),
          });
        }
        return target;
      });

      const resolve = Effect.fn("Binaries.resolve")(function* (name: BinaryName) {
        const config = yield* state.loadGlobalConfig().pipe(Effect.orDie);
        const configured = config.binaries[name];
        if (configured !== "auto") {
          if (!isAbsolutePath(configured)) {
            return yield* new TunnelNotConfigured({
              message: `Configured ${name} binary must be "auto" or an absolute path`,
            });
          }
          if (!(yield* isExecutable(fs, configured))) {
            return yield* new FilesystemError({
              path: configured,
              operation: "stat",
              error: new Error("Binary is not executable"),
            });
          }
          return configured;
        }
        return (yield* findOnPath(name)) ?? (yield* installPinned(name));
      });

      return {
        resolve,
        resolveAll: Effect.fn("Binaries.resolveAll")(function* () {
          return { caddy: yield* resolve("caddy"), cloudflared: yield* resolve("cloudflared") };
        }),
      };
    }),
  );
}
