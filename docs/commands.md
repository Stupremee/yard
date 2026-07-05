# Command reference

Every command accepts `--json` for machine-readable output; without it, human
output is printed. `--json` is a shared flag and may appear anywhere on the line
(`yard --json up` or `yard up --json`). Standard flags `--help`/`-h`,
`--version`/`-v`, and `--completions <shell>` are available on every command.

**Exit codes:** commands exit `0` on success and non-zero on error, printing the
message to stderr (a JSON error object when `--json` is set). `doctor` and `init`
exit `1` if any health check fails; `caddy status` / `tunnel status` exit `1` if
the unit is inactive.

Most lifecycle commands operate on the instance for the **current directory's**
git worktree. `down` and `rm` also accept an explicit `[slug]` argument so you
can act on any instance from anywhere.

---

## `yard up`

```
yard up [--port <n>] [--no-wait]
```

Start or update the current worktree's instance: allocate ports, link env files,
write/start systemd units, sync Caddy routes, and (by default) wait up to 60s for
the app to respond over HTTP. Idempotent — reuses existing ports and restarts
only units whose command/env changed.

- `--port <n>` — pin the routed process port (must be free and in range).
- `--no-wait` — skip the readiness poll.

Output: the instance slug, URL, ports, units, env-link actions, and (unless
`--no-wait`) a `ready` flag.

```bash
yard up
yard up --port 3200 --no-wait
```

## `yard down`

```
yard down [<slug>]
```

Stop the instance's app units but keep its routes and state. Caddy flips the
routes to a friendly **503 stopped** page. Defaults to the current worktree's
instance; pass `<slug>` to target another.

## `yard restart`

```
yard restart [--no-wait]
```

Restart the current instance's app units and restore running routes. Waits for
readiness unless `--no-wait`. Operates on the current worktree only.

## `yard rm`

```
yard rm [<slug>]
```

Remove all yard resources for an instance: stop and disable units, delete
drop-ins, remove its Caddy routes (unknown hosts then return **404**), and drop
its state entry. **Never touches your worktree or git.** Defaults to the current
worktree's instance; pass `<slug>` to target another.

## `yard status`

```
yard status
```

Show live status for the current instance: per-process active state (from
systemd), per-route hostname/port and whether Caddy has the route, and Caddy
reachability. Never cached.

## `yard list`

```
yard list
```

Same live status as `status`, for every known instance.

## `yard logs`

```
yard logs [-f|--follow] [-n|--lines <n>] [--process <name>]
```

Read journald logs for one app process of the current instance.

- `-f`, `--follow` — stream new log lines.
- `-n`, `--lines <n>` — number of lines to show (default `100`).
- `--process <name>` — which process; defaults to the sole process, else `web`,
  else the routed process.

```bash
yard logs -f
yard logs -n 500 --process convex
```

## `yard url`

```
yard url [--route <name>]
```

Print the public URL for the current instance. With `--route <name>`, print an
extra route's URL instead of the primary. JSON output includes an `authHeaders`
object (empty in this version).

```bash
yard url
yard url --route convex
```

## `yard env link`

```
yard env link
```

Apply the configured env-file rules (`link` symlinks and `copyOnce` copies) for
the current worktree, without starting anything. Runs implicitly during `up`.
See [Configuration → env files](configuration.md#env-files-link-copyonce-backups).

## `yard init`

```
yard init [--zone <zone>] [<zone>]
```

Bootstrap yard on this server: resolve/download binaries, run the Cloudflare
tunnel login, create the `yard` tunnel and wildcard DNS, write the global config
and daemon units, enable linger, start the daemons, and run health checks. The
zone may be given as a flag or a positional argument; one is required. Exits `1`
if any check fails. See [Getting started](getting-started.md#2-yard-init).

## `yard doctor`

```
yard doctor
```

Run health checks and print a pass/fail line for each; exits `1` if any fail.
See [Troubleshooting](troubleshooting.md#what-yard-doctor-checks) for the list.

## `yard caddy` / `yard tunnel`

```
yard caddy   start | stop | status | logs [-f] [-n <n>] | render
yard tunnel  start | stop | status | logs [-f] [-n <n>]
```

Manage the two yard-owned user services (`yard-caddy.service`,
`yard-tunnel.service`).

- `start` / `stop` — control the unit.
- `status` — active/inactive (exits `1` if inactive).
- `logs` — journald logs, with the same `-f` / `-n` flags as `yard logs`.
- `render` (caddy only) — regenerate `caddy.json` from persisted state. This is
  what the Caddy unit runs on start to converge to the correct routes.

## `yard print-vite-config`

```
yard print-vite-config
```

Print the Vite `server` config snippet that makes a dev server work behind yard
(binds `127.0.0.1`, uses `PORT`, `strictPort`, allows `DEV_HOST`, WSS HMR on
client port 443). Works without an initialized server.
