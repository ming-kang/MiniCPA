import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pkgVersion = (
  JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string }
).version;

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Run the CLI in-source with an isolated MiniCPA root. */
function runCli(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
  root: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-cli-"));
  temps.push(root);
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    env: {
      ...process.env,
      LOCALAPPDATA: root,
      XDG_DATA_HOME: root,
      HOME: root,
      // spawnSync drops undefined entries, so this unsets an inherited CPA_HOME
      // that would otherwise make resolveCpaHome() throw for unrelated reasons.
      CPA_HOME: undefined,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, root };
}

describe("cli smoke", () => {
  it("prints usage for --help with exit 0", () => {
    const { status, stdout } = runCli(["--help"]);
    assert.equal(status, 0);
    assert.match(stdout, /Usage: cpa/);
    assert.match(
      stdout,
      /update \[options\]\s+Update managed CLIProxyAPI binary\/panel, not MiniCPA/,
    );
    assert.match(
      stdout,
      /upgrade \[options\]\s+Upgrade MiniCPA itself from npm, not the managed\s+CLIProxyAPI/,
    );
  });

  it("prints upgrade help without contacting npm", () => {
    const { status, stdout, stderr } = runCli(["upgrade", "--help"]);
    assert.equal(status, 0);
    assert.match(stdout, /Usage: cpa upgrade/);
    assert.match(stdout, /--force/);
    assert.equal(stderr, "");
  });

  it("fails with exit 1 for an unknown command", () => {
    const { status, stderr } = runCli(["definitely-not-a-command"]);
    assert.equal(status, 1);
    assert.match(stderr, /unknown command/i);
  });

  it("reports an unknown command exactly once", () => {
    // Commander's Command.error() already writes to stderr before exitOverride throws,
    // so the top-level catch must not print the same message a second time.
    const { status, stderr } = runCli(["definitely-not-a-command"]);
    assert.equal(status, 1);
    assert.equal(stderr.match(/unknown command/g)?.length, 1);
  });

  it("exits non-zero when invoked with no arguments", () => {
    // Commander writes usage to stderr here; reporting success would make
    // `cpa > usage.txt` produce an empty file yet claim it worked.
    const { status, stdout } = runCli([]);
    assert.notEqual(status, 0);
    assert.equal(stdout.trim(), "");
  });

  it("exits non-zero for `help <unknown-command>`", () => {
    const { status } = runCli(["help", "nosuchcommand"]);
    assert.notEqual(status, 0);
  });

  it("prints the package version for --version with exit 0", () => {
    const { status, stdout } = runCli(["--version"]);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), pkgVersion);
  });

  it("prints the resolved instance home for `home`", () => {
    const { status, stdout, root } = runCli(["home"]);
    assert.equal(status, 0);
    assert.ok(stdout.trim().startsWith(root), `${stdout.trim()} should live under ${root}`);
    assert.match(stdout.trim(), /instances[\\/]default$/);
  });

  it("rejects binary-only update flags combined with --panel", () => {
    const { status, stderr } = runCli(["update", "--panel", "--version", "7.2.66"]);
    assert.equal(status, 1);
    assert.match(stderr, /--version/);
  });

  it("prints the MiniCPA root for `root`", () => {
    const { status, stdout } = runCli(["root"]);
    assert.equal(status, 0);
    assert.match(stdout.trim(), /MiniCPA/);
  });

  it("prints the staging directory for `temp`", () => {
    const { status, stdout } = runCli(["temp"]);
    assert.equal(status, 0);
    assert.match(stdout.trim(), /temp/);
  });
});
