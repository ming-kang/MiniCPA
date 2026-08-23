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
  it("prints identical root help for no arguments, -h, and --help", () => {
    const noArgs = runCli([]);
    const shortHelp = runCli(["-h"]);
    const longHelp = runCli(["--help"]);

    for (const result of [noArgs, shortHelp, longHelp]) {
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
    }
    assert.equal(noArgs.stdout, shortHelp.stdout);
    assert.equal(noArgs.stdout, longHelp.stdout);
    assert.match(noArgs.stdout, /Usage: cpa/);
    assert.match(
      noArgs.stdout,
      /MiniCPA — manage, run, and update one local CLIProxyAPI instance\./,
    );
    assert.match(
      noArgs.stdout,
      /Quick start:[\s\S]*cpa init[\s\S]*cpa update[\s\S]*cpa start[\s\S]*cpa web/,
    );
    assert.match(noArgs.stdout, /-v, -V, --version\s+Show the MiniCPA version/);
  });

  it("groups only the approved visible commands in root help", () => {
    const { status, stdout } = runCli(["--help"]);
    assert.equal(status, 0);

    for (const heading of ["Lifecycle", "Interfaces", "Updates", "Diagnostics", "Information"]) {
      assert.match(stdout, new RegExp(`^${heading}:$`, "m"));
    }
    for (const command of [
      "init",
      "start",
      "stop",
      "restart",
      "status",
      "web",
      "tui",
      "logs",
      "update",
      "upgrade",
      "doctor",
      "version",
      "home",
    ]) {
      assert.match(stdout, new RegExp(`^  ${command}(?: \\[options\\])?\\s{2,}`, "m"));
    }
    for (const hidden of ["open", "clean", "root", "temp", "self-update"]) {
      assert.doesNotMatch(stdout, new RegExp(`^  ${hidden}(?: \\[options\\])?\\s{2,}`, "m"));
    }
    assert.match(
      stdout,
      /^ {2}init \[options\]\s+Set up the CLIProxyAPI configuration and data directories$/m,
    );
    assert.match(stdout, /^ {2}web\s+Open the web management panel$/m);
    assert.match(stdout, /^ {2}tui\s+Open the CLIProxyAPI terminal UI$/m);
  });

  it("keeps web canonical and open as a hidden compatibility command", () => {
    const web = runCli(["web", "--help"]);
    const open = runCli(["open", "--help"]);

    assert.equal(web.status, 0);
    assert.equal(open.status, 0);
    assert.match(web.stdout, /Usage: cpa web/);
    assert.match(open.stdout, /Usage: cpa open/);
    assert.match(web.stdout, /Open the web management panel/);
    assert.match(open.stdout, /Open the web management panel/);
  });

  it("keeps hidden maintenance commands callable", () => {
    for (const command of ["clean", "root", "temp"]) {
      const { status, stdout, stderr } = runCli([command, "--help"]);
      assert.equal(status, 0);
      assert.match(stdout, new RegExp(`Usage: cpa ${command}`));
      assert.equal(stderr, "");
    }
  });

  it("describes update and upgrade scopes and links between them", () => {
    const update = runCli(["update", "--help"]);
    const upgrade = runCli(["upgrade", "--help"]);

    assert.equal(update.status, 0);
    assert.equal(update.stderr, "");
    assert.match(update.stdout, /Update the managed CLIProxyAPI binary and web management panel/);
    assert.match(update.stdout, /Both components are updated by default\./);
    assert.match(update.stdout, /To upgrade MiniCPA itself, run cpa upgrade\./);
    assert.doesNotMatch(update.stdout, /^ {2}--all(?:\s|$)/m);

    assert.equal(upgrade.status, 0);
    assert.equal(upgrade.stderr, "");
    assert.match(upgrade.stdout, /Upgrade the globally installed MiniCPA package through npm/);
    assert.match(upgrade.stdout, /does not update, stop, or restart the managed CLIProxyAPI/);
    assert.match(upgrade.stdout, /To update CLIProxyAPI or the web panel, run cpa update\./);
    assert.match(upgrade.stdout, /--force/);
  });

  it("accepts hidden --all but rejects conflicting update scopes without network access", () => {
    const { status, stdout, stderr } = runCli(["update", "--all", "--panel"]);
    assert.equal(status, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /option '--all' cannot be used with option '--panel'/);
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

  it("exits non-zero for `help <unknown-command>`", () => {
    const { status } = runCli(["help", "nosuchcommand"]);
    assert.notEqual(status, 0);
  });

  for (const flag of ["-v", "-V", "--version"]) {
    it(`prints exactly the package version for ${flag}`, () => {
      const { status, stdout, stderr } = runCli([flag]);
      assert.equal(status, 0);
      assert.equal(stdout, `${pkgVersion}\n`);
      assert.equal(stderr, "");
    });
  }

  it("shows all installed component labels for the version command", () => {
    const { status, stdout, stderr, root } = runCli(["version"]);
    assert.equal(status, 0);
    assert.equal(stderr, "");
    assert.match(stdout, new RegExp(`^MiniCPA\\s+${pkgVersion.replaceAll(".", "\\.")}$`, "m"));
    assert.match(stdout, /^CLIProxyAPI\s+\(not installed\)$/m);
    assert.match(stdout, /^Web panel\s+\(not installed\)$/m);
    assert.ok(stdout.includes(`Home         ${root}`), stdout);
  });

  it("treats the hidden -V spelling like the other version flags before a command", () => {
    const { status, stdout, stderr } = runCli(["-V", "web"]);
    assert.equal(status, 0);
    assert.equal(stdout, `${pkgVersion}\n`);
    assert.equal(stderr, "");
  });

  it("does not intercept global version flags after a subcommand", () => {
    for (const flag of ["-v", "-V"]) {
      const { status, stdout, stderr } = runCli(["update", flag]);
      assert.equal(status, 1);
      assert.equal(stdout, "");
      assert.match(stderr, new RegExp(`unknown option '${flag}'`));
      assert.doesNotMatch(stderr, new RegExp(`^${pkgVersion}$`, "m"));
    }
  });

  it("parses the update version pin without treating it as the global version flag", () => {
    // --panel makes the parsed pin fail locally in assertUpdateScopeFlags, before any network work.
    const { status, stdout, stderr } = runCli(["update", "--panel", "--version", "7.2.66"]);
    assert.equal(status, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /--version/);
    assert.doesNotMatch(stderr, new RegExp(`^${pkgVersion}$`, "m"));
  });

  it("prints the resolved instance home for `home`", () => {
    const { status, stdout, root } = runCli(["home"]);
    assert.equal(status, 0);
    assert.ok(stdout.trim().startsWith(root), `${stdout.trim()} should live under ${root}`);
    assert.match(stdout.trim(), /instances[\\/]default$/);
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
