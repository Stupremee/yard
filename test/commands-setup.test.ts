import { describe, expect, it } from "@effect/vitest";
import { buildInitConfig } from "../src/commands/init.ts";
import { doctorFailed, formatDoctorChecks, type DoctorCheck } from "../src/commands/doctor.ts";
import { viteConfigSnippet } from "../src/commands/printViteConfig.ts";

describe("print-vite-config", () => {
  it("prints the yard Vite server snippet", () => {
    expect(viteConfigSnippet).toContain('host: "127.0.0.1"');
    expect(viteConfigSnippet).toContain("port: Number(process.env.PORT)");
    expect(viteConfigSnippet).toContain("strictPort: true");
    expect(viteConfigSnippet).toContain("allowedHosts: [process.env.DEV_HOST]");
    expect(viteConfigSnippet).toContain('protocol: "wss"');
    expect(viteConfigSnippet).toContain("host: process.env.DEV_HOST");
    expect(viteConfigSnippet).toContain("clientPort: 443");
    expect(viteConfigSnippet).toContain("PORT and DEV_HOST");
  });
});

describe("doctor result shaping", () => {
  it("formats checks as a checklist and reports failures", () => {
    const checks: ReadonlyArray<DoctorCheck> = [
      { name: "binaries", ok: true, detail: "present" },
      { name: "yard-tunnel active", ok: false, detail: "inactive" },
    ];

    expect(formatDoctorChecks(checks)).toEqual([
      "✓ binaries: present",
      "✗ yard-tunnel active: inactive",
    ]);
    expect(doctorFailed(checks)).toBe(true);
  });

  it("accepts all-passing checks", () => {
    expect(doctorFailed([{ name: "Caddy admin API", ok: true, detail: "reachable" }])).toBe(false);
  });
});

describe("init config", () => {
  it("sets v1 public auth defaults", () => {
    const config = buildInitConfig({
      zone: "example.test",
      tunnelId: "tunnel-id",
      credentialsFile: "/state/tunnel-credentials.json",
    });

    expect(config.zone).toBe("example.test");
    expect(config.auth.mode).toBe("public");
    expect(config.caddyHttpPort).toBe(8600);
    expect(config.caddyAdminPort).toBe(2019);
    expect(config.portRange).toEqual([3100, 3999]);
    expect(config.tunnel).toEqual({
      name: "yard",
      id: "tunnel-id",
      credentialsFile: "/state/tunnel-credentials.json",
    });
  });

  it("preserves customized settings when building config from an existing init", () => {
    const existing = buildInitConfig({
      zone: "old.test",
      tunnelId: "old-tunnel",
      credentialsFile: "/old/credentials.json",
    });
    const next = buildInitConfig({
      zone: "new.test",
      tunnelId: "new-tunnel",
      credentialsFile: "/new/credentials.json",
      existing: {
        ...existing,
        caddyHttpPort: 8700,
        caddyAdminPort: 2020,
        portRange: [4100, 4199],
      },
    });

    expect(next.zone).toBe("new.test");
    expect(next.tunnel.id).toBe("new-tunnel");
    expect(next.caddyHttpPort).toBe(8700);
    expect(next.caddyAdminPort).toBe(2020);
    expect(next.portRange).toEqual([4100, 4199]);
  });
});
