import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import { StateLocked } from "../domain/errors.js";
import { Xdg } from "./Xdg.js";

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
    return Number.parseInt(yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => "")), 10);
  });

const acquireLockFile = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  file: string,
): Effect.Effect<void, StateLocked> =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.orDie);
    const acquired = yield* Effect.scoped(
      fs.open(file, { flag: "wx", mode: 0o600 }).pipe(
        Effect.flatMap((handle) => handle.writeAll(new TextEncoder().encode(`${process.pid}\n`))),
        Effect.as(true),
        Effect.catch((error) =>
          isAlreadyExists(error) ? Effect.succeed(false) : Effect.die(error),
        ),
      ),
    );
    if (acquired) {
      return;
    }
    const pid = yield* readLockPid(fs, file);
    if (Number.isFinite(pid) && isPidAlive(pid)) {
      return yield* new StateLocked({ path: file, pid });
    }
    yield* fs.remove(file, { force: true }).pipe(Effect.orDie);
    yield* acquireLockFile(fs, path, file);
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
            () => fs.remove(paths.lockFile, { force: true }).pipe(Effect.orDie),
          );
        }),
      };
    }),
  );
}
