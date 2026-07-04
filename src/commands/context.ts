import * as Effect from "effect/Effect";
import { ConfigInvalid, NotAGitRepo } from "../domain/errors.js";
import { Instance } from "../domain/model.js";
import { composeInstanceSlug, slugifyRepoName } from "../domain/slug.js";
import { pickWord } from "../domain/wordlist.js";
import { Git } from "../services/Git.js";
import { StateStore } from "../services/StateStore.js";

export interface InstanceContext {
  readonly slug: string;
  readonly repoName: string;
  readonly word: string | null;
  readonly worktreeRoot: string;
  readonly primaryRoot: string;
  readonly isPrimary: boolean;
}

const basename = (path: string) => path.replace(/\/+$/, "").split("/").at(-1) ?? path;

export const resolveContext = Effect.fn("commands.context.resolveContext")(function* () {
  const cwd = process.cwd();
  const git = yield* Git;
  const store = yield* StateStore;
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
  const state = yield* store.loadInstances();
  const persisted = Object.entries(state.instances).find(
    ([, instance]) => instance.worktreeRoot === worktreeRoot,
  );
  const word = isPrimary
    ? null
    : (persisted?.[1].word ??
      (yield* pickWord((candidate) =>
        Object.keys(state.instances).includes(composeInstanceSlug(repoName, candidate)),
      )));
  const slug = composeInstanceSlug(repoName, word);

  return {
    slug,
    repoName,
    word,
    worktreeRoot,
    primaryRoot,
    isPrimary,
  } satisfies InstanceContext;
});

export const lookupInstance = Effect.fn("commands.context.lookupInstance")(function* (
  slug: string,
) {
  const store = yield* StateStore;
  const state = yield* store.loadInstances();
  const instance = state.instances[slug];
  if (instance === undefined) {
    return yield* new ConfigInvalid({
      path: "instances.json",
      error: new Error(`Unknown yard instance: ${slug}`),
    });
  }
  return instance satisfies Instance;
});
