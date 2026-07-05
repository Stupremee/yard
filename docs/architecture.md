# Architecture

## Request chain

```text
https://<repo>.<zone>
  → Cloudflare edge        TLS; wildcard DNS *.<zone> CNAME → <tunnel-id>.cfargotunnel.com
  → cloudflared            yard-tunnel.service; ONE static wildcard ingress →
                           http://127.0.0.1:<caddyHttpPort>  (default 8600)
  → Caddy                  yard-caddy.service; HTTP on 127.0.0.1:<caddyHttpPort>,
                           admin API on 127.0.0.1:<caddyAdminPort> (default 2019);
                           routes by Host header
  → app process            yard-app@<slug>--<proc>.service; 127.0.0.1:<port>
```

The tunnel config is static — a single `*.<zone>` ingress pointing at Caddy — and
is never touched by per-instance commands. All per-instance routing lives in
Caddy. `up`, `down`, and `rm` only ever touch systemd units and the Caddy config;
they never reconfigure cloudflared.

## systemd unit layout

All units are **user** units under `~/.config/systemd/user/`.

### App processes

- **`yard-app@.service`** — a template unit (`Restart=on-failure`), written once.
- Each process instance is `yard-app@<slug>--<proc>.service`, where
  `<slug>--<proc>` is systemd-escaped (e.g. `myrepo--web`).
- Per-instance settings come from a drop-in at
  `yard-app@<slug>--<proc>.service.d/override.conf`, regenerated on each `up`:
  `WorkingDirectory`, `Environment=` lines (`PORT`, `DEV_HOST`, route ports/URLs),
  and `ExecStart=/bin/sh -lc '<command>'`.
- App units have **no `[Install]`** — they are never enabled and never autostart
  on boot. yard starts them explicitly on `up`.
- The drop-in is content-addressed: `up` rewrites it and restarts the unit only
  when the rendered content actually changes.

### Daemons

- **`yard-caddy.service`** and **`yard-tunnel.service`** are concrete units with
  `Restart=on-failure`, `WantedBy=default.target` (enabled), and linger, so they
  come back after logout and reboot.
- `yard-caddy.service` runs `caddy run --config <stateDir>/caddy.json` and has an
  `ExecStartPre=-<yard> caddy render` line. The `-` means "ignore failure". On
  every (re)start Caddy first regenerates `caddy.json` from yard's own state, so
  runtime and file can never drift.

### render convergence

`caddy render` derives each instance's route from its live systemd state:

- **After a reboot**, app units are not enabled, so they are inactive → render
  emits **503 stopped** pages for every instance. Caddy and the tunnel are back
  up; apps are intentionally not.
- **After `systemctl --user restart yard-caddy`** while apps are running, render
  sees them active → emits **live reverse-proxy** routes.

## Caddy config generation

yard is the single writer of `caddy.json` (under a lock). After any route change
it regenerates the whole config from state and POSTs it to the admin API's
`/load`, then persists the same JSON to disk. The generated config is one HTTP
server on `127.0.0.1:<caddyHttpPort>` with `automatic_https` disabled and, for
each instance:

- a Host route for the primary hostname → reverse-proxy to the routed port when
  running, or a **503** static stopped page when stopped (`yard down`);
- a Host route per extra route, same running/stopped behavior;
- a final catch-all → **404** static page for unknown hosts.

So `down` yields 503 (host known, app stopped) and `rm` yields 404 (host gone).

## State files (XDG)

| Path                                          | Contents                                |
| --------------------------------------------- | --------------------------------------- |
| `~/.config/yard/config.json`                  | Global config (mode `0600`)             |
| `~/.local/state/yard/instances.json`          | Durable instance facts (no live status) |
| `~/.local/state/yard/caddy.json`              | Generated Caddy config                  |
| `~/.local/state/yard/tunnel.yml`              | Static cloudflared config               |
| `~/.local/state/yard/tunnel-credentials.json` | Tunnel credentials                      |
| `~/.local/state/yard/state.lock`              | Mutation lockfile                       |
| `~/.local/share/yard/bin/`                    | Downloaded `caddy` / `cloudflared`      |

`XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `XDG_DATA_HOME` are honored if set.
Config and state are written atomically (temp file + rename) so a crash mid-write
can't corrupt them.

## Locking

Mutating commands (`up`, `down`, `restart`, `rm`) take an exclusive lock on
`state.lock` (created with `O_EXCL`, holding the PID) before touching state. If
another command holds it, yard **polls briefly** (150 ms intervals, up to 3 s)
so parallel `yard up` runs in different worktrees queue instead of failing. A
lock whose PID is no longer alive is treated as stale and reclaimed. If the lock
is still held by a live process after the timeout, the command fails with
`StateLocked` (reporting the lock path and holder PID).

The readiness poll in `up`/`restart` runs **outside** the lock, so a slow-starting
app never blocks other worktrees from mutating.

## Port allocation

- Ports come from `portRange` (default `3100`–`3999`).
- Allocation scans recorded ports in `instances.json`, skips reserved ones, and
  confirms each candidate by actually binding it on `127.0.0.1` before use.
- Ports are **stable**: an instance reuses its existing port for a
  process/route across `up` runs as long as it's still in range.
- `--port <n>` overrides the routed port (validated against range and a live bind
  probe).
- If nothing is free, allocation fails with `NoFreePort`.
