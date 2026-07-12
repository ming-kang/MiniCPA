# CPA startup conventions (MiniCPA)

MiniCPA only wraps process lifecycle and updates. Configuration and provider auth are done in CPA itself (management UI, official `-tui`, or `cli-proxy-api -config ...` flags).

When MiniCPA starts CPA:

- **Working directory** = instance directory (`cpa home`)
- **Args** = `-config <home>/config.yaml`
- **Binary** = `<home>/cli-proxy-api` (or `.exe` on Windows) — replaced in place by `cpa update`
- **Logs** = `<home>/logs/cpa.log`

Default `config.yaml` from `cpa init` uses `auth-dir: auths` (relative to home). Optional `.env` in the same directory is loaded by CPA at startup.

OAuth, routing, api-keys, and management secrets: edit `config.yaml` / `.env` or use CPA’s management UI after `cpa open`.