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
  it("reports all components not installed on empty home", async () => {
    const home = resolveCpaHome();
    const { stdout } = await captureConsole(() => runVersion("1.0.0"));

    assert.equal(stdout.length, 4);
    assert.equal(stdout[0], "MiniCPA      1.0.0");
    assert.equal(stdout[1], "CLIProxyAPI  (not installed)");
    assert.equal(stdout[2], "Web panel    (not installed)");
    assert.equal(stdout[3], `Home         ${home}`);
  });

  it("reports recorded panel version when runtime binary is absent", async () => {
    const home = resolveCpaHome();
    writeInstallState(home, {
      panelVersion: "1.2.0",
    });

    const { stdout } = await captureConsole(() => runVersion("0.2.0"));
    assert.equal(stdout.length, 4);
    assert.equal(stdout[0], "MiniCPA      0.2.0");
    assert.equal(stdout[1], "CLIProxyAPI  (not installed)");
    assert.equal(stdout[2], "Web panel    1.2.0");
    assert.equal(stdout[3], `Home         ${home}`);
  });

  it("reports the recorded runtime version without executing the binary", async () => {
    const home = resolveCpaHome();
    writeInstallState(home, {
      runtimeVersion: "7.0.0",
      panelVersion: "1.2.0",
    });
    // Deliberately not executable: read-only version reporting must not spawn it.
    fs.writeFileSync(activeExecutablePath(home), "not a real binary");

    const { stdout } = await captureConsole(() => runVersion("0.2.0"));

    assert.equal(stdout.length, 4);
    assert.equal(stdout[0], "MiniCPA      0.2.0");
    assert.equal(stdout[1], "CLIProxyAPI  7.0.0");
    assert.equal(stdout[2], "Web panel    1.2.0");
    assert.equal(stdout[3], `Home         ${home}`);
  });
});
