import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import {
  Binaries,
  CADDY_VERSION,
  CLOUDFLARED_VERSION,
  detectSupportedArch,
  downloadFor,
  isAbsolutePath,
  pathCandidates,
} from "../src/services/Binaries.ts";
import { StateStore } from "../src/services/StateStore.ts";
import { Xdg } from "../src/services/Xdg.ts";

const layer = Binaries.layer.pipe(
  Layer.provideMerge(StateStore.layer),
  Layer.provideMerge(Xdg.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provide(NodeServices.layer),
);

describe("Binaries pure helpers", () => {
  it("honors explicit absolute paths separately from auto", () => {
    expect(isAbsolutePath("/usr/local/bin/caddy")).toBe(true);
    expect(isAbsolutePath("relative/caddy")).toBe(false);
    expect(pathCandidates("cloudflared", "/bin:/usr/local/bin")).toEqual([
      "/bin/cloudflared",
      "/usr/local/bin/cloudflared",
    ]);
  });

  it("selects pinned caddy download URLs by architecture", () => {
    expect(detectSupportedArch("x64")).toBe("x64");
    expect(detectSupportedArch("arm64")).toBe("arm64");
    expect(detectSupportedArch("riscv64")).toBeUndefined();
    expect(downloadFor("caddy", "x64")).toMatchObject({
      version: CADDY_VERSION,
      archive: "tar.gz",
      url: `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz`,
    });
    expect(downloadFor("caddy", "arm64").url).toContain("_linux_arm64.tar.gz");
  });

  it("selects pinned cloudflared download URLs by architecture", () => {
    expect(downloadFor("cloudflared", "x64")).toMatchObject({
      version: CLOUDFLARED_VERSION,
      archive: "binary",
      url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`,
    });
    expect(downloadFor("cloudflared", "arm64").url).toContain("cloudflared-linux-arm64");
  });

  it.effect("resolves from PATH when global config does not exist yet", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const oldPath = process.env.PATH;
      const oldConfig = process.env.XDG_CONFIG_HOME;
      process.env.PATH = dir;
      process.env.XDG_CONFIG_HOME = `${dir}/config`;
      yield* fs.writeFileString(`${dir}/caddy`, "");
      yield* fs.writeFileString(`${dir}/cloudflared`, "");
      yield* fs.chmod(`${dir}/caddy`, 0o755);
      yield* fs.chmod(`${dir}/cloudflared`, 0o755);
      return yield* Effect.gen(function* () {
        const binaries = yield* Binaries;
        expect(yield* binaries.resolveAll()).toEqual({
          caddy: `${dir}/caddy`,
          cloudflared: `${dir}/cloudflared`,
        });
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(
          Effect.sync(() => {
            if (oldPath === undefined) delete process.env.PATH;
            else process.env.PATH = oldPath;
            if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = oldConfig;
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
