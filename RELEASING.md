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

## Release checklist

1. Describe the release under `## [Unreleased]` in `CHANGELOG.md`, then prepare it:

   ```bash
   npm run release:prepare -- x.y.z
   ```

   This bumps `package.json` and `package-lock.json` together and moves the Unreleased notes under `## [x.y.z] - YYYY-MM-DD`. It refuses an empty Unreleased section or a version that is not newer.

2. Review the notes, commit `chore(release): x.y.z` (the pre-commit hook runs `npm run check`), and push to `main`.
3. Dispatch **Publish npm** from `main` with the same version:

   ```bash
   gh workflow run publish.yml --ref main -f version=x.y.z
   ```

The workflow finishes the release on the dispatched commit:

| Job | Permissions | Does |
|-----|-------------|------|
| Verify release request | `contents: read` | Requires `main`, matching package versions and CHANGELOG notes, and a version and tag that do not exist yet |
| CI | `contents: read` | Runs `ci.yml` (check, package smoke test, production audit) on Ubuntu, Windows and macOS |
| Publish | `contents: read`, `id-token: write` | Builds, packs, smoke-tests and publishes the tarball with provenance |
| Verify npm registry | none | Waits until the version is installable and `npx @astralyn/minicpa@x.y.z --version` matches |
| Tag and create GitHub Release | `contents: write` | Tags `vx.y.z` (annotated) at the published commit and creates the Release from the CHANGELOG section |

Edit the GitHub Release afterwards if it needs highlights beyond the CHANGELOG notes.

## Failed publication

- **Before Publish** (request, CI, build, or smoke test): nothing reached npm. Fix the problem on `main` and dispatch again.
- **After Publish** (registry wait, tag, or Release): npm already holds the immutable package. Use **Re-run failed jobs** on the same run; those jobs reuse an existing tag at the published commit and skip an existing Release. Never dispatch the same version again, and do not unpublish.
- **Defective package**: check `npm view @astralyn/minicpa@x.y.z version`. If it exists, deprecate it and release the next patch version.
