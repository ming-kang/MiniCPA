# Releasing MiniCPA

MiniCPA publishes `@astralyn/minicpa` from `.github/workflows/publish.yml` with npm Trusted Publishing (OIDC). The permanent workflow must not use `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or another token fallback.

## Trusted Publisher configuration

Configure the npm package with these values:

- Provider: GitHub Actions
- GitHub owner: `ming-kang`
- Repository: `MiniCPA`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`
- Environment: leave empty unless the workflow is changed to use a protected GitHub environment

The workflow requires `contents: read` and `id-token: write`, runs only from `main`, publishes a previously verified tarball, and verifies the registry package and provenance afterwards.

## First-package bootstrap

Skip this section once the npm package exists. npm normally exposes Trusted Publisher settings only after the package has been created. Do not publish a known-unsafe stable version merely to create the settings page.

If `npm view @astralyn/minicpa version` still returns E404:

1. Start from the exact reviewed commit intended for `0.1.3` in a temporary clean worktree.
2. Change only that worktree to `0.1.3-rc.0` with `npm version 0.1.3-rc.0 --no-git-tag-version`.
3. Run the full quality gate and package verifier.
4. Publish the verified tarball once with the local maintainer login and the non-default `next` tag:

   ```bash
   npm publish <verified-tarball.tgz> --tag next --access public --registry=https://registry.npmjs.org
   ```

5. Configure the Trusted Publisher above. Do not add an npm token to GitHub Actions.
6. Delete the temporary worktree. Publish stable `0.1.3` only through the OIDC workflow.

The prerelease remains immutable in npm. The `next` dist-tag may be removed after stable publication with `npm dist-tag rm @astralyn/minicpa next`.

## Stable release checklist

1. Update `package.json` and `package-lock.json` to the exact release version.
2. Move release notes from `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD`, leaving an empty `Unreleased` section.
3. Run locally:

   ```bash
   npm ci
   npm run audit:prod
   npm run lint
   npm test
   npm run build
   VERSION="$(node -p "require('./package.json').version")"
   PACKAGE_DIR="$(mktemp -d)"
   npm pack --ignore-scripts --pack-destination "$PACKAGE_DIR"
   npm run verify:package-install -- "$PACKAGE_DIR/astralyn-minicpa-$VERSION.tgz" "$VERSION"
   npm publish --dry-run --access public --provenance
   rm -rf "$PACKAGE_DIR"
   ```

4. Commit and push `main`; wait for Ubuntu, Windows, and macOS CI.
5. Dispatch `Publish` from `main` with the exact version input. The workflow validates the version and changelog, builds, packs, installs the tarball, publishes through OIDC, checks provenance, and installs the registry package again.
6. Verify independently:

   ```bash
   npm view @astralyn/minicpa version dist-tags --json
   npx --yes @astralyn/minicpa@x.y.z --version
   ```

7. Only after npm publication succeeds, create and push `vX.Y.Z`, then publish the matching GitHub Release. GitHub Releases do not trigger npm publication.
8. For the first stable release, install `0.1.3-rc.0` globally in an isolated prefix and verify that `cpa upgrade` replaces it with stable `0.1.3`.

If publication fails before the registry contains the version, fix the release commit and rerun the workflow. npm versions are immutable: if the version exists but its artifact or provenance is wrong, do not overwrite or unpublish it; deprecate it if necessary and prepare the next patch version.
