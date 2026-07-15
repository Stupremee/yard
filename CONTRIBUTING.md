# Contributing

Contributions are welcome. For substantial changes, open an issue first so the approach can be discussed.

## Setup

yard requires Node.js 24 or newer and uses Vite+ for all project tooling.

```bash
vp install
vp run setup
```

## Validation

Run the complete local validation before opening a pull request:

```bash
vp check
vp run typecheck
vp run test
vp run build:bundle
vp run check:package
```

Do not commit generated `dist` files or package tarballs.

## Commits and releases

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `fix: ...` produces a patch release.
- `feat: ...` produces a minor release.
- A `BREAKING CHANGE:` footer or `!` after the type produces a major release.
- `docs:`, `test:`, `chore:`, and similar changes do not normally produce a release.

Maintainers update `package.json` and `CHANGELOG.md` in a reviewed pull request. After it lands on `main`, pushing a matching `vX.Y.Z` tag starts the protected npm publish workflow and creates the GitHub Release.

## Pull requests

- Keep changes focused.
- Add or update tests for behavior changes.
- Update documentation for user-facing changes.
- Ensure all required GitHub checks pass.
