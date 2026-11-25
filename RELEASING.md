# Releasing MiniCPA

Stable releases are published by `.github/workflows/publish.yml` using npm Trusted Publishing (OIDC). The repository must never contain `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or any other npm publishing secret.

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

   The workflow verifies the release request, runs the full CI matrix on the dispatched commit, publishes the tarball with provenance, waits until the registry serves the version, then tags `vx.y.z` and creates the GitHub Release from the CHANGELOG section. Edit the release afterwards if it needs highlights beyond those notes.

## Failed publication

- **Before the publish job** (request verification, CI, build, or smoke test): nothing reached npm. Fix the problem on `main` and dispatch again.
- **After the publish job** (registry wait, tag, or GitHub Release): npm already holds the immutable package. Use **Re-run failed jobs** on the same run; those jobs reuse an existing tag at the published commit and skip an existing Release. Never dispatch the same version again, and do not unpublish.
- **Defective package**: check `npm view @astralyn/minicpa@x.y.z version`. If it exists, deprecate it and release the next patch version.
