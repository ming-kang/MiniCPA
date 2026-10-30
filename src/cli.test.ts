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
function runCli(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): {
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
      MINICPA_API_URL: undefined,
      ...extraEnv,
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
    assert.match(noArgs.stdout, /Quick start:[\s\S]*cpa init[\s\S]*cpa start[\s\S]*cpa web/);
    assert.doesNotMatch(noArgs.stdout, /Quick start:[\s\S]*cpa update/);
    assert.match(noArgs.stdout, /-v, --version\s+Show the MiniCPA version/);
    assert.doesNotMatch(noArgs.stdout, /--no-wait/);
  });

  it("groups exactly the visible commands in root help", () => {
    const { status, stdout } = runCli(["--help"]);
    assert.equal(status, 0);

    for (const heading of ["Lifecycle", "Interfaces", "Updates"]) {
      assert.match(stdout, new RegExp(`^${heading}:$`, "m"));
    }
    const listed = [...stdout.matchAll(/^ {2}([a-z]+)(?: \[[^\]]+\])*\s{2,}\S/gm)].map(
      (match) => match[1],
    );
    assert.deepEqual(listed, [
      "init",
      "start",
      "stop",
      "restart",
      "status",
      "auto",
      "web",
      "tui",
      "logs",
      "update",
      "upgrade",
    ]);
    assert.match(
      stdout,
      /^ {2}start\s+Start CLIProxyAPI in the background$/m,
      "--no-wait is hidden",
    );
    assert.match(stdout, /^ {2}logs \[options\]\s+/m);
    assert.match(stdout, /^ {2}auto \[mode\]\s+Show or set CLIProxyAPI autostart at login$/m);
    assert.match(stdout, /^ {2}web\s+Print and open the Web panel URL$/m);
  });

  it("shows help for autostart without changing its state", () => {
    const auto = runCli(["auto", "--help"]);

    assert.equal(auto.status, 0);
    assert.equal(auto.stderr, "");
    assert.match(auto.stdout, /Usage: cpa auto/);
    assert.match(auto.stdout, /Arguments:\s+mode\s+Turn autostart on or off/);
    assert.match(auto.stdout, /choices: "on", "off"/);
  });

  it("describes update and upgrade scopes and links between them", () => {
    const update = runCli(["update", "--help"]);
    const upgrade = runCli(["upgrade", "--help"]);

    assert.equal(update.status, 0);
    assert.equal(update.stderr, "");
    assert.match(update.stdout, /Update CLIProxyAPI \(restarts it only if replaced\)/);
    assert.match(update.stdout, /owns its configuration and Web panel; updates never touch them/);
    assert.match(update.stdout, /To upgrade MiniCPA itself, run cpa upgrade\./);

    assert.equal(upgrade.status, 0);
    assert.equal(upgrade.stderr, "");
    assert.match(upgrade.stdout, /Upgrade MiniCPA itself through npm/);
    assert.match(upgrade.stdout, /never stops, restarts, or updates CLIProxyAPI/);
    assert.match(upgrade.stdout, /To update CLIProxyAPI, run cpa update/);
    assert.match(upgrade.stdout, /--force/);
  });

  it("rejects removed commands, subcommands, and flags without touching the root", () => {
    for (const args of [
      ["open"],
      ["clean"],
      ["root"],
      ["temp"],
      ["version"],
      ["home"],
      ["doctor"],
      ["help", "start"],
      ["update", "check"],
      ["upgrade", "check"],
      ["update", "--all"],
      ["update", "--binary"],
      ["update", "--panel"],
      ["logs", "--legacy"],
      ["init", "--force"],
      ["-V"],
    ]) {
      const result = runCli(args);
      assert.equal(result.status, 1, args.join(" "));
      assert.equal(result.stdout, "", args.join(" "));
      assert.match(result.stderr, /unknown (command|option)|too many arguments/, args.join(" "));
      assert.deepEqual(fs.readdirSync(result.root), [], args.join(" "));
    }
  });

  it("reports an unknown command exactly once with a suggestion", () => {
    // Commander's Command.error() already writes to stderr before exitOverride throws,
    // so the top-level catch must not print the same message a second time.
    const { status, stderr } = runCli(["stop-it"]);
    assert.equal(status, 1);
    assert.equal(stderr.match(/unknown command/g)?.length, 1);
    assert.match(stderr, /Did you mean stop\?/);
  });

  it("uses an explicit API URL before a subcommand instead of reading configuration", () => {
    const result = runCli(["--api-url", "https://[::1]:19443/", "status"], {
      MINICPA_API_URL: "http://env.example:18080",
    });
    assert.equal(result.status, 1, "a new instance is stopped");
    assert.match(result.stdout, /^API\s+https:\/\/\[::1\]:19443$/m);
    assert.match(result.stdout, /^Web\s+https:\/\/\[::1\]:19443\/management\.html$/m);
    assert.doesNotMatch(result.stdout, /env\.example/);
  });

  it("accepts the MiniCPA connection URL through the environment", () => {
    const result = runCli(["status"], { MINICPA_API_URL: "http://127.0.0.1:19444/" });
    assert.match(result.stdout, /^API\s+http:\/\/127\.0\.0\.1:19444$/m);
  });

  it("shows both versions and the home in status", () => {
    const { stdout, root } = runCli(["status"]);
    assert.match(stdout, /^Status\s+not initialized \(run: cpa init\)$/m);
    assert.match(stdout, new RegExp(`^MiniCPA\\s+${pkgVersion.replaceAll(".", "\\.")}$`, "m"));
    assert.match(stdout, /^CLIProxyAPI\s+not installed$/m);
    assert.ok(stdout.includes(`Home         ${root}`), stdout);
  });

  it("rejects credential-bearing connection URLs before initializing anything", () => {
    const result = runCli(["--api-url", "https://user:private-password@example.com", "init"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /absolute HTTP\(S\) base URL/);
    assert.doesNotMatch(result.stderr, /private-password/);
    assert.deepEqual(fs.readdirSync(result.root), []);
  });

  for (const flag of ["-v", "--version"]) {
    it(`prints exactly the package version for ${flag}`, () => {
      const { status, stdout, stderr } = runCli([flag]);
      assert.equal(status, 0);
      assert.equal(stdout, `${pkgVersion}\n`);
      assert.equal(stderr, "");
    });
  }

  it("does not intercept global version flags after a subcommand", () => {
    const { status, stdout, stderr } = runCli(["update", "-v"]);
    assert.equal(status, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /unknown option '-v'/);
  });

  it("parses update --version as the CLIProxyAPI pin, not the global version flag", () => {
    const { status, stdout, stderr } = runCli(["update", "--version"]);
    assert.equal(status, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /option '--version <version>' argument missing/);
  });
});
