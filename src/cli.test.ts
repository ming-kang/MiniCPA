import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Run the CLI in-source with an isolated MiniCPA root. */
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
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
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("cli smoke", () => {
  it("prints usage for --help with exit 0", () => {
    const { status, stdout } = runCli(["--help"]);
    assert.equal(status, 0);
    assert.match(stdout, /Usage: cpa/);
    assert.match(stdout, /update/);
  });

  it("fails with exit 1 for an unknown command", () => {
    const { status, stderr } = runCli(["definitely-not-a-command"]);
    assert.equal(status, 1);
    assert.match(stderr, /unknown command/i);
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
