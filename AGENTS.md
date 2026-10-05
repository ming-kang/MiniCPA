# Repository Guidelines

## Git and release

- Stage explicit paths and review the staged diff.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify`; the pre-commit hook is the check gate.
- Use Conventional Commits: `<type>[(scope)]: <summary>`.
- Add user-visible changes to `CHANGELOG.md` under `## [Unreleased]`.
- Follow `RELEASING.md`
