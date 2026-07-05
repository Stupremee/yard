import { describe, expect, it } from "@effect/vitest";
import { Instance } from "../src/domain/model.js";
import { selectLogProcess } from "../src/commands/logs.js";
import { shapeInstanceStatus } from "../src/commands/status.js";
import { composeUrlInfo } from "../src/commands/url.js";

describe("command info helpers", () => {
  it("composes primary and route URLs with v1 authHeaders", () => {
    expect(composeUrlInfo("repo-word", "example.de")).toEqual({
      slug: "repo-word",
      route: null,
      url: "https://repo-word.example.de",
      authHeaders: {},
    });
    expect(composeUrlInfo("repo-word", "example.de", "convex")).toEqual({
      slug: "repo-word",
      route: "convex",
      url: "https://repo-word-convex.example.de",
      authHeaders: {},
    });
  });

  it("shapes instance status from durable and live state", () => {
    const instance = new Instance({
      repoName: "repo",
      word: "word",
      worktreeRoot: "/repo/worktree",
      primaryRoot: "/repo",
      ports: { web: 3100, convex: 3101 },
      processes: ["web", "convex"],
      createdAt: "now",
      updatedAt: "now",
    });
    const status = shapeInstanceStatus({
      slug: "repo-word",
      instance,
      zone: "example.de",
      activeByProcess: { web: true, convex: false },
      showByProcess: {
        web: { LoadState: "loaded", SubState: "running" },
        convex: { LoadState: "not-found" },
      },
      caddyReachable: true,
      caddyHosts: new Set(["repo-word.example.de"]),
    });

    expect(status.processes).toEqual([
      {
        name: "convex",
        unit: "yard-app@repo-word--convex.service",
        active: false,
        loadState: "not-found",
        subState: null,
      },
      {
        name: "web",
        unit: "yard-app@repo-word--web.service",
        active: true,
        loadState: "loaded",
        subState: "running",
      },
    ]);
    expect(status.routes).toEqual([
      {
        name: "convex",
        host: "repo-word-convex.example.de",
        port: 3101,
        present: false,
      },
      {
        name: "web",
        host: "repo-word.example.de",
        port: 3100,
        present: true,
      },
    ]);
  });

  it("selects the requested, only, or routed log process", () => {
    expect(selectLogProcess(["web", "worker"], { web: 3100 }, "worker")).toBe("worker");
    expect(selectLogProcess(["worker"], {}, undefined)).toBe("worker");
    expect(selectLogProcess(["api", "web"], { web: 3100 }, undefined)).toBe("web");
    expect(selectLogProcess(["api", "worker"], { api: 3100 }, undefined)).toBe("api");
    expect(selectLogProcess(["web"], { web: 3100 }, "typo")).toMatchObject({
      _tag: "ConfigInvalid",
      path: "--process",
    });
  });
});
