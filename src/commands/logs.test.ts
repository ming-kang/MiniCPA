import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { cpaHome, cpaLayout } from "../paths.js";
import { runtimeErrorLogFiles } from "../runtime-logs.js";
import { captureConsole, createIsolatedTestEnv } from "../test-fixtures/test-env.js";
import { parseLogLineCount, runLogs } from "./logs.js";

let env: ReturnType<typeof createIsolatedTestEnv> | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
  delete process.env.writable_path;
});
function setup(): ReturnType<typeof cpaLayout> {
  env = createIsolatedTestEnv("minicpa-native-logs-");
  const layout = cpaLayout(cpaHome());
  fs.mkdirSync(layout.logsDir, { recursive: true });
  fs.writeFileSync(layout.runtimeLogFile, "native one\nnative two\n");
  return layout;
}

describe("parseLogLineCount", () => {
  it("accepts positive whole numbers", () => {
    assert.equal(parseLogLineCount("80"), 80);
  });

  it("rejects invalid values", () => {
    for (const value of ["0", "-1", "12.5", "12logs", "", "999999999999999999999"]) {
      assert.throws(() => parseLogLineCount(value), /positive whole number/);
    }
  });
});

describe("native logs", () => {
  it("explains where logs will appear when none exist yet", async () => {
    env = createIsolatedTestEnv("minicpa-native-logs-");
    await assert.rejects(() => runLogs({}), /No CLIProxyAPI log in .* yet[\s\S]*logging-to-file/);
    await assert.rejects(() => runLogs({ follow: true }), /No CLIProxyAPI log/);
    await assert.rejects(() => runLogs({ errOnly: true }), /No request-error logs in /);
  });

  it("tails main.log under a file header", async () => {
    const layout = setup();
    const output = await captureConsole(() => runLogs({ lines: 1 }));
    assert.deepEqual(output.stdout, [`=== ${layout.runtimeLogFile} ===`, "native two"]);
  });

  it("ignores stdout/stderr captures left by MiniCPA 0.4.3 and earlier", async () => {
    const layout = setup();
    fs.writeFileSync(path.join(layout.logsDir, "cpa.log"), "old stdout\n");
    fs.writeFileSync(path.join(layout.logsDir, "cpa.err.log"), "old stderr\n");
    const output = await captureConsole(() => runLogs({}));
    assert.doesNotMatch(output.stdout.join("\n"), /old stdout|old stderr/);
  });

  it("selects only the ten newest native error logs by modification time", async () => {
    const layout = setup();
    const files: string[] = [];
    for (let index = 0; index < 12; index++) {
      const file = path.join(layout.logsDir, `error-${String(12 - index).padStart(2, "0")}.log`);
      fs.writeFileSync(file, `request ${index}\n`);
      const time = new Date(1000 + index * 1000);
      fs.utimesSync(file, time, time);
      files.push(file);
    }
    assert.deepEqual(runtimeErrorLogFiles(cpaHome()), files.slice(-10));
    const output = await captureConsole(() => runLogs({ errOnly: true }));
    assert.match(output.stdout.join("\n"), /request 11/);
    assert.doesNotMatch(output.stdout.join("\n"), /native one/);
  });

  it("honors the upstream lowercase writable_path override", async () => {
    setup();
    const writable = path.join(env!.baseDir, "external");
    fs.mkdirSync(path.join(writable, "logs"), { recursive: true });
    fs.writeFileSync(path.join(writable, "logs", "main.log"), "external native\n");
    process.env.writable_path = writable;
    const output = await captureConsole(() => runLogs({}));
    assert.match(output.stdout.join("\n"), /external native/);
    assert.doesNotMatch(output.stdout.join("\n"), /native one/);
  });
});
