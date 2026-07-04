import { describe, expect, it } from "@effect/vitest";
import { GlobalConfig, Instance, ProcessSpec, RepoConfig, RouteSpec } from "../src/domain/model.js";
import {
  buildPortPlan,
  buildProcessEnvironment,
  lifecycleSummary,
  summaryLines,
} from "../src/commands/up.js";

const globalConfig = new GlobalConfig({
  version: 1,
  zone: "example.test",
  tunnel: {
    name: "yard",
    id: "tunnel-id",
    credentialsFile: "/tmp/credentials.json",
  },
});

describe("command lifecycle helpers", () => {
  it("builds a stable port plan with the routed process mapped to web", () => {
    const config = new RepoConfig({
      processes: {
        convex: new ProcessSpec({ command: "convex dev" }),
        app: new ProcessSpec({ command: "vp run dev", route: true }),
      },
      routes: {
        site: new RouteSpec({
          process: "convex",
          portEnv: "CONVEX_SITE_PORT",
          urlEnv: "VITE_CONVEX_SITE_URL",
        }),
        api: new RouteSpec({
          process: "convex",
          portEnv: "CONVEX_CLOUD_PORT",
          urlEnv: "VITE_CONVEX_URL",
        }),
      },
    });

    expect(buildPortPlan(config)).toEqual({
      routedProcess: "app",
      routedPortKey: "web",
      routePorts: [
        {
          route: "api",
          process: "convex",
          portEnv: "CONVEX_CLOUD_PORT",
          urlEnv: "VITE_CONVEX_URL",
        },
        {
          route: "site",
          process: "convex",
          portEnv: "CONVEX_SITE_PORT",
          urlEnv: "VITE_CONVEX_SITE_URL",
        },
      ],
    });
  });

  it("injects the routed port and every extra route env into every process", () => {
    const plan = buildPortPlan(
      new RepoConfig({
        processes: {
          web: new ProcessSpec({ command: "vp run dev", route: true }),
          convex: new ProcessSpec({ command: "convex dev" }),
        },
        routes: {
          convex: new RouteSpec({
            process: "convex",
            portEnv: "CONVEX_CLOUD_PORT",
            urlEnv: "VITE_CONVEX_URL",
          }),
        },
      }),
    );

    expect(
      buildProcessEnvironment(globalConfig, "project-word", { web: 3100, convex: 3101 }, plan),
    ).toEqual({
      DEV_HOST: "project-word.example.test",
      PORT: 3100,
      CONVEX_CLOUD_PORT: 3101,
      VITE_CONVEX_URL: "https://project-word-convex.example.test",
    });
  });

  it("creates stable summary JSON and human lines", () => {
    const instance = new Instance({
      repoName: "project",
      word: "word",
      worktreeRoot: "/repo/worktree",
      primaryRoot: "/repo/main",
      ports: { web: 3100, convex: 3101 },
      processes: ["convex", "web"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const summary = lifecycleSummary({
      command: "up",
      slug: "project-word",
      globalConfig,
      instance,
      ready: true,
    });

    expect(summary).toEqual({
      command: "up",
      slug: "project-word",
      url: "https://project-word.example.test",
      ports: { web: 3100, convex: 3101 },
      units: ["yard-app@project-word--convex.service", "yard-app@project-word--web.service"],
      envActions: [],
      ready: true,
    });
    expect(summaryLines(summary)).toEqual([
      "up: project-word",
      "url: https://project-word.example.test",
      "ports: web=3100 convex=3101",
      "units: yard-app@project-word--convex.service yard-app@project-word--web.service",
      "ready: yes",
    ]);
  });
});
