import { describe, expect, it } from "@effect/vitest";
import {
  appDropinDirectoryName,
  appUnitName,
  parseSystemctlShow,
  renderAppDropin,
  renderAppTemplateUnit,
  renderCaddyUnit,
  renderTunnelUnit,
} from "../src/services/Systemd.ts";

describe("Systemd unit rendering", () => {
  it("renders the app template without install section", () => {
    expect(renderAppTemplateUnit()).toMatchInlineSnapshot(`
      "[Unit]
      Description=yard app process

      [Service]

      Restart=on-failure
      "
    `);
    expect(renderAppTemplateUnit()).not.toContain("[Install]");
  });

  it("renders per-instance dropins with cwd, env, and shell command", () => {
    const output = renderAppDropin({
      slug: "repo feature",
      processName: "web/api",
      command: "echo '$PORT' && vp run dev",
      workingDirectory: "/srv/dev/repo worktree",
      environment: {
        PORT: 3100,
        DEV_HOST: "repo.example.de",
        CONVEX_CLOUD_PORT: 3210,
        VITE_CONVEX_URL: "https://repo-convex.example.de",
      },
    });

    expect(output).toContain("WorkingDirectory=/srv/dev/repo worktree");
    expect(output).not.toContain('WorkingDirectory="/srv/dev/repo worktree"');
    expect(output).toContain('Environment="CONVEX_CLOUD_PORT=3210"');
    expect(output).toContain('Environment="DEV_HOST=repo.example.de"');
    expect(output).toContain('Environment="PORT=3100"');
    expect(output).toContain('Environment="VITE_CONVEX_URL=https://repo-convex.example.de"');
    expect(output).toContain("ExecStart=");
    expect(output).toContain("ExecStart=/bin/sh -lc 'echo '\\''$PORT'\\'' && vp run dev'");
  });

  it("escapes systemd percent specifiers in commands, environment, and working directories", () => {
    const output = renderAppDropin({
      slug: "repo",
      processName: "web",
      command: "date +%s && printf '%s\\n' ok",
      workingDirectory: "/srv/dev/repo%h",
      environment: {
        PORT: 3100,
        FORMAT: "%s",
      },
    });

    expect(output).toContain("WorkingDirectory=/srv/dev/repo%%h");
    expect(output).toContain('Environment="FORMAT=%%s"');
    expect(output).toContain("ExecStart=/bin/sh -lc 'date +%%s && printf '\\''%%s\\n'\\'' ok'");
  });

  it("escapes app unit instance names via slug helper", () => {
    expect(appUnitName("Repo Name", "web/api")).toBe("yard-app@repo-name--web-api.service");
    expect(appDropinDirectoryName("Repo Name", "web/api")).toBe(
      "yard-app@repo-name--web-api.service.d",
    );
  });

  it("renders daemon units with install section", () => {
    expect(
      renderCaddyUnit({
        executable: "/usr/bin/caddy",
        args: ["run", "--config", "/state/caddy.json"],
        execStartPre: [
          {
            executable: "/usr/bin/node",
            args: ["/opt/yard/bin.mjs", "caddy", "render"],
            ignoreFailure: true,
          },
        ],
        environment: { X: 'quote"back\\slash' },
      }),
    ).toMatchInlineSnapshot(`
      "[Unit]
      Description=yard caddy

      [Service]
      Environment="X=quote\\"back\\\\slash"
      ExecStartPre=-"/usr/bin/node" "/opt/yard/bin.mjs" "caddy" "render"
      ExecStart="/usr/bin/caddy" "run" "--config" "/state/caddy.json"
      Restart=on-failure

      [Install]
      WantedBy=default.target
      "
    `);
    expect(renderTunnelUnit({ executable: "/usr/bin/cloudflared" })).toContain(
      "WantedBy=default.target",
    );
  });

  it("escapes daemon unit percent specifiers", () => {
    expect(
      renderCaddyUnit({
        executable: "/bin/date",
        args: ["+%s"],
        workingDirectory: "/tmp/%h",
        environment: { FORMAT: "%Y" },
      }),
    ).toContain("WorkingDirectory=/tmp/%%h");
  });
});

describe("parseSystemctlShow", () => {
  it("keeps values after the first equals sign", () => {
    expect(
      parseSystemctlShow("Id=yard-app@repo--web.service\nEnvironment=A=B C=D\nEmpty=\n"),
    ).toEqual({
      Id: "yard-app@repo--web.service",
      Environment: "A=B C=D",
      Empty: "",
    });
  });
});
