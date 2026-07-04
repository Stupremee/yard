import { describe, expect, it } from "@effect/vitest";
import {
  parseRouteDnsOutput,
  parseTunnelCreateOutput,
  parseTunnelList,
  renderTunnelConfig,
} from "../src/services/Tunnel.js";

const tunnelId = "12345678-1234-4234-9234-123456789abc";

describe("Tunnel pure helpers", () => {
  it("renders cloudflared tunnel.yml exactly as planned", () => {
    expect(
      renderTunnelConfig({
        tunnelId,
        credentialsFile: "~/.local/state/yard/tunnel-credentials.json",
        zone: "example.de",
        caddyHttpPort: 8600,
      }),
    ).toBe(`tunnel: ${tunnelId}
credentials-file: ~/.local/state/yard/tunnel-credentials.json
ingress:
  - hostname: "*.example.de"
    service: http://127.0.0.1:8600
  - service: http_status:404
`);
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
    expect(parseRouteDnsOutput("Added CNAME *.example.de which will route to this tunnel")).toBe(
      true,
    );
  });
});
