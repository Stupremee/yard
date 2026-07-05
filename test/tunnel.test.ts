import { describe, expect, it } from "@effect/vitest";
import {
  expandHome,
  parseRouteDnsOutput,
  parseTunnelCreateOutput,
  parseTunnelList,
  renderTunnelConfig,
} from "../src/services/Tunnel.ts";

const tunnelId = "12345678-1234-4234-9234-123456789abc";

describe("Tunnel pure helpers", () => {
  it("renders cloudflared tunnel.yml exactly as planned", () => {
    expect(
      renderTunnelConfig({
        tunnelId,
        credentialsFile: "~/.local/state/yard/tunnel-credentials.json",
        hostnames: ["app.example.de", "app-api.example.de"],
        caddyHttpPort: 8600,
      }),
    ).toBe(`tunnel: ${tunnelId}
credentials-file: ~/.local/state/yard/tunnel-credentials.json
ingress:
  - hostname: "app-api.example.de"
    service: http://127.0.0.1:8600
  - hostname: "app.example.de"
    service: http://127.0.0.1:8600
  - service: http_status:404
`);
  });

  it("renders a valid 404-only tunnel config with no hostnames", () => {
    expect(
      renderTunnelConfig({
        tunnelId,
        credentialsFile: "/state/tunnel-credentials.json",
        hostnames: [],
        caddyHttpPort: 8600,
      }),
    ).toBe(`tunnel: ${tunnelId}
credentials-file: /state/tunnel-credentials.json
ingress:
  - service: http_status:404
`);
  });

  it("dedupes and sorts tunnel ingress hostnames", () => {
    expect(
      renderTunnelConfig({
        tunnelId,
        credentialsFile: "/state/tunnel-credentials.json",
        hostnames: ["z.example.test", "a.example.test", "z.example.test"],
        caddyHttpPort: 8600,
      }),
    ).toContain(`  - hostname: "a.example.test"
    service: http://127.0.0.1:8600
  - hostname: "z.example.test"`);
  });

  it("expands home-directory credentials paths before writing cloudflared config", () => {
    const oldHome = process.env.HOME;
    process.env.HOME = "/home/tester";
    try {
      expect(expandHome("~/.local/state/yard/tunnel-credentials.json")).toBe(
        "/home/tester/.local/state/yard/tunnel-credentials.json",
      );
      expect(expandHome("/tmp/credentials.json")).toBe("/tmp/credentials.json");
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it("parses tunnel create output with UUID and credentials path", () => {
    expect(
      parseTunnelCreateOutput(
        `Tunnel credentials written to /home/stu/.cloudflared/${tunnelId}.json
Created tunnel yard with id ${tunnelId}`,
      ),
    ).toEqual({
      id: tunnelId,
      credentialsFile: `/home/stu/.cloudflared/${tunnelId}.json`,
    });
  });

  it("handles already-exists create output through tunnel list parsing", () => {
    expect(
      parseTunnelCreateOutput("failed to create tunnel: tunnel with name yard already exists"),
    ).toBe("already-exists");
    expect(
      parseTunnelList(`ID                                   NAME   CREATED              CONNECTIONS
${tunnelId} yard   2026-07-04T00:00:00Z  1xord01`),
    ).toEqual([{ id: tunnelId, name: "yard" }]);
  });

  it("recognizes route dns success output", () => {
    expect(parseRouteDnsOutput("Added CNAME app.example.de which will route to this tunnel")).toBe(
      true,
    );
  });
});
