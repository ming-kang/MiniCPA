import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  type AutostartDependencies,
  isAutostartEnabled,
  launchAgentContents,
  setAutostartEnabled,
  systemdUnitContents,
} from "./autostart.js";

const temps: string[] = [];

type CommandCall = {
  command: string;
  args: string[];
};

type CommandRunner = NonNullable<AutostartDependencies["runCommand"]>;

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-autostart-"));
  temps.push(dir);
  return dir;
}

function createCli(root: string): string {
  const cliPath = path.join(root, "dist", "cli.js");
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, "// cli");
  return cliPath;
}

function successfulRunner(calls: CommandCall[]): CommandRunner {
  return async (command, args) => {
    calls.push({ command, args });
    return { code: 0, stdout: "", stderr: "" };
  };
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Windows autostart", () => {
  it("queries and updates the current-user Run value", async () => {
    const root = tempDir();
    const cliPath = createCli(root);
    const calls: CommandCall[] = [];
    let queryCode = 1;
    const runCommand: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "query") return { code: queryCode, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const deps: AutostartDependencies = {
      platform: "win32",
      nodePath: String.raw`C:\Program Files\nodejs\node.exe`,
      cliPath,
      runCommand,
    };

    assert.equal(await isAutostartEnabled(deps), false);
    queryCode = 0;
    assert.equal(await isAutostartEnabled(deps), true);

    await setAutostartEnabled(true, deps);
    const add = calls.find((call) => call.args[0] === "add");
    assert.equal(add?.command, "reg.exe");
    assert.ok(add?.args.includes("MiniCPA"));
    assert.ok(
      add?.args.includes(`"C:\\Program Files\\nodejs\\node.exe" "${cliPath}" start --no-wait`),
    );

    await setAutostartEnabled(false, deps);
    const remove = calls.find((call) => call.args[0] === "delete");
    assert.equal(remove?.command, "reg.exe");
    assert.ok(remove?.args.includes("MiniCPA"));
  });
});

describe("macOS autostart", () => {
  it("writes and removes a user LaunchAgent", async () => {
    const home = tempDir();
    const cliPath = createCli(home);
    const deps: AutostartDependencies = {
      platform: "darwin",
      homedir: home,
      nodePath: "/opt/Node & Tools/node",
      cliPath,
    };

    assert.equal(await isAutostartEnabled(deps), false);
    await setAutostartEnabled(true, deps);
    assert.equal(await isAutostartEnabled(deps), true);

    const plist = path.join(home, "Library", "LaunchAgents", "com.astralyn.minicpa.plist");
    const contents = fs.readFileSync(plist, "utf8");
    assert.match(contents, /<key>RunAtLoad<\/key>\n {2}<true\/>/);
    assert.match(contents, /<key>KeepAlive<\/key>\n {2}<false\/>/);
    assert.ok(contents.includes("/opt/Node &amp; Tools/node"));
    assert.ok(contents.includes("<string>--no-wait</string>"));

    await setAutostartEnabled(false, deps);
    assert.equal(await isAutostartEnabled(deps), false);
  });

  it("escapes XML path characters", () => {
    const contents = launchAgentContents("/A&B/node", "/tmp/<cpa>/cli.js");
    assert.ok(contents.includes("/A&amp;B/node"));
    assert.ok(contents.includes("/tmp/&lt;cpa&gt;/cli.js"));
  });
});

describe("Linux autostart", () => {
  it("writes, enables, disables, and removes a systemd user unit", async () => {
    const home = tempDir();
    const configHome = path.join(home, "config");
    const cliPath = createCli(home);
    const calls: CommandCall[] = [];
    const deps: AutostartDependencies = {
      platform: "linux",
      homedir: home,
      env: { XDG_CONFIG_HOME: configHome },
      nodePath: "/opt/node/bin/node",
      cliPath,
      runCommand: successfulRunner(calls),
    };

    assert.equal(await isAutostartEnabled(deps), false);
    await setAutostartEnabled(true, deps);
    assert.equal(await isAutostartEnabled(deps), true);

    const unit = path.join(configHome, "systemd", "user", "minicpa.service");
    const contents = fs.readFileSync(unit, "utf8");
    assert.match(contents, /^Type=oneshot$/m);
    assert.match(contents, /^RemainAfterExit=yes$/m);
    assert.match(contents, /start --no-wait/);
    assert.deepEqual(calls[0], {
      command: "systemctl",
      args: ["--user", "enable", "minicpa.service"],
    });

    await setAutostartEnabled(false, deps);
    assert.deepEqual(calls[1], {
      command: "systemctl",
      args: ["--user", "disable", "minicpa.service"],
    });
    assert.equal(await isAutostartEnabled(deps), false);
  });

  it("escapes systemd argument syntax", () => {
    const contents = systemdUnitContents("/opt/node%24/node", '/tmp/a"b/cli.js');
    assert.ok(contents.includes('ExecStart="/opt/node%%24/node" "/tmp/a\\"b/cli.js"'));
  });

  it("removes the unit when systemctl cannot enable it", async () => {
    const home = tempDir();
    const configHome = path.join(home, "config");
    const cliPath = createCli(home);
    const deps: AutostartDependencies = {
      platform: "linux",
      homedir: home,
      env: { XDG_CONFIG_HOME: configHome },
      cliPath,
      runCommand: async () => ({ code: 1, stdout: "", stderr: "no user manager" }),
    };

    await assert.rejects(() => setAutostartEnabled(true, deps), /no user manager/);
    assert.equal(await isAutostartEnabled(deps), false);
  });
});

describe("unsupported platform", () => {
  it("rejects autostart operations", async () => {
    await assert.rejects(
      () => isAutostartEnabled({ platform: "freebsd" }),
      /not supported on freebsd/,
    );
  });
});
