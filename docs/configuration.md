# Configuration

yard reads per-repo configuration from, in order of precedence:

1. **`yard.json`** at the repo root, then
2. **`package.json` → `yard`** key, then
3. **detection defaults**.

The first source that exists wins; there is no merging between sources. All
fields are optional.

## `yard.json` reference

```jsonc
{
  "processes": {
    "web": { "command": "vp run dev", "route": true },
  },
  "routes": {},
  "env": { "link": [".env"], "copyOnce": [".env.local"] },
}
```

### `processes`

A map of process name → spec. Each spec has:

- `command` (string, required) — run via `/bin/sh -lc`, so `$VAR` expansion
  works. Each process becomes a systemd unit `yard-app@<slug>--<name>.service`.
- `route` (boolean) — **exactly one** process must set `route: true`. That
  process is the one served at the primary hostname `<slug>.<zone>`, and it
  receives `PORT` and `DEV_HOST` in its environment.

Default when omitted: a single `web` process whose command is **detected** —
`vp run dev` if a `vp-lock.yaml` is present, otherwise `<pm> run dev` where
`<pm>` is inferred from the lockfile or `package.json`'s `packageManager`
(`pnpm`, `bun`, `yarn`, or `npm`), with `route: true`.

### `routes`

Extra public subdomains beyond the primary. Each entry (`<name>`) maps to:

- `process` (string, required) — the process the route belongs to; must exist in
  `processes`.
- `portEnv` (string, required) — a port is allocated for the route and injected
  under this env var name.
- `urlEnv` (string, optional) — if set, the route's public URL
  `https://<slug>-<name>.<zone>` is injected under this name.

Each route is served at `https://<slug>-<name>.<zone>`.

### `env`

- `link` (string[]) — files symlinked from the primary worktree into linked
  worktrees. Default `[".env"]`.
- `copyOnce` (string[]) — files copied from the primary into linked worktrees
  only if absent; never overwritten. Default `[".env.local"]`.

## Route env injection

Route env vars are injected into **every process of the instance**, not just the
route's own process. So the routed `web` process can read a route's `urlEnv`
(e.g. `VITE_CONVEX_URL`) while the backend process reads its own `portEnv`. The
routed process always gets:

- `PORT` — its allocated port.
- `DEV_HOST` — `<slug>.<zone>`, the primary hostname.

Environment changes take effect on the next `yard up`, which restarts any unit
whose rendered command or environment changed.

## Canonical scenarios

### 1. Plain Vite app

No config needed — detection supplies a single routed `web` process:

```jsonc
// no yard.json required; equivalent to:
{ "processes": { "web": { "command": "vp run dev", "route": true } } }
```

### 2. Vite + Convex cloud

Convex runs as an unrouted sidecar (no public URL of its own). Choose env
behavior per repo: put `.env.local` in `copyOnce` for a deployment isolated per
worktree, or in `link` to share one deployment across worktrees.

```jsonc
{
  "processes": {
    "web": { "command": "vp run dev", "route": true },
    "convex": { "command": "vp run convex dev" },
  },
  "env": { "link": [".env"], "copyOnce": [".env.local"] },
}
```

### 3. Vite + local Convex backend

The local backend needs two public routes — one for the API, one for the site.
Each gets its own allocated port (injected as `portEnv`) and public URL
(injected as `urlEnv`), and `web` reads both URLs:

```jsonc
{
  "processes": {
    "web": { "command": "vp run dev", "route": true },
    "convex": {
      "command": "vp run convex dev --local --local-cloud-port $CONVEX_CLOUD_PORT --local-site-port $CONVEX_SITE_PORT",
    },
  },
  "routes": {
    "convex": {
      "process": "convex",
      "portEnv": "CONVEX_CLOUD_PORT",
      "urlEnv": "VITE_CONVEX_URL",
    },
    "convex-site": {
      "process": "convex",
      "portEnv": "CONVEX_SITE_PORT",
      "urlEnv": "VITE_CONVEX_SITE_URL",
    },
  },
  "env": { "link": [".env"], "copyOnce": [".env.local"] },
}
```

This serves `web` at `<slug>.<zone>`, the Convex API at `<slug>-convex.<zone>`,
and the Convex site at `<slug>-convex-site.<zone>`.

## Env files: link, copyOnce, backups

Env linking runs on every `yard up` in a linked worktree (and via
`yard env link`). In the **primary** worktree it is a no-op — files live there
directly. In a **linked** worktree:

- **`link`** — each file is symlinked to the primary's copy. If a real file
  already exists at the destination it is renamed to `<file>.yard-backup` first;
  a symlink pointing elsewhere is replaced without a backup.
- **`copyOnce`** — each file is copied from the primary if it does not already
  exist in the worktree, and is never overwritten afterward.

If a source file is missing in the primary, yard records a `missing-source`
action and moves on.

## Global config (`~/.config/yard/config.json`)

Written by `yard init`, mode `0600` (it can hold tunnel credentials paths).

```jsonc
{
  "version": 1,
  "zone": "example.com",
  "caddyHttpPort": 8600, // Caddy's loopback HTTP listener
  "caddyAdminPort": 2019, // Caddy admin API
  "portRange": [3100, 3999], // app port allocation range
  "tunnel": {
    "name": "yard",
    "id": "<uuid>",
    "credentialsFile": "~/.local/state/yard/tunnel-credentials.json",
  },
  "binaries": { "caddy": "auto", "cloudflared": "auto" }, // "auto" | absolute path
  "auth": { "mode": "public" },
}
```

`auth.mode` accepts `"public"` (the default) or `"access"`, plus optional
`teamDomain` / `serviceToken` fields. This is a forward-looking surface for
edge-level auth; in this version it carries no behavior and everything is served
publicly.

## Instance state (`~/.local/state/yard/instances.json`)

yard persists only durable facts here; live running status is always derived from
systemd and Caddy, never cached. Each instance records:

- `repoName`, `word` (`null` for the primary), `worktreeRoot`, `primaryRoot`
- `ports` — a map of routed-process/route name → allocated port
- `processes` — the process names resolved at the last `up`
- `routedProcess` — which process holds the primary hostname
- `visibility` — `"public"` or `"protected"` (defaults from `auth.mode`; carries
  no behavior in this version)
- `createdAt`, `updatedAt`
