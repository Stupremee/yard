# Releasing `@stupremee/yard`

Releases use protected version tags, a GitHub Environment, and npm trusted publishing with OIDC. No long-lived npm token is used after the one-time bootstrap.

## One-time repository setup

1. Make `Stupremee/yard` public before the first release. This enables npm provenance and the configured GitHub security workflows.
2. Create a GitHub Environment named exactly `npm`.
3. Add the desired maintainers as required reviewers for the `npm` environment. Under **Deployment branches and tags**, choose **Selected branches and tags** and add the tag pattern `v*.*.*`.
4. Protect `main` with a ruleset requiring pull requests and the CI/security checks.
5. Add a tag ruleset for `v*.*.*` so only maintainers can create or update release tags.

## Bootstrap the first package release

npm requires a package to exist before a trusted publisher can be attached. The first `0.1.0` release is therefore published manually.

1. Merge the publishing setup into `main` and check out that exact commit locally.
2. Authenticate to npm as `stupremee` with 2FA enabled.
3. Validate, build, and inspect the exact tarball:

   ```bash
   vp install
   vp run setup
   vp check
   vp run typecheck
   vp run test
   vp run build:bundle
   vp run check:package
   vp run pack:package
   test -z "$(git status --porcelain)"
   ```

4. Install and smoke-test the tarball from a temporary prefix:

   ```bash
   SMOKE_PREFIX="$(mktemp -d)"
   vp exec npm install --global --prefix "$SMOKE_PREFIX" ./stupremee-yard-0.1.0.tgz
   "$SMOKE_PREFIX/bin/yard" --version
   "$SMOKE_PREFIX/bin/yard" --help
   ```

5. Publish that same inspected tarball:

   ```bash
   vp exec npm publish ./stupremee-yard-0.1.0.tgz
   ```

6. Verify that `@stupremee/yard@0.1.0` is public.
7. Configure npm trusted publishing as described below.
8. Create and push the initial annotated tag from the same commit:

   ```bash
   git tag -a v0.1.0 -m "v0.1.0"
   git push origin v0.1.0
   ```

The publish workflow intentionally skips npm for `v0.1.0`, because that version was bootstrapped manually, and creates its GitHub Release.

## Enable npm trusted publishing

After `@stupremee/yard` exists, open its settings on npmjs.com and add this trusted publisher:

| Setting              | Value          |
| -------------------- | -------------- |
| Provider             | GitHub Actions |
| Organization or user | `Stupremee`    |
| Repository           | `yard`         |
| Workflow filename    | `publish.yml`  |
| Environment          | `npm`          |
| Allowed action       | `npm publish`  |

Then set **Publishing access** to **Require two-factor authentication and disallow tokens**, and revoke any obsolete automation token. The workflow's `id-token: write` permission lets npm exchange GitHub's OIDC identity for a short-lived publish credential. Public releases receive npm provenance automatically.

## Normal release flow

1. Update `version` in `package.json` and add the release notes to `CHANGELOG.md` in a pull request.
2. Merge the pull request after all required checks pass.
3. From the merge commit on `main`, create and push an annotated tag that exactly matches the package version:

   ```bash
   git switch main
   git pull --ff-only
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

4. A configured reviewer approves the `npm` environment deployment.
5. GitHub Actions verifies that the tag is on `main`, checks that it matches `package.json`, runs all checks and tests, inspects the package, and publishes through OIDC.
6. After npm succeeds, the workflow creates the corresponding GitHub Release with generated notes.

The trusted publisher must continue to match `.github/workflows/publish.yml` and the `npm` environment exactly; these values are case-sensitive.

## Recovery

A failed publish can be retried from the failed `Publish` workflow run after correcting an environmental issue. If source changes are needed, leave the failed tag immutable, merge the fix and a new version through a pull request, then create a new tag. If npm succeeded but GitHub Release creation alone failed, create the Release from the existing tag manually instead of rerunning the publish job. npm versions are immutable, so never reuse a version that was successfully published.
