import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { activeExecutablePath } from "../paths.js";
import { writeInstallState } from "../state.js";
import { readCurrentRuntimeVersion } from "./runtime.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readCurrentRuntimeVersion", () => {
  it("does not trust a recorded version when the binary is missing", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-runtime-"));
    temps.push(home);
    writeInstallState(home, { cpaHome: home, runtimeVersion: "7.0.0" });

    assert.equal(fs.existsSync(activeExecutablePath(home)), false);
    assert.equal(await readCurrentRuntimeVersion(home), undefined);
  });

  it("does not trust a recorded version when the binary cannot be probed", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-runtime-"));
    temps.push(home);
    const executable = activeExecutablePath(home);
    fs.writeFileSync(executable, "not an executable");
    writeInstallState(home, { cpaHome: home, runtimeVersion: "7.0.0" });

    assert.equal(await readCurrentRuntimeVersion(home), undefined);
  });
});
