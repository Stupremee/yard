import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { GlobalConfig, Instance, ProcessSpec, RepoConfig, RouteSpec } from "../src/domain/model.ts";
import {
  allocatePorts,
  buildPortPlan,
  buildProcessEnvironment,
  lifecycleSummary,
  summaryLines,
} from "../src/commands/up.ts";
import { Ports } from "../src/services/Ports.ts";
import { StateStore } from "../src/services/StateStore.ts";
import { Xdg } from "../src/services/Xdg.ts";

const globalConfig = new GlobalConfig({
  version: 1,
  zone: "example.test",
  tunnel: {
    name: "yard",
    id: "tunnel-id",
    credentialsFile: "/tmp/credentials.json",
  },
});

const withTempXdg = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const oldConfig = process.env.XDG_CONFIG_HOME;
    const oldState = process.env.XDG_STATE_HOME;
    const oldData = process.env.XDG_DATA_HOME;
    process.env.XDG_CONFIG_HOME = `${dir}/config`;
    process.env.XDG_STATE_HOME = `${dir}/state`;
    process.env.XDG_DATA_HOME = `${dir}/data`;
    return yield* effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
          else process.env.XDG_CONFIG_HOME = oldConfig;
          if (oldState === undefined) delete process.env.XDG_STATE_HOME;
          else process.env.XDG_STATE_HOME = oldState;
          if (oldData === undefined) delete process.env.XDG_DATA_HOME;
          else process.env.XDG_DATA_HOME = oldData;
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const portLayer = Ports.layer.pipe(
  Layer.provideMerge(StateStore.layer),
  Layer.provideMerge(Xdg.layer),
  Layer.provide(NodeServices.layer),
);

describe("command lifecycle helpers", () => {
  it("builds a stable port plan keyed by the routed process name", () => {
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

  it.effect("allocates distinct ports for a fresh instance with extra routes", () =>
    withTempXdg(
      Effect.gen(function* () {
        const store = yield* StateStore;
        yield* store.saveGlobalConfig(
          new GlobalConfig({
            ...globalConfig,
            portRange: [3100, 3105],
          }),
        );
        const config = new RepoConfig({
          processes: {
            web: new ProcessSpec({ command: "vp run dev", route: true }),
            convex: new ProcessSpec({ command: "convex dev" }),
          },
          routes: {
            convex: new RouteSpec({
              process: "convex",
              portEnv: "CONVEX_CLOUD_PORT",
            }),
            "convex-site": new RouteSpec({
              process: "convex",
              portEnv: "CONVEX_SITE_PORT",
            }),
          },
        });

        const allocated = yield* allocatePorts("yard", config, globalConfig, undefined);
        expect(Object.values(allocated).sort()).toEqual([3100, 3101, 3102]);
      }).pipe(Effect.provide(portLayer)),
    ),
  );

  it("creates stable summary JSON and human lines", () => {
    const instance = new Instance({
      repoName: "project",
      word: "word",
      worktreeRoot: "/repo/worktree",
      primaryRoot: "/repo/main",
      ports: { web: 3100, convex: 3101 },
      processes: ["convex", "web"],
      routedProcess: "web",
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
