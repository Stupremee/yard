# Getting started

This walkthrough takes you from a fresh checkout to a repo (and a worktree)
served publicly through yard.

## 1. Install

See the [README](../README.md#install-from-source): `vp install`,
`vp run build:bundle`, then symlink `dist/bin.mjs` to `~/.local/bin/yard`.

## 2. `yard init`

Run this once per server. It requires a Cloudflare zone you control:

```bash
yard init example.com          # equivalent: yard init --zone example.com
```

`init` performs the following, in order:

1. **Resolves binaries** — uses `caddy` and `cloudflared` from `PATH` if found,
   otherwise downloads pinned versions to `~/.local/share/yard/bin/`.
2. **Cloudflare login** — runs `cloudflared tunnel login`. This prints an
   authorization URL to the terminal and blocks until you approve access to the
   zone in your browser. If `~/.cloudflared/cert.pem` already exists, login is
   skipped.
3. **Creates the tunnel** — `cloudflared tunnel create yard` (adopts an existing
   `yard` tunnel if one is already present).
4. **Routes wildcard DNS** — `cloudflared tunnel route dns yard "*.<zone>"`,
   creating a `*.<zone>` CNAME to the tunnel.
5. **Writes config and daemon files** — the global config
   (`~/.config/yard/config.json`, mode `0600`), the static tunnel config
   (`~/.local/state/yard/tunnel.yml`), a baseline Caddy config
   (`~/.local/state/yard/caddy.json`, a 404 catch-all), and the
   `yard-caddy.service` / `yard-tunnel.service` user units.
6. **Enables and starts the daemons** — `daemon-reload`, enables and starts both
   units, and runs `loginctl enable-linger` so they survive logout and reboot.
7. **Verifies** — runs the same checks as [`yard doctor`](troubleshooting.md)
   and prints the results. If any check fails, `init` exits non-zero.

After `init` you should not need sudo again for day-to-day work.

## 3. First `yard up`

From inside a git repository:

```bash
cd ~/dev/myrepo
yard up
```

`up` resolves the git context, allocates ports, links env files, writes and
starts systemd units, updates Caddy, then waits for the app to respond over HTTP
(up to 60s) before printing a summary:

```text
up: myrepo
url: https://myrepo.example.com
ports: web=3100
units: yard-app@myrepo--web.service
ready: yes
```

`up` is idempotent — run it again after changing code or config and it reuses
the same ports, restarting only units whose command or environment changed. Pass
`--no-wait` to skip the readiness poll, or `--port N` to pin the routed port.

Open the printed URL and you should see your dev server, served over HTTPS with
working HMR.

## 4. The URLs you get

| Where you run `up`          | Hostname                |
| --------------------------- | ----------------------- |
| Primary worktree            | `<repo>.<zone>`         |
| Linked worktree             | `<repo>-<word>.<zone>`  |
| Extra route named `<route>` | `<slug>-<route>.<zone>` |

`<repo>` is your primary directory name, slugified. `<word>` is a random,
memorable English word assigned to each linked worktree the first time you
`up` it; the word is persisted, so a worktree keeps the same URL across runs.
`<slug>` is the instance slug — `<repo>` for the primary, `<repo>-<word>` for a
worktree.

## 5. Configure your dev server

Your dev server must bind the port and hostname yard hands it. yard sets `PORT`
and `DEV_HOST` in the process environment; print a ready-made Vite snippet with:

```bash
yard print-vite-config
```

```js
if (!process.env.PORT || !process.env.DEV_HOST) {
  throw new Error("yard requires PORT and DEV_HOST");
}

export default {
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT),
    strictPort: true,
    allowedHosts: [process.env.DEV_HOST],
    hmr: {
      protocol: "wss",
      host: process.env.DEV_HOST,
      clientPort: 443,
    },
  },
};
```

`strictPort` ensures the server fails loudly if the assigned port is taken;
`allowedHosts` and the `wss` HMR block make Vite work behind the tunnel.

## 6. Worktree workflow

yard never creates or deletes worktrees — it adopts ones you already have.
Create a worktree with git, then `up` inside it:

```bash
cd ~/dev/myrepo
git worktree add ../myrepo-feature -b feature
cd ../myrepo-feature
yard up
```

This yields a second, fully independent instance — its own word, URL, ports, and
units — running in parallel with the primary:

```text
up: myrepo-komet
url: https://myrepo-komet.example.com
ports: web=3101
units: yard-app@myrepo-komet--web.service
ready: yes
```

For a linked worktree, yard also links env files from the primary (see
[Configuration](configuration.md#env-files-link-copyonce-backups)): `.env` is symlinked and
`.env.local` is copied once. When you're done, `yard rm` inside the worktree
removes the yard instance; your files and the git worktree stay put.

## Next steps

- [Configuration](configuration.md) for multi-process repos (e.g. Convex) and
  env-file rules.
- [Commands](commands.md) for the full command reference.
