import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ProcessFailed } from "../domain/errors.js";
import { appUnitInstanceName } from "../domain/slug.js";
import { Xdg } from "./Xdg.js";

export type AppDropinInput = {
  readonly slug: string;
  readonly processName: string;
  readonly command: string;
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string | number>>;
};

export type DaemonUnitInput = {
  readonly executable: string;
  readonly args?: ReadonlyArray<string>;
  readonly workingDirectory?: string;
  readonly environment?: Readonly<Record<string, string | number>>;
};

export type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

const decodeStream = Effect.fn("Systemd.decodeStream")(function* (
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

const shellSingleQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const systemdQuote = (value: string | number): string => {
  const text = String(value);
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
};

const envLine = ([name, value]: readonly [string, string | number]) =>
  `Environment=${systemdQuote(`${name}=${value}`)}`;

const unitPreamble = (description: string): string => `[Unit]
Description=${description}

[Service]
`;

export const renderAppTemplateUnit = (): string => `${unitPreamble("yard app process")}
Restart=on-failure
`;

export const renderAppDropin = (input: AppDropinInput): string => {
  const environment = Object.entries(input.environment).sort(([a], [b]) => a.localeCompare(b));
  return `[Service]
WorkingDirectory=${systemdQuote(input.workingDirectory)}
${environment.map(envLine).join("\n")}
ExecStart=
ExecStart=/bin/sh -lc ${shellSingleQuote(input.command)}
`;
};

export const renderCaddyUnit = (input: DaemonUnitInput): string =>
  renderDaemonUnit("yard caddy", input);

export const renderTunnelUnit = (input: DaemonUnitInput): string =>
  renderDaemonUnit("yard cloudflared tunnel", input);

const renderDaemonUnit = (description: string, input: DaemonUnitInput): string => {
  const args = input.args ?? [];
  const environment = Object.entries(input.environment ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const lines = [
    unitPreamble(description).trimEnd(),
    input.workingDirectory === undefined
      ? undefined
      : `WorkingDirectory=${systemdQuote(input.workingDirectory)}`,
    ...environment.map(envLine),
    `ExecStart=${[input.executable, ...args].map(systemdQuote).join(" ")}`,
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];
  return `${lines.filter((line) => line !== undefined).join("\n")}`;
};

export const appUnitName = (slug: string, processName: string): string =>
  `yard-app@${appUnitInstanceName(slug, processName)}.service`;

export const appDropinDirectoryName = (slug: string, processName: string): string =>
  `${appUnitName(slug, processName)}.d`;

export const parseSystemctlShow = (output: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    output
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );

export class Systemd extends Context.Service<
  Systemd,
  {
    readonly writeAppTemplate: () => Effect.Effect<void, PlatformError.PlatformError>;
    readonly writeAppDropin: (
      input: AppDropinInput,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
    readonly writeCaddyUnit: (
      input: DaemonUnitInput,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
    readonly writeTunnelUnit: (
      input: DaemonUnitInput,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
    readonly daemonReload: () => Effect.Effect<void, ProcessFailed>;
    readonly start: (unit: string) => Effect.Effect<void, ProcessFailed>;
    readonly stop: (unit: string) => Effect.Effect<void, ProcessFailed>;
    readonly restart: (unit: string) => Effect.Effect<void, ProcessFailed>;
    readonly enable: (unit: string) => Effect.Effect<void, ProcessFailed>;
    readonly disable: (unit: string) => Effect.Effect<void, ProcessFailed>;
    readonly isActive: (unit: string) => Effect.Effect<boolean, ProcessFailed>;
    readonly show: (unit: string) => Effect.Effect<Readonly<Record<string, string>>, ProcessFailed>;
    readonly listYardUnits: () => Effect.Effect<ReadonlyArray<string>, ProcessFailed>;
    readonly journal: (options: {
      readonly unit: string;
      readonly follow?: boolean;
      readonly lines?: number;
    }) => Effect.Effect<CommandResult, ProcessFailed>;
    readonly journalFollow: (
      options: { readonly unit: string; readonly lines?: number },
      onChunk: (chunk: Uint8Array) => Effect.Effect<void>,
    ) => Effect.Effect<void, ProcessFailed>;
    readonly enableLinger: (user?: string) => Effect.Effect<void, ProcessFailed>;
  }
>()("yard/services/Systemd") {
  static readonly layer = Layer.effect(
    Systemd,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const xdg = yield* Xdg;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const userUnitDir = Effect.fn("Systemd.userUnitDir")(function* () {
        const paths = yield* xdg.paths();
        return path.join(path.dirname(paths.configDir), "systemd", "user");
      });

      const writeUnit = Effect.fn("Systemd.writeUnit")(function* (
        relative: string,
        content: string,
      ) {
        const dir = yield* userUnitDir();
        const file = path.join(dir, relative);
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, content);
      });

      const run = Effect.fn("Systemd.run")(function* (
        command: string,
        args: ReadonlyArray<string>,
      ) {
        return yield* Effect.gen(function* () {
          const handle = yield* spawner
            .spawn(ChildProcess.make(command, [...args]))
            .pipe(Effect.scoped);
          const stdout = yield* decodeStream(handle.stdout);
          const stderr = yield* decodeStream(handle.stderr);
          const exitCode = yield* handle.exitCode;
          if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
            return yield* new ProcessFailed({
              command,
              args: [...args],
              exitCode: Number(exitCode),
              stderr,
            });
          }
          return { stdout, stderr, exitCode: Number(exitCode) };
        }).pipe(
          Effect.catch((error: PlatformError.PlatformError | ProcessFailed) =>
            "_tag" in error && error._tag === "ProcessFailed"
              ? Effect.fail(error)
              : Effect.fail(
                  new ProcessFailed({
                    command,
                    args: [...args],
                    exitCode: -1,
                    stderr: String(error),
                  }),
                ),
          ),
        );
      });

      const runStreaming = Effect.fn("Systemd.runStreaming")(function* (
        command: string,
        args: ReadonlyArray<string>,
        onChunk: (chunk: Uint8Array) => Effect.Effect<void>,
      ) {
        return yield* Effect.gen(function* () {
          const handle = yield* spawner
            .spawn(ChildProcess.make(command, [...args]))
            .pipe(Effect.scoped);
          yield* Stream.runForEach(handle.stdout, onChunk);
          const stderr = yield* decodeStream(handle.stderr);
          const exitCode = yield* handle.exitCode;
          if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
            return yield* new ProcessFailed({
              command,
              args: [...args],
              exitCode: Number(exitCode),
              stderr,
            });
          }
        }).pipe(
          Effect.catch((error: PlatformError.PlatformError | ProcessFailed) =>
            "_tag" in error && error._tag === "ProcessFailed"
              ? Effect.fail(error)
              : Effect.fail(
                  new ProcessFailed({
                    command,
                    args: [...args],
                    exitCode: -1,
                    stderr: String(error),
                  }),
                ),
          ),
        );
      });

      const systemctl = (args: ReadonlyArray<string>) => run("systemctl", ["--user", ...args]);

      return {
        writeAppTemplate: Effect.fn("Systemd.writeAppTemplate")(() =>
          writeUnit("yard-app@.service", renderAppTemplateUnit()),
        ),
        writeAppDropin: Effect.fn("Systemd.writeAppDropin")((input: AppDropinInput) =>
          writeUnit(
            path.join(appDropinDirectoryName(input.slug, input.processName), "override.conf"),
            renderAppDropin(input),
          ),
        ),
        writeCaddyUnit: Effect.fn("Systemd.writeCaddyUnit")((input: DaemonUnitInput) =>
          writeUnit("yard-caddy.service", renderCaddyUnit(input)),
        ),
        writeTunnelUnit: Effect.fn("Systemd.writeTunnelUnit")((input: DaemonUnitInput) =>
          writeUnit("yard-tunnel.service", renderTunnelUnit(input)),
        ),
        daemonReload: Effect.fn("Systemd.daemonReload")(function* () {
          yield* systemctl(["daemon-reload"]);
        }),
        start: Effect.fn("Systemd.start")(function* (unit: string) {
          yield* systemctl(["start", unit]);
        }),
        stop: Effect.fn("Systemd.stop")(function* (unit: string) {
          yield* systemctl(["stop", unit]);
        }),
        restart: Effect.fn("Systemd.restart")(function* (unit: string) {
          yield* systemctl(["restart", unit]);
        }),
        enable: Effect.fn("Systemd.enable")(function* (unit: string) {
          yield* systemctl(["enable", unit]);
        }),
        disable: Effect.fn("Systemd.disable")(function* (unit: string) {
          yield* systemctl(["disable", unit]);
        }),
        isActive: Effect.fn("Systemd.isActive")(function* (unit: string) {
          return (
            (yield* systemctl(["is-active", unit]).pipe(
              Effect.orElseSucceed(() => ({ stdout: "inactive" }) as CommandResult),
            )).stdout.trim() === "active"
          );
        }),
        show: Effect.fn("Systemd.show")(function* (unit: string) {
          const result = yield* systemctl(["show", unit]);
          return parseSystemctlShow(result.stdout);
        }),
        listYardUnits: Effect.fn("Systemd.listYardUnits")(function* () {
          const result = yield* systemctl([
            "list-units",
            "yard-*",
            "--all",
            "--plain",
            "--no-legend",
          ]);
          return result.stdout
            .split(/\r?\n/)
            .map((line) => line.trim().split(/\s+/)[0])
            .filter((unit): unit is string => unit !== undefined && unit.length > 0);
        }),
        journal: Effect.fn("Systemd.journal")(function* ({ unit, follow, lines }) {
          return yield* run("journalctl", [
            "--user",
            "-u",
            unit,
            ...(follow === true ? ["-f"] : []),
            ...(lines === undefined ? [] : ["-n", String(lines)]),
          ]);
        }),
        journalFollow: Effect.fn("Systemd.journalFollow")(function* ({ unit, lines }, onChunk) {
          yield* runStreaming(
            "journalctl",
            ["--user", "-u", unit, "-f", ...(lines === undefined ? [] : ["-n", String(lines)])],
            onChunk,
          );
        }),
        enableLinger: Effect.fn("Systemd.enableLinger")(function* (user?: string) {
          yield* run("loginctl", ["enable-linger", ...(user === undefined ? [] : [user])]);
        }),
      };
    }),
  );
}
