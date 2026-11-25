# Development Rules

## Code

- Use clear names and structure to carry intent.
- Don't use comments. Unless code can't express something non-obvious (a why or an external constraint), and keep it short.

## Docs

- `CHANGELOG.md`: Log only user-visible changes since the last release under `## [Unreleased]`.

## Git

- Commit only when the user asks. Stage explicit paths; check `git status` and the staged diff before committing.
- Use Conventional Commits: `<type>[(scope)]: <summary>`.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `--no-verify`.
