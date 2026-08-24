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

function createNode(root: string, relativePath: string): string {
  const nodePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(nodePath), { recursive: true });
  fs.writeFileSync(nodePath, "node");
  return nodePath;
}

function successfulRunner(calls: CommandCall[]): CommandRunner {
  return async (command, args) => {
    calls.push({ command, args });
    return {
      code: 0,
      stdout: args[1] === "is-enabled" ? "enabled\n" : "",
      stderr: "",
    };
  };
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Windows autostart", () => {
  it("inspects the registered command and updates the current-user Run value", async () => {
    const root = tempDir();
    const cliPath = createCli(root);
    const nodePath = createNode(root, path.join("Program Files", "nodejs", "node.exe"));
    const expected = `"${nodePath}" "${cliPath}" start --no-wait`;
    const calls: CommandCall[] = [];
    let registration: "absent" | "enabled" | "stale" = "absent";
    const runCommand: CommandRunner = async (command, args, options) => {
      calls.push({ command, args });
      if (command === "powershell.exe") {
        assert.equal(options?.env?.MINICPA_AUTOSTART_EXPECTED, expected);
        if (registration === "enabled") return { code: 0, stdout: "enabled", stderr: "" };
        if (registration === "stale") return { code: 2, stdout: "stale", stderr: "" };
        return { code: 1, stdout: "absent", stderr: "" };
      }
      registration = args[0] === "add" ? "enabled" : "absent";
      return { code: 0, stdout: "", stderr: "" };
    };
    const deps: AutostartDependencies = {
      platform: "win32",
      nodePath,
      cliPath,
      runCommand,
    };

    assert.equal(await isAutostartEnabled(deps), false);
    await setAutostartEnabled(true, deps);
    assert.equal(await isAutostartEnabled(deps), true);

    registration = "stale";
    assert.equal(await isAutostartEnabled(deps), false);
    registration = "enabled";
    await setAutostartEnabled(false, deps);
    assert.equal(registration, "absent", "an existing registration must toggle off directly");

    const inspect = calls.find((call) => call.command === "powershell.exe");
    assert.ok(inspect?.args.includes("-NoProfile"));
    const add = calls.find((call) => call.args[0] === "add");
    assert.equal(add?.command, "reg.exe");
    assert.ok(add?.args.includes(expected));
    const remove = calls.find((call) => call.args[0] === "delete");
    assert.equal(remove?.command, "reg.exe");
  });

  it("surfaces registry inspection failures", async () => {
    await assert.rejects(
      () =>
        isAutostartEnabled({
          platform: "win32",
          runCommand: async () => ({ code: 3, stdout: "", stderr: "access denied" }),
        }),
      /Failed to inspect autostart: access denied/,
    );
  });
});

describe("macOS autostart", () => {
  it("writes and removes a user LaunchAgent", async () => {
    const home = tempDir();
    const cliPath = createCli(home);
    const nodePath = createNode(home, path.join("opt", "Node & Tools", "node"));
    const deps: AutostartDependencies = {
      platform: "darwin",
      homedir: home,
      nodePath,
      cliPath,
    };

    assert.equal(await isAutostartEnabled(deps), false);
    await setAutostartEnabled(true, deps);
    assert.equal(await isAutostartEnabled(deps), true);

    const plist = path.join(home, "Library", "LaunchAgents", "com.astralyn.minicpa.plist");
    const contents = fs.readFileSync(plist, "utf8");
    assert.match(contents, /<key>RunAtLoad<\/key>\n {2}<true\/>/);
    assert.match(contents, /<key>KeepAlive<\/key>\n {2}<false\/>/);
    assert.ok(contents.includes(nodePath.replace("&", "&amp;")));
    assert.ok(contents.includes("<string>--no-wait</string>"));

    deps.nodePath = createNode(home, path.join("new-node", "node"));
    assert.equal(await isAutostartEnabled(deps), false, "a stale launcher must not report on");
    deps.nodePath = nodePath;

    await setAutostartEnabled(false, deps);
    assert.equal(await isAutostartEnabled(deps), false);
  });

  it("escapes XML path characters and rejects control characters", () => {
    const contents = launchAgentContents("/A&B/node", "/tmp/<cpa>/cli.js");
    assert.ok(contents.includes("/A&amp;B/node"));
    assert.ok(contents.includes("/tmp/&lt;cpa&gt;/cli.js"));
    assert.throws(
      () => launchAgentContents("/node", "/tmp/bad\npath/cli.js"),
      /cannot contain control characters/,
    );
  });

  it("surfaces LaunchAgent inspection errors", async () => {
    const home = tempDir();
    const plist = path.join(home, "Library", "LaunchAgents", "com.astralyn.minicpa.plist");
    fs.mkdirSync(plist, { recursive: true });

    await assert.rejects(() => isAutostartEnabled({ platform: "darwin", homedir: home }));
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
      nodePath: createNode(home, path.join("opt", "node", "bin", "node")),
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

    assert.deepEqual(calls[1], {
      command: "systemctl",
      args: ["--user", "is-enabled", "minicpa.service"],
    });

    await setAutostartEnabled(false, deps);
    assert.deepEqual(calls[2], {
      command: "systemctl",
      args: ["--user", "disable", "minicpa.service"],
    });
    assert.equal(await isAutostartEnabled(deps), false);
  });

  it("reports the systemd enablement state and surfaces inspection failures", async () => {
    const home = tempDir();
    const configHome = path.join(home, "config");
    const cliPath = createCli(home);
    let inspection: "disabled" | "enabled-runtime" | "error" = "disabled";
    const deps: AutostartDependencies = {
      platform: "linux",
      homedir: home,
      env: { XDG_CONFIG_HOME: configHome },
      cliPath,
      runCommand: async (_command, args) => {
        if (args[1] !== "is-enabled") return { code: 0, stdout: "", stderr: "" };
        if (inspection === "disabled") return { code: 1, stdout: "disabled\n", stderr: "" };
        if (inspection === "enabled-runtime") {
          return { code: 0, stdout: "enabled-runtime\n", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "user manager unavailable" };
      },
    };

    await setAutostartEnabled(true, deps);
    assert.equal(await isAutostartEnabled(deps), false);

    inspection = "enabled-runtime";
    assert.equal(await isAutostartEnabled(deps), false, "runtime enablement is not persistent");

    inspection = "error";
    await assert.rejects(
      () => isAutostartEnabled(deps),
      /Failed to inspect autostart: user manager unavailable/,
    );
  });

  it("escapes systemd argument syntax and rejects control characters", () => {
    const contents = systemdUnitContents("/opt/node%24/node", `/tmp/\${cache}/a"b/cli.js`);
    assert.ok(contents.includes(`ExecStart="/opt/node%%24/node" "/tmp/$\${cache}/a\\"b/cli.js"`));
    assert.throws(
      () => systemdUnitContents("/node", "/tmp/bad\npath/cli.js"),
      /cannot contain control characters/,
    );
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
