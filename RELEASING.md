# Releasing MiniCPA

Stable releases are published from `.github/workflows/publish.yml` with npm Trusted Publishing (OIDC). The repository must not contain `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or another npm publishing secret.

## npm Trusted Publisher

The npm package uses this one-time configuration:

- Provider: GitHub Actions
- GitHub owner: `ming-kang`
- Repository: `MiniCPA`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`
- Environment: empty

The workflow is manually dispatched from `main`, verifies the source and packed package, then publishes with provenance.

## Release checklist

1. Update `package.json` and `package-lock.json` together:

   ```bash
   npm version x.y.z --no-git-tag-version
   ```

2. Move the release notes out of `## [Unreleased]` into `## [x.y.z] - YYYY-MM-DD`.
3. Run the normal checks:

   ```bash
   npm ci
   npm run audit:prod
   npm run lint
   npm test
   npm run build
   ```

4. Commit and push the release change to `main`, then wait for CI to pass.
5. Dispatch **Publish npm** from `main` with the same version. After it succeeds, record the run's head commit as `RELEASE_SHA`.
6. Verify the published package:

   ```bash
   npm view @astralyn/minicpa version dist-tags --json
   npx --yes @astralyn/minicpa@x.y.z --version
   ```

   The npm package page should show provenance from `.github/workflows/publish.yml` at `RELEASE_SHA`.

7. Tag that exact commit, not a potentially newer `main`, then create the matching GitHub Release:

   ```bash
   git tag -a "vX.Y.Z" "$RELEASE_SHA" -m "release: X.Y.Z"
   git push origin "vX.Y.Z"
   ```

## Failed publication

First check `npm view @astralyn/minicpa@x.y.z version`. If the version does not exist, fix the release commit and dispatch the workflow again. If it exists, npm has already accepted the immutable package; do not unpublish or try to overwrite it. Verify it and, if it is defective, deprecate it and prepare the next patch version.
