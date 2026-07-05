import * as Effect from "effect/Effect";
import { InstanceNotFound, NoInstanceForWorktree, NotAGitRepo } from "../domain/errors.ts";
import { Instance } from "../domain/model.ts";
import {
  composeInstanceSlug,
  primaryHostname,
  routeHostname,
  slugifyRepoName,
} from "../domain/slug.ts";
import { pickWord } from "../domain/wordlist.ts";
import { Git } from "../services/Git.ts";
import { StateStore } from "../services/StateStore.ts";

export interface InstanceContext {
  readonly slug: string;
  readonly repoName: string;
  readonly word: string | null;
  readonly worktreeRoot: string;
  readonly primaryRoot: string;
  readonly isPrimary: boolean;
}

const basename = (path: string) => path.replace(/\/+$/, "").split("/").at(-1) ?? path;

const resolveGitContext = Effect.fn("commands.context.resolveGitContext")(function* () {
  const cwd = process.cwd();
  const git = yield* Git;
  const worktreeRoot = yield* git
    .repoRoot(cwd)
    .pipe(
      Effect.mapError((error) =>
        error._tag === "NotAGitRepo" ? error : new NotAGitRepo({ cwd, message: error.stderr }),
      ),
    );
  const worktrees = yield* git
    .worktrees(worktreeRoot)
    .pipe(
      Effect.mapError((error) =>
        error._tag === "NotAGitRepo" ? error : new NotAGitRepo({ cwd, message: error.stderr }),
      ),
    );
  const primary = worktrees.find((worktree) => worktree.isPrimary) ?? worktrees[0];
  if (primary === undefined) {
    return yield* new NotAGitRepo({ cwd, message: "No git worktrees found" });
  }

  const primaryRoot = primary.path;
  const isPrimary = worktreeRoot === primaryRoot;
  const repoName = slugifyRepoName(basename(primaryRoot));
  return {
    repoName,
    worktreeRoot,
    primaryRoot,
    isPrimary,
  };
});

export const resolveContext = Effect.fn("commands.context.resolveContext")(function* () {
  const base = yield* resolveGitContext();
  const store = yield* StateStore;
  const state = yield* store.loadInstances();
  const persisted = Object.entries(state.instances).find(
    ([, instance]) => instance.worktreeRoot === base.worktreeRoot,
  );
  if (base.isPrimary) {
    return {
      ...base,
      slug: composeInstanceSlug(base.repoName, null),
      word: null,
    } satisfies InstanceContext;
  }
  if (persisted === undefined) {
    return yield* new NoInstanceForWorktree({ worktreeRoot: base.worktreeRoot });
  }
  return {
    ...base,
    slug: persisted[0],
    word: persisted[1].word,
  } satisfies InstanceContext;
});

export const resolveContextForUp = Effect.fn("commands.context.resolveContextForUp")(function* () {
  const base = yield* resolveGitContext();
  const store = yield* StateStore;
  const state = yield* store.loadInstances();
  const persisted = Object.entries(state.instances).find(
    ([, instance]) => instance.worktreeRoot === base.worktreeRoot,
  );
  const word = base.isPrimary
    ? null
    : (persisted?.[1].word ??
      (yield* pickWord((candidate) =>
        hostnameCollides(state.instances, composeInstanceSlug(base.repoName, candidate)),
      )));
  return {
    ...base,
    slug: persisted?.[0] ?? composeInstanceSlug(base.repoName, word),
    word,
  } satisfies InstanceContext;
});

const hostnameCollides = (instances: Readonly<Record<string, Instance>>, slug: string): boolean => {
  const host = primaryHostname(slug);
  for (const [existingSlug, instance] of Object.entries(instances)) {
    if (primaryHostname(existingSlug) === host) return true;
    for (const route of Object.keys(instance.ports)) {
      if (route !== instance.routedProcess && routeHostname(existingSlug, route) === host) {
        return true;
      }
    }
  }
  return false;
};

export const lookupInstance = Effect.fn("commands.context.lookupInstance")(function* (
  slug: string,
) {
  const store = yield* StateStore;
  const state = yield* store.loadInstances();
  const instance = state.instances[slug];
  if (instance === undefined) {
    return yield* new InstanceNotFound({ slug });
  }
  return instance satisfies Instance;
});
