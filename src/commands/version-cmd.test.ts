import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { activeExecutablePath, resolveCpaHome } from "../paths.js";
import { writeInstallState } from "../state.js";
import { captureConsole, createIsolatedTestEnv } from "../test-fixtures/test-env.js";
import { runVersion } from "./version-cmd.js";

let cleanupEnv: (() => void) | undefined;

beforeEach(() => {
  const env = createIsolatedTestEnv("minicpa-version-test-");
  cleanupEnv = env.cleanup;
});

afterEach(() => {
  cleanupEnv?.();
  cleanupEnv = undefined;
});

describe("runVersion", () => {
  it("reports MiniCPA, CLIProxyAPI, and home on an empty installation", async () => {
    const home = resolveCpaHome();
    const { stdout } = await captureConsole(() => runVersion("1.0.0"));

    assert.deepEqual(stdout, [
      "MiniCPA      1.0.0",
      "CLIProxyAPI  (not installed)",
      `Home         ${home}`,
    ]);
  });

  it("reports the recorded runtime version without executing the binary", async () => {
    const home = resolveCpaHome();
    writeInstallState(home, { runtimeVersion: "7.0.0" });
    // Deliberately not executable: read-only version reporting must not spawn it.
    fs.writeFileSync(activeExecutablePath(home), "not a real binary");

    const { stdout } = await captureConsole(() => runVersion("0.2.0"));

    assert.deepEqual(stdout, ["MiniCPA      0.2.0", "CLIProxyAPI  7.0.0", `Home         ${home}`]);
  });
});
