# Security & Trust Boundaries

## Isolation boundaries

MiniCPA treats three inputs as hostile by default, for reasons the mechanisms alone do not explain:

- **Child processes**: CLIProxyAPI is a third-party binary, npm is network-facing tooling, and probes invoke platform commands — all spawned inside a user session that may carry GitHub or npm tokens for unrelated work. A token inherited by any of them can leave the machine without MiniCPA ever reading it. Credential stripping is therefore a blanket policy applied to every spawn, not a per-child audit of who might look.
- **Filesystem**: anything in a shared writable location can be pre-created or swapped by another local user, so state, staging, and extraction never leave user-private storage. Archives are hostile input regardless of source: traversal entries, symlink payloads, and decompression bombs are standard abuse, which is why extraction enforces hard bounds instead of trusting upstream release hygiene.
- **Network**: loopback probing and outbound distribution have opposite trust requirements. Probes must tolerate CLIProxyAPI's self-signed localhost certificates and must ignore environment proxies, because a misconfigured proxy must never be able to interfere with — or observe — local service checks. Downloads are remote data end to end: asset URLs come from API responses, so destination hosts are confined to GitHub-controlled infrastructure rather than trusted blindly, and TLS validation is never relaxed.

## Bootstrap Configuration & Web Panel Source

`cpa init` writes a minimal `config.yaml` once. Two of its defaults are trust decisions rather than plain settings:

- **Bootstrap Credentials**: The client API key (`sk-cliproxyapi`) and management password (`CLIPROXYAPI`) are well-known values. The instance listens on `127.0.0.1` with `allow-remote: false`, so they are only reachable locally; change both in the Web panel before exposing CLIProxyAPI beyond this machine.
- **Web Panel Repository**: `panel-github-repository` points at [`seakee/CPA-Manager-Plus`](https://github.com/seakee/CPA-Manager-Plus) instead of CLIProxyAPI's built-in default, and `disable-auto-update-panel: false` lets CLIProxyAPI download and refresh that panel automatically. The panel runs in the browser with the management password, so its publisher is trusted with management access. MiniCPA chose this panel deliberately and considers its maintainer trustworthy; MiniCPA itself never downloads or verifies panel assets — CLIProxyAPI does.

To use a different panel, or to pin the current one, change `panel-github-repository` or set `disable-auto-update-panel: true` in the Web panel or `config.yaml`. MiniCPA never rewrites an existing configuration, so the change persists across `cpa init` and `cpa update`.
