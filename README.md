# yard

yard is a lightweight remote development tool for managing AI-assisted projects on a server. It lets each project, branch, or worktree have its own private development environment with an easy-to-access preview URL, so AI agents and developers can work on multiple applications in parallel without manually managing ports, processes, or routing.

## Status

Early scaffold only. The current implementation is a hello-world CLI with no real project management features yet.

## Quickstart

```bash
vp install
vp run dev
```

## Commands

| Command               | Description                                              |
| --------------------- | -------------------------------------------------------- |
| `vp install`          | Install dependencies                                     |
| `vp run dev`          | Run the CLI from source in watch mode                    |
| `vp run build:bundle` | Bundle the CLI with `vp pack`                            |
| `vp run start`        | Run the bundled CLI                                      |
| `vp run typecheck`    | Typecheck the project                                    |
| `vp test`             | Run tests                                                |
| `vp check`            | Format, lint, and type checks (use for validation loops) |
