import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { parseWorktreePorcelain } from "../src/services/Git.ts";
import { Git } from "../src/services/Git.ts";

const gitLayer = Git.layer.pipe(Layer.provide(NodeServices.layer));

describe("parseWorktreePorcelain", () => {
  it("identifies primary and linked worktrees", () => {
    const parsed = parseWorktreePorcelain(`worktree /repo
HEAD abc
branch refs/heads/main

worktree /repo-linked
HEAD def
branch refs/heads/feature

`);
    expect(parsed).toEqual([
      {
        path: "/repo",
        head: "abc",
        branch: "refs/heads/main",
        detached: false,
        bare: false,
        isPrimary: true,
      },
      {
        path: "/repo-linked",
        head: "def",
        branch: "refs/heads/feature",
        detached: false,
        bare: false,
        isPrimary: false,
      },
    ]);
  });

  it("handles detached and bare entries", () => {
    const parsed = parseWorktreePorcelain(`worktree /repo.git
bare

worktree /repo-detached
HEAD abc
detached

`);
    expect(parsed[0]).toMatchObject({ path: "/repo.git", bare: true, isPrimary: false });
    expect(parsed[1]).toMatchObject({ path: "/repo-detached", detached: true, isPrimary: false });
  });
});

describe("Git service", () => {
  it.effect("resolves the current repository root", () =>
    Effect.gen(function* () {
      const git = yield* Git;
      expect(yield* git.repoRoot(process.cwd())).toBe(process.cwd());
    }).pipe(Effect.provide(gitLayer)),
  );
});
