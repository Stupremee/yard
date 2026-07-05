# Troubleshooting

Start with `yard doctor`. It runs every health check and prints a `✓`/`✗` line
each; it exits non-zero if anything fails. Add `--json` for structured output.

```bash
yard doctor
yard --json doctor
```

## What `yard doctor` checks

| Check                  | Passes when                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `binaries`             | `caddy` and `cloudflared` resolve (PATH or downloaded)       |
| `systemd user session` | `systemctl --user show-environment` works                    |
| `linger`               | `loginctl show-user` reports `Linger=yes`                    |
| `yard-caddy active`    | `yard-caddy.service` is active                               |
| `yard-tunnel active`   | `yard-tunnel.service` is active                              |
| `Caddy admin API`      | the admin API responds (default `127.0.0.1:2019`)            |
| `tunnel connections`   | `cloudflared tunnel info` reports healthy/active connections |
| `wildcard DNS`         | a random `*.<zone>` name resolves through Cloudflare         |
| `port range`           | the range is sane and at least one port in it is free        |
| `tunnel credentials`   | the credentials file from the config exists                  |

## Common failures

### Cloudflare login expired / tunnel commands fail

`init` or `doctor`'s tunnel checks fail after credentials lapse. Re-run
`yard init <zone>` to redo the browser login (it skips login if
`~/.cloudflared/cert.pem` is still valid) and re-verify. Check the tunnel daemon
with `yard tunnel status` and `yard tunnel logs`.

### Caddy admin unreachable

Errors mention `Caddy admin API unreachable`. The Caddy daemon is likely down —
start it and inspect logs:

```bash
yard caddy start
yard caddy status
yard caddy logs -n 200
```

If routes look wrong, `yard caddy render` regenerates `caddy.json` from state
(the daemon also does this on start).

### Port exhaustion (`NoFreePort`)

No port is free in `portRange` (default `3100`–`3999`). Remove instances you no
longer need (`yard rm <slug>`), or widen `portRange` in
`~/.config/yard/config.json`. `yard list` shows what's allocated.

### `StateLocked`

Another yard command holds the mutation lock. The message reports the lock path
(`~/.local/state/yard/state.lock`) and the holder PID. yard waits up to 3s before
failing, so usually retrying is enough. If the holder is gone but the file
remains (rare — stale locks are normally reclaimed automatically), remove it:

```bash
rm ~/.local/state/yard/state.lock
```

### `InstanceNotFound` / `NoInstanceForWorktree`

- `InstanceNotFound: <slug>` — no instance with that slug (e.g. a bad `down`/`rm`
  argument). Run `yard list` to see valid slugs.
- `No yard instance for this worktree … (run yard up)` — you're in a linked
  worktree that was never brought up. Run `yard up` there first.

### Repo slug collision

```
Repo slug "<slug>" is already used by primary root <path>; current primary root is <path>.
```

Two repositories slugify to the same name. Rename one repo directory, or
`yard rm <slug>` to drop the stale instance.

## Where logs live

Everything runs as systemd user units, so logs are in the user journal:

```bash
journalctl --user -u yard-app@<slug>--<proc>.service   # an app process
journalctl --user -u yard-caddy.service
journalctl --user -u yard-tunnel.service
```

The `yard logs`, `yard caddy logs`, and `yard tunnel logs` commands wrap these
(with `-f` to follow and `-n` to limit lines).

## Full reset

To tear down all yard instances and daemons:

```bash
yard list                        # note the slugs
yard rm <slug>                   # repeat for each instance
yard caddy stop && yard tunnel stop
systemctl --user disable yard-caddy.service yard-tunnel.service
systemctl --user list-units 'yard-*' --all   # confirm nothing remains
```

To also discard configuration and state, remove the yard directories and re-run
`yard init`:

```bash
rm -rf ~/.config/yard ~/.local/state/yard
# optionally: rm -rf ~/.local/share/yard   # downloaded binaries
```

Deleting the Cloudflare tunnel itself (if you want a clean slate there) is done
with `cloudflared tunnel delete yard`.
