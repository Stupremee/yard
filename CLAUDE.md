# yard

yard is a lightweight remote development tool for managing AI-assisted projects on a server. It lets each project, branch, or worktree have its own private development environment with an easy-to-access preview URL, so AI agents and developers can work on multiple applications in parallel without manually managing ports, processes, or routing.

## Commands

| Command               | Description                                              |
| --------------------- | -------------------------------------------------------- |
| `vp install`          | Install dependencies                                     |
| `vp run dev`          | Run the CLI from source in watch mode                    |
| `vp run build:bundle` | Bundle the CLI with `vp pack`                            |
| `vp run start`        | Run the bundled CLI                                      |
| `vp run typecheck`    | Typecheck the project                                    |
| `vp run doctor`       | Full health check (typecheck incl. Effect diagnostics)   |
| `vp test`             | Run tests                                                |
| `vp check`            | Format, lint, and type checks (use for validation loops) |

## Tooling

This project uses Vite+ (`vp`) for everything: installing deps (`vp install` / `vp add` / `vp remove`), running scripts (`vp run <script>`), testing (`vp test`), linting/formatting (`vp check --fix`), and bundling (`vp pack`).

NEVER call `pnpm`, `npm`, `npx`, `vite`, or `vitest` directly -- always go through `vp`.

`vp build` (the Vite app build) does not apply to this CLI package; the production build is `vp pack` (config lives in `vite.config.ts` under the `pack` block).

Build-time Effect diagnostics come from `@effect/tsgo` (patched tsgo binary, applied by the `prepare` script); pre-commit hooks run `vp check --fix` on staged files via the `staged` block in `vite.config.ts`.

<!-- effect-solutions:start -->

## Validation

NEVER manually validate external or untrusted data (JSON files, configs, CLI
input, process output) with hand-written `typeof`/`in` checks, type guards, or
`as` casts. Always define an Effect `Schema` (`Schema.Struct`, `Schema.Union`,
`Schema.Record`, ...) as the single source of truth and derive both the type
(`typeof S.Type`) and the runtime validation (`Schema.decodeEffect`,
`Schema.decodeUnknownEffect`, `Schema.fromJsonString`, `Schema.is`) from it.
See `src/dev/config.ts` (`PackageJson`, `YardConfig`) for the pattern.

## Effect Best Practices

**IMPORTANT:** Always consult effect-solutions before writing Effect code.

1. Run `effect-solutions list` to see available guides
2. Run `effect-solutions show <topic>...` for relevant patterns (supports multiple topics)
3. Search `~/.local/share/effect-solutions/effect` for real implementations

Topics: quick-start, project-setup, tsconfig, basics, services-and-layers, data-modeling, error-handling, config, testing, cli.

Never guess at Effect patterns - check the guide first.

## Local Effect Source

The Effect v4 repository is cloned to `~/.local/share/effect-solutions/effect` for reference.
Use this to explore APIs, find usage examples, and understand implementation
details when the documentation isn't enough.

<!-- effect-solutions:end -->
