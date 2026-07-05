---
name: using-yard
description: Operates yard, a CLI that gives each git repo or worktree its own systemd-managed dev process and a public HTTPS preview URL on a yard-managed Linux server. Use this when working inside a repo or worktree on a yard server and you need a running dev environment with a shareable preview URL — to start, stop, inspect, or clean up instances, fetch URLs, read logs, or wire up a repo's yard.json.
---

# Using yard

yard runs a dev server per git repo/worktree behind a Cloudflare tunnel and gives
it a stable public URL. You operate it entirely through `yard` commands. Always
run commands from **inside the target repo or worktree** — yard resolves the
instance from the current git worktree.

## Core loop

```bash
yard up --json        # start/update this worktree's instance; waits for HTTP readiness
yard url --json       # get the public URL to preview/share
# ... edit code; HMR reloads automatically, no restart needed ...
yard down --json      # stop the process when pausing (keeps the URL → 503 page)
yard rm --json        # full cleanup of yard resources (never touches your files/git)
```

- `yard up` is **idempotent**: re-run it after code or `yard.json` changes; it
  reuses ports and restarts only what changed. It blocks up to 60s waiting for the
  app to answer HTTP. Add `--no-wait` to return immediately (e.g. for a slow boot).
- `yard url --json` returns `{ url, route, authHeaders }`. `authHeaders` is a
  reserved field, currently always empty — do not depend on it.
- Restart in place with `yard restart --json`. Restart the current worktree only.

## Parallel worktrees

Each git worktree is its own instance with its own URL, ports, and units,
assigned automatically. To work on several branches at once, use git worktrees and
run `yard up` in each — it is safe to run `yard up` concurrently in different
worktrees (yard serializes state changes with a lock). Primary worktree →
`<repo>.<zone>`; linked worktree → `<repo>-<word>.<zone>`.

## Always use `--json`

Pass `--json` to every command you parse. A **non-zero exit means failure**; the
JSON on stderr has an `error` field holding the error tag. Handle common tags:

| `error` tag             | Meaning & what to do                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `NotAGitRepo`           | cwd is not in a git repo. `cd` into the repo/worktree first.                                          |
| `NoInstanceForWorktree` | Linked worktree never started. Run `yard up`.                                                         |
| `InstanceNotFound`      | No instance for that slug. Run `yard list --json` for valid slugs, or `yard up`.                      |
| `ConfigInvalid`         | Bad `yard.json`/`package.json#yard` or flag; the `path` field names the source. Fix it.               |
| `StateLocked`           | Another yard command holds the lock (already waited ~3s). Retry shortly; do not delete the lock file. |
| `NoFreePort`            | Port range exhausted. `yard rm` unused instances (see `yard list --json`).                            |
| `CaddyUnreachable`      | Caddy daemon down. Run `yard doctor --json`; recover with `yard caddy start`.                         |
| `ProcessFailed`         | An underlying command failed; read the `stderr`/`exitCode` fields and `yard logs`.                    |

## Inspecting

```bash
yard status --json                 # this instance: process active-state, routes, caddy reachability
yard list --json                   # all instances with live status
yard logs -n 200                   # last 200 journald lines of the app process
yard logs -f                       # follow logs (streams; stop when done)
yard logs --process convex         # a specific process (default: sole/web/routed process)
yard doctor --json                 # run when routing/tunnel/DNS seems broken
```

Status is always derived live from systemd + Caddy, never cached.

## Config (`yard.json`)

Optional; place at repo root. Detection handles plain single-process apps with no
config. Declare `processes` (exactly one with `route: true` gets `PORT` +
`DEV_HOST`), extra `routes` (extra subdomains with an allocated port/URL injected
into every process), and `env` link rules:

```jsonc
{
  "processes": {
    "web": { "command": "vp run dev", "route": true },
    "convex": { "command": "vp run convex dev" },
  },
  "routes": {},
  "env": { "link": [".env"], "copyOnce": [".env.local"] },
}
```

Wire the dev server to the port/host yard provides: run `yard print-vite-config`
and apply the printed snippet (binds `127.0.0.1`, uses `PORT`, `strictPort`,
allows `DEV_HOST`, WSS HMR). See `docs/configuration.md` for full detail.

## Guardrails

- **Only ever mutate yard state through `yard` commands.** Never hand-edit
  `~/.config/yard`, `~/.local/state/yard`, `caddy.json`, `tunnel.yml`, or files in
  `~/.config/systemd/user/`.
- **Never `systemctl`/`kill` `yard-*` units directly.** Use `yard up`/`down`/
  `restart`/`rm` and `yard caddy|tunnel start|stop`.
- **Never run `yard init`.** It performs one-time server setup with an interactive
  Cloudflare browser login — human-only, unless the human explicitly asks.
- `yard rm` removes yard's resources only; it never deletes your worktree or git
  data. yard also never creates or deletes git worktrees — create those yourself.

## More

For depth, read the repo docs: `docs/commands.md`, `docs/configuration.md`,
`docs/getting-started.md`, `docs/architecture.md`, `docs/troubleshooting.md`.
