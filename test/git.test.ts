import { describe, expect, it } from "@effect/vitest";
import { parseWorktreePorcelain } from "../src/services/Git.js";

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
