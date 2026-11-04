import assert from "node:assert/strict";
import { it } from "node:test";
import { readWindowsProcess, runPowerShell } from "./windows-process.js";

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

it("falls back to the next shell only when the shell cannot start", async () => {
  const shells: string[] = [];
  const missing = Object.assign(new Error("spawn pwsh.exe ENOENT"), { code: "ENOENT" });
  const result = await runPowerShell("exit 3", { timeoutMs: 1000 }, async (command) => {
    shells.push(command);
    if (shells.length === 1) throw missing;
    return { code: 3, stdout: "", stderr: "script failed" };
  });
  assert.equal(result.code, 3, "a failing script is reported, not retried");
  assert.deepEqual(shells, ["pwsh.exe", "powershell.exe"]);

  // The shell that started is remembered for the next call.
  const next: string[] = [];
  await runPowerShell("exit 0", { timeoutMs: 1000 }, async (command) => {
    next.push(command);
    return { code: 0, stdout: "", stderr: "" };
  });
  assert.deepEqual(next, ["powershell.exe"]);
  await runPowerShell("exit 0", { timeoutMs: 1000 }, async (command) => {
    if (command === "powershell.exe") throw missing;
    return { code: 0, stdout: "", stderr: "" };
  });
});

it("does not try another shell after a timeout", async () => {
  let calls = 0;
  await assert.rejects(
    runPowerShell("Start-Sleep 9", { timeoutMs: 100 }, async () => {
      calls++;
      throw new Error("Command timed out after 100ms");
    }),
    /timed out/,
  );
  assert.equal(calls, 1);
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
          throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
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
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    };
    assert.deepEqual(await readWindowsProcess(123, run, 100), {});
    assert.deepEqual(await readWindowsProcess(-1, run), {});
    assert.equal(calls, 1);
  } finally {
    Date.now = originalNow;
  }
});
