import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, it } from "node:test";
import { registerWithRollback } from "./autostart-shared.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("preserves a previous registration when the OS manager fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-registration-"));
  roots.push(root);
  const file = path.join(root, "registration");
  fs.writeFileSync(file, "original");
  await assert.rejects(
    () =>
      registerWithRollback(file, "replacement", "fake", [], {
        runCommand: async () => ({ code: 1, stdout: "", stderr: "unavailable" }),
      }),
    /unavailable/,
  );
  assert.equal(fs.readFileSync(file, "utf8"), "original");
});

it("removes a new registration when the manager cannot be spawned", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-registration-"));
  roots.push(root);
  const file = path.join(root, "registration");
  await assert.rejects(
    () =>
      registerWithRollback(file, "replacement", "fake", [], {
        runCommand: async () => {
          throw new Error("spawn failed");
        },
      }),
    /spawn failed/,
  );
  assert.equal(fs.existsSync(file), false);
});
