import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { StateLocked } from "../domain/errors.ts";
import { Xdg } from "./Xdg.ts";

export const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const isAlreadyExists = (error: PlatformError.PlatformError) =>
  error.reason._tag === "AlreadyExists";

const readLockPid = (fs: FileSystem.FileSystem, file: string) =>
  Effect.gen(function* () {
    const text = (yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))).trim();
    if (!/^[0-9]+$/.test(text)) {
      return undefined;
    }
    const pid = Number.parseInt(text, 10);
    return Number.isFinite(pid) ? pid : undefined;
  });

const staleLockPath = (path: Path.Path, file: string) =>
  path.join(path.dirname(file), `${path.basename(file)}.stale-${process.pid}`);

export const lockRetryDelayMillis = 150;
export const lockRetryTimeoutMillis = 3_000;

type LockAttempt =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly pid?: number };

const tryAcquireLockFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  file: string,
): Effect.Effect<LockAttempt> =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.orDie);
    const acquired = yield* Effect.scoped(
      fs.open(file, { flag: "wx", mode: 0o600 }).pipe(
        Effect.flatMap((handle) =>
          handle.writeAll(new TextEncoder().encode(`${process.pid}\n`)).pipe(
            Effect.as(true),
            Effect.tapError(() => fs.remove(file, { force: true }).pipe(Effect.orDie)),
          ),
        ),
        Effect.catch((error) =>
          isAlreadyExists(error) ? Effect.succeed(false) : Effect.die(error),
        ),
      ),
    );
    if (acquired) {
      return { acquired: true } as const;
    }
    const pid = yield* readLockPid(fs, file);
    if (pid !== undefined && isPidAlive(pid)) {
      return { acquired: false, pid } as const;
    }
    const beforeRenamePid = yield* readLockPid(fs, file);
    if (beforeRenamePid === pid) {
      const staleFile = staleLockPath(path, file);
      yield* fs.remove(staleFile, { force: true }).pipe(Effect.orDie);
      const renamed = yield* fs.rename(file, staleFile).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (renamed) {
        yield* fs.remove(staleFile, { force: true }).pipe(Effect.orDie);
      }
    }
    return pid === undefined ? ({ acquired: false } as const) : ({ acquired: false, pid } as const);
  });

const acquireLockFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  file: string,
): Effect.Effect<void, StateLocked> =>
  Effect.gen(function* () {
    // Another yard command usually finishes quickly, so poll briefly before failing:
    // parallel `yard up` in different worktrees should queue, not error.
    let waited = 0;
    while (true) {
      const attempt = yield* tryAcquireLockFile(fs, path, file);
      if (attempt.acquired) {
        return;
      }
      if (waited >= lockRetryTimeoutMillis) {
        return yield* new StateLocked({ path: file, pid: attempt.pid });
      }
      yield* Effect.sleep(`${lockRetryDelayMillis} millis`);
      waited += lockRetryDelayMillis;
    }
  });

export class Lock extends Context.Service<
  Lock,
  {
    readonly withMutationLock: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | StateLocked, R>;
  }
>()("yard/services/Lock") {
  static readonly layer = Layer.effect(
    Lock,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const xdg = yield* Xdg;
      const paths = yield* xdg.paths();
      return {
        withMutationLock: Effect.fn("Lock.withMutationLock")(function* <A, E, R>(
          effect: Effect.Effect<A, E, R>,
        ) {
          return yield* Effect.acquireUseRelease(
            acquireLockFile(fs, path, paths.lockFile),
            () => effect,
            () =>
              Effect.gen(function* () {
                const pid = yield* readLockPid(fs, paths.lockFile);
                if (pid === process.pid) {
                  yield* fs.remove(paths.lockFile, { force: true }).pipe(Effect.orDie);
                }
              }),
          );
        }),
      };
    }),
  );
}
