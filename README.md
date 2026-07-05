# yard

yard is a lightweight remote-development tool for a single-user Linux server. It
gives every project — and every git worktree of that project — its own
systemd-managed dev process and a stable public preview URL, so AI agents and a
developer can run many apps in parallel without hand-assigning ports, minding
processes, or editing reverse-proxy config. You `yard up` inside a repo and get
back an `https://` URL that serves your dev server through a Cloudflare tunnel.

## How a request reaches your app

```text
https://<repo>.<zone>
  → Cloudflare edge        TLS termination; wildcard DNS *.<zone> → the tunnel
  → cloudflared            outbound-only tunnel (yard-tunnel.service); one static
                           wildcard ingress → http://127.0.0.1:<caddyHttpPort>
  → Caddy                  plain HTTP on loopback (yard-caddy.service); routes by
                           Host header via its admin API
  → app process            your dev server (yard-app@<slug>--<proc>.service) on
                           127.0.0.1:<port>
```

Nothing binds `:443`, nothing needs sudo after `yard init`, and Tailscale or
other services on the box are left untouched.

## Requirements

- Linux with a **systemd user session** (`systemctl --user`) and lingering
  enabled — `yard init` enables it for you.
- **Node.js ≥ 24**.
- A **Cloudflare account** with a **zone** on the free plan (free Universal SSL
  covers one subdomain level under the apex).
- `caddy` and `cloudflared` — used from `PATH` if present, otherwise pinned
  versions are downloaded during `yard init`.

## Install from source

yard uses [Vite+](https://vite.dev) (`vp`) for every repo task — never call
`pnpm`, `npm`, `npx`, or `vite` directly.

```bash
vp install
vp run build:bundle          # bundles the CLI to dist/bin.mjs
mkdir -p ~/.local/bin
ln -sf "$PWD/dist/bin.mjs" ~/.local/bin/yard
```

Make sure `~/.local/bin` is on your `PATH`.

## Quick start

Run `init` once per server to bootstrap the tunnel and daemons (a browser login
flow for Cloudflare runs during this step):

```bash
yard init example.com          # or: yard init --zone example.com
```

Then, from inside any git repo or worktree:

```bash
yard up      # start the dev process and route it publicly
yard url     # print the URL, e.g. https://myrepo.example.com
yard status  # show live process + route status
yard down    # stop the process, keep a friendly 503 page
yard rm      # remove all yard resources (never touches your worktree)
```

- Primary worktree → `https://<repo>.<zone>`
- Linked worktree → `https://<repo>-<word>.<zone>` (a stable random word)
- Extra routes → `https://<slug>-<route>.<zone>`

Every command accepts `--json` for machine-readable output.

## Documentation

- [Getting started](docs/getting-started.md) — the full first-run walkthrough.
- [Configuration](docs/configuration.md) — `yard.json`, env files, global config.
- [Commands](docs/commands.md) — every command, flag, and exit code.
- [Architecture](docs/architecture.md) — request chain, units, state, locking.
- [Troubleshooting](docs/troubleshooting.md) — `yard doctor`, failures, resets.

For AI coding agents, an installable skill lives at
[`skills/using-yard`](skills/using-yard/SKILL.md):
`npx skills add Stupremee/yard --skill using-yard`.

## License

MIT.
