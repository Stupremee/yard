import { describe, expect, it } from "@effect/vitest";
import {
  CADDY_VERSION,
  CLOUDFLARED_VERSION,
  detectSupportedArch,
  downloadFor,
  isAbsolutePath,
  pathCandidates,
} from "../src/services/Binaries.ts";

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
});
