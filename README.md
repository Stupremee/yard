# yard

yard is a single-user remote development CLI for Linux servers. It gives each
project or existing git worktree its own systemd-managed dev process and stable
preview URL without manually assigning ports or editing reverse-proxy config.

Request path:

```text
Cloudflare edge -> cloudflared tunnel -> Caddy on 127.0.0.1 -> app process
```

## Requirements

- Linux with a systemd user session
- Node.js 24 or newer
- A Cloudflare account and zone
- `cloudflared` authenticated during `yard init`
- No sudo for app lifecycle commands after init

## Install From Source

```bash
vp install
vp run build:bundle
mkdir -p ~/.local/bin
ln -sf "$PWD/dist/bin.mjs" ~/.local/bin/yard
```

The project uses Vite+ (`vp`) for all local development commands.

## First Run

Run init once on the server:

```bash
yard init --zone example.com
```

`yard init` resolves or downloads Caddy and cloudflared, creates a Cloudflare
tunnel, writes `~/.config/yard/config.json`, writes daemon unit files, enables
linger, and starts `yard-caddy.service` plus `yard-tunnel.service`.

Then run from an existing git worktree:

```bash
yard up
yard url
yard status
yard down
yard rm
```

Primary worktrees use `https://<repo>.<zone>`. Linked worktrees use
`https://<repo>-<word>.<zone>`. Extra routes use
`https://<slug>-<route>.<zone>`.

## Commands

All commands accept `--json` on the root command, for example:

```bash
yard --json status
yard --json url
```

| Command                                  | Purpose                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `yard up [--port N] [--no-wait]`         | Start or update the current worktree instance and route it through Caddy. |
| `yard down`                              | Stop app units but keep routes, returning a friendly 503 page.            |
| `yard restart [--no-wait]`               | Restart app units and restore running routes.                             |
| `yard rm`                                | Stop units, remove yard drop-ins, remove Caddy routes, and delete state.  |
| `yard status`                            | Show live systemd and Caddy status for the current instance.              |
| `yard list`                              | Show all known instances with live status.                                |
| `yard logs [-f] [-n N] [--process name]` | Read journald logs for an app process.                                    |
| `yard url [--route name]`                | Print the public URL. JSON output includes `authHeaders: {}`.             |
| `yard env link`                          | Apply configured env symlinks and copy-once files.                        |
| `yard init --zone ZONE`                  | Configure global state, tunnel, Caddy, and user services.                 |
| `yard doctor`                            | Check binaries, systemd, daemons, tunnel, DNS, and port range.            |
| `yard caddy start\|stop\|status\|logs`   | Manage the yard Caddy user service.                                       |
| `yard tunnel start\|stop\|status\|logs`  | Manage the yard cloudflared user service.                                 |
| `yard print-vite-config`                 | Print the Vite server snippet expected behind yard.                       |

## `yard.json`

yard reads config from `yard.json`, then `package.json#yard`, then detection
defaults. Fields are optional.

### Plain Vite App

No config is required if detection finds the dev command.

```json
{
  "processes": {
    "web": { "command": "vp run dev", "route": true }
  }
}
```

### Vite Plus Convex Cloud

Use Convex as an unrouted sidecar. Choose env behavior per repo.

```json
{
  "processes": {
    "web": { "command": "vp run dev", "route": true },
    "convex": { "command": "vp run convex dev" }
  },
  "env": {
    "link": [".env"],
    "copyOnce": [".env.local"]
  }
}
```

### Vite Plus Local Convex Backend

Extra routes allocate real route keys and inject their ports into every process.

```json
{
  "processes": {
    "web": { "command": "vp run dev", "route": true },
    "convex": {
      "command": "vp run convex dev --local --local-cloud-port $CONVEX_CLOUD_PORT --local-site-port $CONVEX_SITE_PORT"
    }
  },
  "routes": {
    "convex": {
      "process": "convex",
      "portEnv": "CONVEX_CLOUD_PORT",
      "urlEnv": "VITE_CONVEX_URL"
    },
    "convex-site": {
      "process": "convex",
      "portEnv": "CONVEX_SITE_PORT",
      "urlEnv": "VITE_CONVEX_SITE_URL"
    }
  },
  "env": {
    "link": [".env"],
    "copyOnce": [".env.local"]
  }
}
```

Exactly one process should set `"route": true`; that process receives `PORT`
and `DEV_HOST`.

## Vite

Print the current snippet with:

```bash
yard print-vite-config
```

It configures Vite to listen on `127.0.0.1`, use `PORT`, enforce
`strictPort`, allow `DEV_HOST`, and use WSS HMR on client port 443.

## Troubleshooting

Run:

```bash
yard doctor
yard --json doctor
```

`doctor` checks required binaries, systemd user availability, linger, the Caddy
and tunnel units, Caddy admin reachability, tunnel health, wildcard DNS, tunnel
credentials, and port-range sanity.
