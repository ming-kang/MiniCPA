import assert from "node:assert/strict";
import { it } from "node:test";
import { runCommand } from "./runtime.js";

it("bounds captured output instead of retaining an unbounded child stream", async () => {
  await assert.rejects(
    () =>
      runCommand(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)"],
        { maxOutputBytes: 1024 },
      ),
    /output exceeds capture limit/,
  );
});

it("bounds a child that never exits", async () => {
  await assert.rejects(
    () => runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 }),
    /timed out/,
  );
});

it("preserves UTF-8 characters split across writes", async () => {
  const result = await runCommand(process.execPath, [
    "-e",
    "const b=Buffer.from('世界');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),30)",
  ]);
  assert.equal(result.stdout, "世界");
  assert.equal(result.code, 0);
});
