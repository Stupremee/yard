import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

export type EnvRules = {
  readonly link?: ReadonlyArray<string>;
  readonly copyOnce?: ReadonlyArray<string>;
};

export type LinkWorktreeInput = {
  readonly worktreeRoot: string;
  readonly primaryRoot: string;
  readonly env?: EnvRules;
};

export type EnvLinkerAction =
  | {
      readonly type: "primary-noop";
    }
  | {
      readonly type: "linked";
      readonly path: string;
      readonly source: string;
    }
  | {
      readonly type: "already-linked";
      readonly path: string;
      readonly source: string;
    }
  | {
      readonly type: "backed-up";
      readonly path: string;
      readonly backup: string;
    }
  | {
      readonly type: "copied";
      readonly path: string;
      readonly source: string;
    }
  | {
      readonly type: "already-exists";
      readonly path: string;
    }
  | {
      readonly type: "missing-source";
      readonly path: string;
      readonly source: string;
    };

const defaultLink = [".env"] as const;
const defaultCopyOnce = [".env.local"] as const;

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "reason" in error &&
  typeof error.reason === "object" &&
  error.reason !== null &&
  "_tag" in error.reason &&
  error.reason._tag === "NotFound";

const isNotSymlink = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "reason" in error &&
  typeof error.reason === "object" &&
  error.reason !== null &&
  "cause" in error.reason &&
  typeof error.reason.cause === "object" &&
  error.reason.cause !== null &&
  "code" in error.reason.cause &&
  error.reason.cause.code === "EINVAL";

const exists = (fs: FileSystem.FileSystem, path: string) =>
  fs.exists(path).pipe(Effect.orElseSucceed(() => false));

const readLinkOption = (fs: FileSystem.FileSystem, path: string) =>
  fs.readLink(path).pipe(
    Effect.map((target) => target as string | undefined),
    Effect.catch((error: PlatformError.PlatformError) =>
      isMissing(error) || isNotSymlink(error) ? Effect.void : Effect.fail(error),
    ),
  );

export class EnvLinker extends Context.Service<
  EnvLinker,
  {
    readonly linkForWorktree: (
      input: LinkWorktreeInput,
    ) => Effect.Effect<ReadonlyArray<EnvLinkerAction>, PlatformError.PlatformError>;
  }
>()("yard/services/EnvLinker") {
  static readonly layer = Layer.effect(
    EnvLinker,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const linkFile = Effect.fn("EnvLinker.linkFile")(function* (
        primaryRoot: string,
        worktreeRoot: string,
        file: string,
      ) {
        const source = path.join(primaryRoot, file);
        const destination = path.join(worktreeRoot, file);
        if (!(yield* exists(fs, source))) {
          return [{ type: "missing-source", path: destination, source }] as const;
        }

        const currentTarget = yield* readLinkOption(fs, destination);
        if (currentTarget === source) {
          return [{ type: "already-linked", path: destination, source }] as const;
        }

        const actions: Array<EnvLinkerAction> = [];
        if (currentTarget !== undefined) {
          // Destination is a symlink with a wrong (possibly dangling) target:
          // replace it. Backups only apply to regular files.
          yield* fs.remove(destination, { force: true });
        } else if (yield* exists(fs, destination)) {
          const backup = `${destination}.yard-backup`;
          yield* fs.rename(destination, backup);
          actions.push({ type: "backed-up", path: destination, backup });
        }

        yield* fs.symlink(source, destination);
        actions.push({ type: "linked", path: destination, source });
        return actions;
      });

      const copyFileOnce = Effect.fn("EnvLinker.copyFileOnce")(function* (
        primaryRoot: string,
        worktreeRoot: string,
        file: string,
      ) {
        const source = path.join(primaryRoot, file);
        const destination = path.join(worktreeRoot, file);
        if (!(yield* exists(fs, source))) {
          return { type: "missing-source", path: destination, source } as const;
        }
        if (yield* exists(fs, destination)) {
          return { type: "already-exists", path: destination } as const;
        }
        yield* fs.copyFile(source, destination);
        return { type: "copied", path: destination, source } as const;
      });

      return {
        linkForWorktree: Effect.fn("EnvLinker.linkForWorktree")(function* (
          input: LinkWorktreeInput,
        ) {
          if (input.worktreeRoot === input.primaryRoot) {
            return [{ type: "primary-noop" }];
          }
          const link = input.env?.link ?? defaultLink;
          const copyOnce = input.env?.copyOnce ?? defaultCopyOnce;
          const actions: Array<EnvLinkerAction> = [];
          for (const file of link) {
            actions.push(...(yield* linkFile(input.primaryRoot, input.worktreeRoot, file)));
          }
          for (const file of copyOnce) {
            actions.push(yield* copyFileOnce(input.primaryRoot, input.worktreeRoot, file));
          }
          return actions;
        }),
      };
    }),
  );
}
