import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { NotAGitRepo, ProcessFailed } from "../domain/errors.js";

export type WorktreeInfo = {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly isPrimary: boolean;
};

type ParsedWorktree = {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
};

const decodeStream = Effect.fn("Git.decodeStream")(function* (
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

const pushWorktree = (
  entries: Array<ParsedWorktree>,
  current: Partial<ParsedWorktree> | undefined,
) => {
  if (current?.path === undefined) {
    return;
  }
  const entry: ParsedWorktree = {
    path: current.path,
    detached: current.detached ?? false,
    bare: current.bare ?? false,
  };
  if (current.head !== undefined) {
    entry.head = current.head;
  }
  if (current.branch !== undefined) {
    entry.branch = current.branch;
  }
  entries.push(entry);
};

export const parseWorktreePorcelain = (input: string): ReadonlyArray<WorktreeInfo> => {
  const entries: Array<ParsedWorktree> = [];
  let current: Partial<ParsedWorktree> | undefined;
  for (const line of input.split(/\r?\n/)) {
    if (line.length === 0) {
      pushWorktree(entries, current);
      current = undefined;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") {
      current = { path: value, detached: false, bare: false };
    } else if (current !== undefined && key === "HEAD") {
      current.head = value;
    } else if (current !== undefined && key === "branch") {
      current.branch = value;
    } else if (current !== undefined && key === "detached") {
      current.detached = true;
    } else if (current !== undefined && key === "bare") {
      current.bare = true;
    }
  }
  pushWorktree(entries, current);
  return entries.map((entry, index) => ({ ...entry, isPrimary: index === 0 && !entry.bare }));
};

export class Git extends Context.Service<
  Git,
  {
    readonly isInsideWorkTree: (cwd: string) => Effect.Effect<boolean>;
    readonly repoRoot: (cwd: string) => Effect.Effect<string, NotAGitRepo | ProcessFailed>;
    readonly worktrees: (
      cwd: string,
    ) => Effect.Effect<ReadonlyArray<WorktreeInfo>, NotAGitRepo | ProcessFailed>;
  }
>()("yard/services/Git") {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const gitString = Effect.fn("Git.gitString")(function* (
        args: ReadonlyArray<string>,
        cwd?: string,
      ) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const command =
              cwd === undefined
                ? ChildProcess.make("git", [...args])
                : ChildProcess.make("git", [...args]).pipe(ChildProcess.setCwd(cwd));
            const handle = yield* spawner.spawn(command);
            const stdout = yield* decodeStream(handle.stdout).pipe(
              Effect.mapError((error) => ({ error })),
            );
            const stderr = yield* decodeStream(handle.stderr).pipe(
              Effect.mapError((error) => ({ error })),
            );
            const exitCode = yield* handle.exitCode.pipe(Effect.mapError((error) => ({ error })));
            if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
              return yield* new ProcessFailed({
                command: "git",
                args: [...args],
                cwd,
                exitCode: Number(exitCode),
                stderr,
              });
            }
            return stdout.trim();
          }),
        );
      });
      const gitStringSafe = (args: ReadonlyArray<string>, cwd: string) =>
        gitString(args, cwd).pipe(
          Effect.mapError((error) =>
            "stderr" in error
              ? error
              : new ProcessFailed({
                  command: "git",
                  args: [...args],
                  cwd,
                  exitCode: -1,
                  stderr: String(error),
                }),
          ),
        );
      return {
        isInsideWorkTree: Effect.fn("Git.isInsideWorkTree")(function* (cwd: string) {
          return (
            (yield* gitStringSafe(["rev-parse", "--is-inside-work-tree"], cwd).pipe(
              Effect.orElseSucceed(() => "false"),
            )) === "true"
          );
        }),
        repoRoot: Effect.fn("Git.repoRoot")(function* (cwd: string) {
          const inside = yield* gitStringSafe(["rev-parse", "--is-inside-work-tree"], cwd).pipe(
            Effect.mapError((error) => new NotAGitRepo({ cwd, message: error.stderr })),
          );
          if (inside !== "true") {
            return yield* new NotAGitRepo({ cwd, message: `rev-parse returned ${inside}` });
          }
          return yield* gitStringSafe(["rev-parse", "--show-toplevel"], cwd);
        }),
        worktrees: Effect.fn("Git.worktrees")(function* (cwd: string) {
          const root = yield* gitStringSafe(["rev-parse", "--show-toplevel"], cwd).pipe(
            Effect.mapError((error) => new NotAGitRepo({ cwd, message: error.stderr })),
          );
          const output = yield* gitStringSafe(["worktree", "list", "--porcelain"], root);
          return parseWorktreePorcelain(output);
        }),
      };
    }),
  );
}
