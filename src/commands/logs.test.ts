import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { cpaHome, cpaLayout } from "../paths.js";
import { runtimeErrorLogFiles } from "../runtime-logs.js";
import { captureConsole, createIsolatedTestEnv } from "../test-fixtures/test-env.js";
import { runLogs } from "./logs.js";

let env: ReturnType<typeof createIsolatedTestEnv> | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});
function setup(): ReturnType<typeof cpaLayout> {
  env = createIsolatedTestEnv("minicpa-native-logs-");
  const layout = cpaLayout(cpaHome());
  fs.mkdirSync(layout.logsDir, { recursive: true });
  fs.writeFileSync(layout.logFile, "old stdout\n");
  fs.writeFileSync(layout.errLogFile, "old stderr\n");
  fs.writeFileSync(layout.runtimeLogFile, "native one\nnative two\n");
  return layout;
}

describe("native logs", () => {
  it("defaults to main.log without mixing in stale stdout/stderr", async () => {
    const layout = setup();
    const output = await captureConsole(() => runLogs({ lines: 1 }));
    assert.match(output.stdout.join("\n"), /main.log[\s\S]*native two/);
    assert.doesNotMatch(output.stdout.join("\n"), /old stdout|old stderr|native one/);
    assert.equal(fs.readFileSync(layout.logFile, "utf8"), "old stdout\n");
  });

  it("keeps explicit legacy output readable even when native logs exist", async () => {
    setup();
    const output = await captureConsole(() => runLogs({ legacy: true, errOnly: true }));
    assert.deepEqual(output.stdout, ["old stderr"]);
    assert.deepEqual(output.stderr, []);
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
    assert.doesNotMatch(output.stdout.join("\n"), /native one|old stderr/);
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
