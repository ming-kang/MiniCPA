# Security & Boundary Isolation

MiniCPA enforces defense-in-depth boundaries across process execution, filesystem operations, and network communications.

---

## 1. Process Environment Sanitization

MiniCPA interacts with external registries and APIs that may require authentication tokens (such as `GITHUB_TOKEN`, `GH_TOKEN`, or npm tokens).

To prevent unintended credential leakage:
- **Child Environment Filtering**: Whenever MiniCPA spawns a child process—including the managed CLIProxyAPI daemon, diagnostic commands, and npm subcommands—it sanitizes the child environment.
- **Case-Insensitive Normalization**: Environment variable filtering strips known credential keys across all case variations, neutralizing platform-specific case insensitivity (such as Windows environment blocks).

```
   Parent Process (MiniCPA)
   [ GITHUB_TOKEN, NPM_TOKEN, ... ]
                 |
                 v
   +------------------------------------+
   |   buildCredentialSafeChildEnv()    |
   +------------------------------------+
                 | (Tokens Stripped)
                 v
   Child Process (CLIProxyAPI / npm / probes)
```

---

## 2. Filesystem Boundaries & Symlink Protection

- **Private Workspace Storage**: All runtime state, configuration, and temporary staging trees are created inside user-private application directories (`%LOCALAPPDATA%` on Windows, `~/Library/Application Support` on macOS, and `$XDG_DATA_HOME` on Linux).
- **POSIX Mode Hardening**: Directories and state files are created with private permissions (`0700` and `0600` on POSIX systems), preventing unauthorized multi-user access.
- **Shared `/tmp` Avoidance**: Ephemeral download and extraction files reside in private storage (`<root>/temp`) rather than shared system temporary directories (such as `/tmp` or `C:\Temp`), eliminating vulnerability to symlink replacement and race attacks.
- **Symlink Escape Refusal**: Cleanup routines and path resolvers verify boundaries and refuse to traverse symbolic links or junctions pointing outside authorized staging roots.

---

## 3. Network & Transport Isolation

MiniCPA distinguishes between local daemon probing and outbound package/release distribution:

```
                            +--------------------------+
                            |     Network Clients      |
                            +------------+-------------+
                                         |
                 +-----------------------+-----------------------+
                 |                                               |
                 v                                               v
    [ Local Readiness Probes ]                      [ Outbound Downloads ]
    - Target: Local CLIProxyAPI (127.0.0.1)          - Target: GitHub, npm registry
    - Isolated dispatcher                           - Strict TLS / CA verification
    - Accepts local self-signed TLS certificates    - Strict allowed host whitelisting
    - Bypasses environment proxies                  - Honors HTTP(S)_PROXY & NO_PROXY
```

### Protocol & Security Rules

1. **Proxy Independence for Local Traffic**: Service readiness probes bypass system and environment proxies, ensuring that misconfigured outbound proxies do not intercept or disrupt local loopback communications.
2. **Local TLS Flexibility**: CLIProxyAPI may be configured with local self-signed TLS certificates. MiniCPA's isolated readiness dispatcher permits local certificates while leaving outbound download client validation untouched.
3. **Outbound Domain Boundaries**: Release asset downloads strictly validate destination domains against trusted host whitelists (`github.com`, `api.github.com`, and official GitHub release CDNs), refusing arbitrary redirect targets.

---

## 4. Archive Extraction Security

Binary updates accept compressed archives (`.zip`, `.tar.gz`) from upstream releases. MiniCPA mitigates archive-based vulnerabilities during extraction:

- **Path Traversal Defense**: All archive entry filenames are normalized and verified. Any entry containing directory traversal elements (`../`, `..\`) or absolute paths is rejected before extraction.
- **Resource Limits**:
  - Entry count bounding (preventing zip bomb metadata exhaustion).
  - Path depth bounding (preventing deeply nested directory recursion).
  - Decompressed byte bounding (limiting actual decompressed stream size regardless of declared entry header sizes).

---

## 5. Bootstrap Configuration & Web Panel Source

`cpa init` writes a minimal `config.yaml` once. Two of its defaults are trust decisions rather than plain settings:

- **Bootstrap Credentials**: The client API key (`sk-cliproxyapi`) and management password (`CLIPROXYAPI`) are well-known values. The instance listens on `127.0.0.1` with `allow-remote: false`, so they are only reachable locally; change both in the Web panel before exposing CLIProxyAPI beyond this machine.
- **Web Panel Repository**: `panel-github-repository` points at [`seakee/CPA-Manager-Plus`](https://github.com/seakee/CPA-Manager-Plus) instead of CLIProxyAPI's built-in default, and `disable-auto-update-panel: false` lets CLIProxyAPI download and refresh that panel automatically. The panel runs in the browser with the management password, so its publisher is trusted with management access. MiniCPA chose this panel deliberately and considers its maintainer trustworthy; MiniCPA itself never downloads or verifies panel assets — CLIProxyAPI does.

To use a different panel, or to pin the current one, change `panel-github-repository` or set `disable-auto-update-panel: true` in the Web panel or `config.yaml`. MiniCPA never rewrites an existing configuration, so the change persists across `cpa init` and `cpa update`.
