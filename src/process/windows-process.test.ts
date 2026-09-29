import assert from "node:assert/strict";
import { it } from "node:test";
import { readWindowsProcess } from "./windows-process.js";

it("reads the marker and Unicode executable path in one query", async () => {
  let calls = 0;
  const executable = "C:\\用户\\node.exe";
  const result = await readWindowsProcess(123, async (_command, args) => {
    calls++;
    assert.equal((args.join(" ").match(/Get-Process/g) ?? []).length, 1);
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({ marker: "123456", exe: Buffer.from(executable).toString("base64") }),
    };
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { startMarker: "123456", executable });
});

it("shares the timeout budget between shell attempts", async () => {
  const originalNow = Date.now;
  let now = 1000;
  const budgets: number[] = [];
  Date.now = () => now;
  try {
    assert.deepEqual(
      await readWindowsProcess(
        123,
        async (_command, _args, options) => {
          budgets.push(options?.timeoutMs ?? 0);
          now += 60;
          throw new Error("probe failed");
        },
        100,
      ),
      {},
    );
  } finally {
    Date.now = originalNow;
  }
  assert.deepEqual(budgets, [100, 40]);
});

it("does not launch another shell after the deadline or accept invalid PIDs", async () => {
  const originalNow = Date.now;
  let now = 0;
  let calls = 0;
  Date.now = () => now;
  try {
    const run = async () => {
      calls++;
      now = 101;
      throw new Error("timeout");
    };
    assert.deepEqual(await readWindowsProcess(123, run, 100), {});
    assert.deepEqual(await readWindowsProcess(-1, run), {});
    assert.equal(calls, 1);
  } finally {
    Date.now = originalNow;
  }
});
