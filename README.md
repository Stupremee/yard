# yard

[![CI](https://github.com/Stupremee/yard/actions/workflows/ci.yml/badge.svg)](https://github.com/Stupremee/yard/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40stupremee%2Fyard)](https://www.npmjs.com/package/@stupremee/yard)
[![license](https://img.shields.io/npm/l/%40yard%2Fcli)](LICENSE)

`yard` is a lightweight CLI for managing development stacks for AI-assisted projects. Each project, branch, or worktree can run its own named stack without manually tracking child processes.

> **Status:** yard is under active development. The current release manages local development processes; remote environments, routing, and preview URLs are planned.

## Requirements

- Node.js 24 or newer
- Linux or macOS is recommended for process-group management

## Installation

```bash
npm install --global @stupremee/yard
```

The package installs the `yard` command.

## Quick start

From a project with a `dev` or `dev:*` package script:

```bash
yard init
yard dev
```

`yard init` discovers development scripts and writes a `yard.json` file or a `yard` field in `package.json`. `yard dev` starts the configured tasks and replaces an existing stack with the same name.

## Commands

| Command                   | Description                                                |
| ------------------------- | ---------------------------------------------------------- |
| `yard init`               | Discover development scripts and create yard configuration |
| `yard dev`                | Start the current project's development stack              |
| `yard dev --name <name>`  | Start or replace a specifically named stack                |
| `yard stop`               | Stop the current project's stack                           |
| `yard stop --name <name>` | Stop a specifically named stack                            |
| `yard status`             | List running stacks and their child processes              |
| `yard --help`             | Show all commands and options                              |

For non-interactive setup, use `yard init --yes`. Repeat `--script` to select specific scripts:

```bash
yard init --script dev:web --script dev:api --target yard
```

## Configuration

Create `yard.json` in the project root:

```json
{
  "name": "my-app",
  "dev": {
    "web": "vp run dev:web",
    "api": "vp run dev:api"
  }
}
```

A single command can be provided as a string:

```json
{
  "dev": "vp run dev"
}
```

Alternatively, put the same object under the `yard` key in `package.json`. A `yard.json` file takes precedence when both are present. Without explicit configuration, yard uses the package's `dev` script.

## Development

This repository uses [Vite+](https://viteplus.dev/) for its toolchain.

```bash
vp install
vp run setup
vp check
vp run typecheck
vp run test
vp run build:bundle
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution and commit conventions. Maintainers can find the npm bootstrap and OIDC process in [docs/releasing.md](docs/releasing.md).

## Security

Please report vulnerabilities according to [SECURITY.md](SECURITY.md), not in a public issue.

## License

[MIT](LICENSE)
