import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  type AutostartDependencies,
  inspectAutostartState,
  LINGER_HINT,
  lingerHint,
  launchAgentContents,
  setAutostartEnabled,
  systemdUnitContents,
  windowsVbsContents,
} from "./autostart.js";
import type { CommandResult } from "./runtime.js";

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

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Windows autostart", () => {
  // Registry facts the inspect script would report. The launcher is a real file
  // on disk (Node reads it directly), so it is not simulated here; the verdict
  // is derived in TypeScript and covered on every platform.
  type WindowsScenario = {
    runValue?: string;
    approvalByte?: number;
  };

  const base64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");

  function factsJson(scenario: WindowsScenario): string {
    return JSON.stringify({
      run: scenario.runValue === undefined ? null : base64(scenario.runValue),
      approval:
        scenario.approvalByte === undefined
          ? null
          : Buffer.from([scenario.approvalByte]).toString("base64"),
    });
  }

  it("distinguishes off, on, stale, and OS-disabled registrations", async () => {
    const root = tempDir();
    const cliPath = createCli(root);
    const nodePath = createNode(root, path.join("Program Files", "nodejs", "node.exe"));
    const wscriptPath = path.join(root, "Windows", "System32", "wscript.exe");
    const vbsPath = path.join(root, "AppData", "Local", "MiniCPA", "minicpa-autostart.vbs");
    const launcherCommand = `"${wscriptPath}" "${vbsPath}"`;

    /** Put the launcher on disk exactly as writeWindowsLauncher would, or remove it. */
    function putLauncher(contents: string | undefined): void {
      if (contents === undefined) {
        fs.rmSync(vbsPath, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(vbsPath), { recursive: true });
      fs.writeFileSync(vbsPath, Buffer.from(`\uFEFF${contents}`, "utf16le"));
    }

    let scenario: WindowsScenario = {};
    const calls: CommandCall[] = [];
    const runCommand: CommandRunner = async (command, args, options) => {
      calls.push({ command, args });
      const mode = options?.env?.MINICPA_AUTOSTART_MODE;
      if (mode !== undefined) {
        // The set script must clear StartupApproved in the same pass.
        assert.ok(args.at(-1)?.includes("StartupApproved"));
        assert.ok(args.at(-1)?.includes("DeleteValue"));
        // Only the registry is simulated: setWindowsAutostart writes and
        // removes the real launcher file itself.
        scenario = {
          runValue: mode === "on" ? options?.env?.MINICPA_AUTOSTART_EXPECTED : undefined,
          approvalByte: undefined,
        };
        return { code: 0, stdout: "", stderr: "" };
      }

      // Inspection reads the registry only; it passes no launcher details.
      assert.equal(options?.env?.MINICPA_AUTOSTART_EXPECTED, undefined);
      return { code: 0, stdout: factsJson(scenario), stderr: "" };
    };
    const deps: AutostartDependencies = {
      platform: "win32",
      homedir: root,
      env: { SystemRoot: path.join(root, "Windows") },
      nodePath,
      cliPath,
      runCommand,
    };

    // Verdict precedence is off -> stale -> disabled -> on: a registration that
    // diverges from what MiniCPA generates would not start MiniCPA even if the
    // user re-enabled it, so staleness outranks the OS disable bit. Both are
    // repaired by the same `cpa auto`.
    for (const [name, reported, launcher, expectedState] of [
      ["no Run value", {}, undefined, "off"],
      [
        "foreign Run value",
        { runValue: '"C:\\elsewhere\\wscript.exe" "C:\\x.vbs"' },
        undefined,
        "stale",
      ],
      [
        "OS-disabled bit over a divergent registration",
        { runValue: launcherCommand, approvalByte: 3 },
        undefined,
        "stale",
      ],
      [
        "OS-disabled bit over an intact registration",
        { runValue: launcherCommand, approvalByte: 3 },
        windowsVbsContents(nodePath, cliPath),
        "disabled",
      ],
      ["missing launcher file", { runValue: launcherCommand }, undefined, "stale"],
      ["rewritten launcher file", { runValue: launcherCommand }, "' tampered launcher", "stale"],
    ] as const) {
      scenario = reported as WindowsScenario;
      putLauncher(launcher);
      assert.equal(await inspectAutostartState(deps), expectedState, name);
    }

    await setAutostartEnabled(true, deps);
    assert.equal(await inspectAutostartState(deps), "on");

    const vbs = fs.readFileSync(vbsPath);
    assert.ok(
      vbs.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])),
      "launcher must be UTF-16LE with a BOM so non-ANSI paths survive",
    );
    assert.equal(
      vbs.subarray(2).toString("utf16le"),
      windowsVbsContents(nodePath, cliPath),
      "launcher content must match what inspection expects",
    );

    await setAutostartEnabled(false, deps);
    assert.equal(fs.existsSync(vbsPath), false, "disabling must remove the launcher");
    assert.equal(await inspectAutostartState(deps), "off");

    assert.ok(calls.every((call) => call.command === "powershell.exe"));
    assert.ok(calls.every((call) => call.args.includes("-NoProfile")));
  });

  it("makes disabling idempotent and surfaces registry inspection failures", async () => {
    const root = tempDir();
    const deps: AutostartDependencies = {
      platform: "win32",
      homedir: root,
      env: { SystemRoot: path.join(root, "Windows") },
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    };
    let mode: string | undefined;
    await setAutostartEnabled(false, {
      ...deps,
      runCommand: async (_command, _args, options) => {
        mode = options?.env?.MINICPA_AUTOSTART_MODE;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(mode, "off");

    await assert.rejects(
      () =>
        inspectAutostartState({
          ...deps,
          runCommand: async () => ({ code: 3, stdout: "", stderr: "access denied" }),
        }),
      /Failed to inspect autostart: access denied/,
    );

    // A zero exit with an unusable payload must surface as an inspect failure
    // rather than a raw decoding TypeError from deep inside the verdict.
    for (const stdout of ['{"run":123}', '{"run":"eA==","approval":{}}', "not json", "[]"]) {
      await assert.rejects(
        () =>
          inspectAutostartState({
            ...deps,
            runCommand: async () => ({ code: 0, stdout, stderr: "" }),
          }),
        /Failed to inspect autostart/,
        stdout,
      );
    }
  });

  it("removes the launcher when the registry write fails", async () => {
    const root = tempDir();
    const cliPath = createCli(root);
    const vbsPath = path.join(root, "AppData", "Local", "MiniCPA", "minicpa-autostart.vbs");
    const deps: AutostartDependencies = {
      platform: "win32",
      homedir: root,
      env: { SystemRoot: path.join(root, "Windows") },
      cliPath,
      runCommand: async () => ({ code: 3, stdout: "", stderr: "access denied" }),
    };

    await assert.rejects(
      () => setAutostartEnabled(true, deps),
      /Failed to enable autostart: access denied/,
    );
    assert.equal(fs.existsSync(vbsPath), false, "a failed enable must not leave a launcher behind");
  });

  it("escapes VBS string literals and rejects control characters", () => {
    const contents = windowsVbsContents(
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Users\\a b\\cli.js",
    );
    assert.ok(
      contents.includes(
        'shell.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\a b\\cli.js"" start --no-wait", 0, False',
      ),
    );
    assert.ok(contents.includes('Set shell = CreateObject("WScript.Shell")'));
    assert.throws(
      () => windowsVbsContents("/node", "/tmp/bad\npath/cli.js"),
      /cannot contain control characters/,
    );
  });
});

describe("macOS autostart", () => {
  it("writes, inspects, re-enables, and removes a user LaunchAgent", async () => {
    const home = tempDir();
    const cliPath = createCli(home);
    const nodePath = createNode(home, path.join("opt", "Node & Tools", "node"));
    const calls: CommandCall[] = [];
    let osDisabled = false;
    const deps: AutostartDependencies = {
      platform: "darwin",
      homedir: home,
      uid: 501,
      nodePath,
      cliPath,
      runCommand: async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "enable") {
          osDisabled = false;
          return { code: 0, stdout: "", stderr: "" };
        }
        return {
          code: 0,
          stdout: osDisabled
            ? 'disabled services = { "com.astralyn.minicpa" => true }'
            : 'disabled services = { "com.astralyn.minicpa" => false }',
          stderr: "",
        };
      },
    };

    assert.equal(await inspectAutostartState(deps), "off");
    assert.deepEqual(calls, [], "an absent plist must not spawn launchctl");
    await setAutostartEnabled(true, deps);
    assert.equal(await inspectAutostartState(deps), "on");

    const plist = path.join(home, "Library", "LaunchAgents", "com.astralyn.minicpa.plist");
    const contents = fs.readFileSync(plist, "utf8");
    assert.match(contents, /<key>RunAtLoad<\/key>\n {2}<true\/>/);
    assert.match(contents, /<key>KeepAlive<\/key>\n {2}<false\/>/);
    assert.ok(contents.includes(nodePath.replace("&", "&amp;")));
    assert.ok(contents.includes("<string>--no-wait</string>"));
    assert.deepEqual(calls[0], {
      command: "launchctl",
      args: ["enable", "gui/501/com.astralyn.minicpa"],
    });

    osDisabled = true;
    assert.equal(await inspectAutostartState(deps), "disabled");
    await setAutostartEnabled(true, deps);
    assert.equal(osDisabled, false, "enabling must clear launchctl's disabled override");

    deps.nodePath = createNode(home, path.join("new-node", "node"));
    assert.equal(await inspectAutostartState(deps), "stale");
    deps.nodePath = nodePath;

    await setAutostartEnabled(false, deps);
    assert.equal(await inspectAutostartState(deps), "off");
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

  it("surfaces inspection errors and removes a plist when launchctl enable throws", async () => {
    const home = tempDir();
    const cliPath = createCli(home);
    const deps: AutostartDependencies = {
      platform: "darwin",
      homedir: home,
      uid: 501,
      cliPath,
      runCommand: async () => {
        throw new Error("launchctl unavailable");
      },
    };
    const plist = path.join(home, "Library", "LaunchAgents", "com.astralyn.minicpa.plist");

    await assert.rejects(() => setAutostartEnabled(true, deps), /launchctl unavailable/);
    assert.equal(fs.existsSync(plist), false);

    fs.mkdirSync(plist, { recursive: true });
    await assert.rejects(() => inspectAutostartState(deps));
  });
});

describe("Linux autostart", () => {
  it("writes, enables, inspects, disables, and removes a systemd user unit", async () => {
    const home = tempDir();
    const configHome = path.join(home, ".config");
    const dataHome = path.join(home, "data home");
    const cliPath = createCli(home);
    const calls: CommandCall[] = [];
    let enablement: "enabled" | "disabled" = "disabled";
    const deps: AutostartDependencies = {
      platform: "linux",
      homedir: home,
      env: { XDG_CONFIG_HOME: path.join(home, "shell-config"), XDG_DATA_HOME: dataHome },
      nodePath: createNode(home, path.join("opt", "node", "bin", "node")),
      cliPath,
      runCommand: async (command, args) => {
        calls.push({ command, args });
        if (args[1] === "enable") enablement = "enabled";
        if (args[1] === "disable") enablement = "disabled";
        if (args[1] === "is-enabled") {
          return {
            code: enablement === "enabled" ? 0 : 1,
            stdout: `${enablement}\n`,
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    assert.equal(await inspectAutostartState(deps), "off");
    assert.deepEqual(calls, [], "an absent unit must not spawn systemctl --user");
    await setAutostartEnabled(true, deps);
    assert.equal(await inspectAutostartState(deps), "on");

    const unit = path.join(configHome, "systemd", "user", "minicpa.service");
    const contents = fs.readFileSync(unit, "utf8");
    assert.match(contents, /^Type=oneshot$/m);
    assert.match(contents, /^RemainAfterExit=yes$/m);
    assert.ok(
      contents.includes(`Environment="XDG_DATA_HOME=${dataHome.replaceAll("\\", "\\\\")}"`),
    );
    assert.match(contents, /start --no-wait/);
    assert.deepEqual(calls[0], {
      command: "systemctl",
      args: ["--user", "enable", unit],
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
    assert.equal(await inspectAutostartState(deps), "off");
  });

  it("reports disabled and stale registrations without calling them off", async () => {
    const home = tempDir();
    const configHome = path.join(home, ".config");
    const cliPath = createCli(home);
    let inspection: "disabled" | "enabled-runtime" = "disabled";
    let inspectionCalls = 0;
    const deps: AutostartDependencies = {
      platform: "linux",
      homedir: home,
      env: { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: path.join(home, "data") },
      cliPath,
      runCommand: async (_command, args) => {
        if (args[1] !== "is-enabled") return { code: 0, stdout: "", stderr: "" };
        inspectionCalls++;
        return {
          code: inspection === "enabled-runtime" ? 0 : 1,
          stdout: `${inspection}\n`,
          stderr: "",
        };
      },
    };

    await setAutostartEnabled(true, deps);
    assert.equal(await inspectAutostartState(deps), "disabled");
    inspection = "enabled-runtime";
    assert.equal(await inspectAutostartState(deps), "disabled");

    deps.env = { ...deps.env, XDG_DATA_HOME: path.join(home, "new-data") };
    assert.equal(await inspectAutostartState(deps), "stale");
    assert.equal(inspectionCalls, 2, "stale content must not query an unrelated enablement state");
  });

  it("escapes systemd argument and environment syntax", () => {
    const contents = systemdUnitContents(
      "/opt/node%24/node",
      `/tmp/\${cache}/a"b/cli.js`,
      '/data/$cash/"quoted"/%store',
    );
    assert.ok(contents.includes('ExecStart="/opt/node%%24/node" "/tmp/$${cache}/a\\"b/cli.js"'));
    assert.ok(contents.includes('Environment="XDG_DATA_HOME=/data/$cash/\\"quoted\\"/%%store"'));
    assert.throws(
      () => systemdUnitContents("/node", "/tmp/bad\npath/cli.js", "/data"),
      /cannot contain control characters/,
    );
    assert.throws(
      () => systemdUnitContents("/node", "/cli.js", "/bad\ndata"),
      /cannot contain control characters/,
    );
  });

  it("removes the unit when systemctl returns a failure or throws", async () => {
    for (const outcome of ["nonzero", "throw"] as const) {
      const home = tempDir();
      const configHome = path.join(home, ".config");
      const cliPath = createCli(home);
      let commandCalls = 0;
      const deps: AutostartDependencies = {
        platform: "linux",
        homedir: home,
        env: { XDG_CONFIG_HOME: configHome },
        cliPath,
        runCommand: async () => {
          commandCalls++;
          if (outcome === "throw") throw new Error("spawn systemctl ENOENT");
          return { code: 1, stdout: "", stderr: "no user manager" };
        },
      };
      const unit = path.join(configHome, "systemd", "user", "minicpa.service");

      await assert.rejects(
        () => setAutostartEnabled(true, deps),
        outcome === "throw" ? /spawn systemctl ENOENT/ : /no user manager/,
      );
      assert.equal(fs.existsSync(unit), false);
      assert.equal(await inspectAutostartState(deps), "off");
      assert.equal(commandCalls, 1, "an absent unit must not wedge later inspection");
    }
  });

  it("removes the unit even when systemctl cannot disable it", async () => {
    const home = tempDir();
    const configHome = path.join(home, ".config");
    const cliPath = createCli(home);
    let failDisable = false;
    const deps: AutostartDependencies = {
      platform: "linux",
      homedir: home,
      env: { XDG_CONFIG_HOME: configHome },
      cliPath,
      runCommand: async (_command, args) => {
        if (failDisable && args[1] === "disable") throw new Error("user manager disappeared");
        return { code: 0, stdout: args[1] === "is-enabled" ? "enabled\n" : "", stderr: "" };
      },
    };

    await setAutostartEnabled(true, deps);
    failDisable = true;
    await assert.rejects(() => setAutostartEnabled(false, deps), /user manager disappeared/);
    assert.equal(await inspectAutostartState(deps), "off");
  });
});

describe("unsupported platform", () => {
  it("rejects autostart operations", async () => {
    await assert.rejects(
      () => inspectAutostartState({ platform: "freebsd" }),
      /not supported on freebsd/,
    );
  });
});

describe("lingerHint", () => {
  const linux = { platform: "linux" as const, uid: 1000 };

  it("is silent outside Linux without probing anything", async () => {
    let called = false;
    const deps: AutostartDependencies = {
      platform: "darwin",
      uid: 1000,
      runCommand: async () => {
        called = true;
        return { code: 0, stdout: "Linger=no\n", stderr: "" };
      },
    };
    assert.equal(await lingerHint(deps), undefined);
    assert.equal(called, false);
  });

  it("stays silent when linger is confirmed enabled", async () => {
    const hint = await lingerHint({
      ...linux,
      runCommand: async () => ({ code: 0, stdout: "Linger=yes", stderr: "" }),
    });
    assert.equal(hint, undefined);
  });

  it("probes linger for the current user", async () => {
    const calls: CommandCall[] = [];
    await lingerHint({
      ...linux,
      runCommand: async (command, args) => {
        calls.push({ command, args });
        return { code: 0, stdout: "Linger=yes", stderr: "" };
      },
    });
    assert.deepEqual(calls, [
      { command: "loginctl", args: ["show-user", "1000", "--property=Linger"] },
    ]);
  });

  it("hints when linger is off or undeterminable", async () => {
    // Anything short of a confirmed Linger=yes hints: on a headless box silence
    // would hide the gap this note exists to surface.
    const outcomes: Array<[string, CommandResult]> = [
      ["linger off", { code: 0, stdout: "Linger=no\n", stderr: "" }],
      ["nonzero exit", { code: 1, stdout: "", stderr: "No user 1000 known" }],
      ["empty output", { code: 0, stdout: "", stderr: "" }],
      ["unexpected shape", { code: 0, stdout: "Linger=maybe", stderr: "" }],
    ];
    for (const [name, outcome] of outcomes) {
      const hint = await lingerHint({
        ...linux,
        runCommand: async () => outcome,
      });
      assert.equal(hint, LINGER_HINT, name);
    }
  });

  it("hints when the probe throws", async () => {
    const hint = await lingerHint({
      ...linux,
      runCommand: async () => {
        throw new Error("spawn loginctl ENOENT");
      },
    });
    assert.equal(hint, LINGER_HINT);
  });
});

describe("real platform inspection", () => {
  // The Windows registry script is the only embedded foreign-language code here
  // and every other test injects a fake runCommand, so nothing else executes it.
  // macOS/Linux return "off" before ever reaching launchctl/systemctl when no
  // plist/unit exists, so a bare call there would smoke-test nothing (Linux CI
  // also has no user D-Bus session, so `systemctl --user` fails and the test
  // would go intermittently red).
  it("reads a real autostart state through the Windows registry script", {
    skip: process.platform !== "win32",
  }, async () => {
    const state = await inspectAutostartState();
    assert.ok(["on", "off", "stale", "disabled"].includes(state));
  });

  // Optional: kept only while macos-latest runners expose the GUI domain to
  // `launchctl print-disabled gui/<uid>`; drop this test if it fails there.
  it("reads a real autostart state through a matching LaunchAgent plist", {
    skip: process.platform !== "darwin",
  }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-autostart-real-"));
    const nodePath = "/opt/mock-node";
    const cliPath = "/opt/mock-cli.js";
    try {
      const dir = path.join(home, "Library", "LaunchAgents");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "com.astralyn.minicpa.plist"),
        launchAgentContents(nodePath, cliPath),
      );
      const state = await inspectAutostartState({ homedir: home, nodePath, cliPath });
      assert.ok(["on", "disabled"].includes(state));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
