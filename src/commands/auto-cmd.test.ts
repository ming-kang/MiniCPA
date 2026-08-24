import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureConsole } from "../test-fixtures/test-env.js";
import { runAuto } from "./auto-cmd.js";

describe("runAuto", () => {
  it("toggles autostart on and off", async () => {
    let enabled = false;
    const lockCommands: string[] = [];
    const deps = {
      isEnabled: async (): Promise<boolean> => enabled,
      setEnabled: async (next: boolean): Promise<void> => {
        enabled = next;
      },
      withLock: async <T>(command: string, fn: () => Promise<T>): Promise<T> => {
        lockCommands.push(command);
        return fn();
      },
    };

    const first = await captureConsole(() => runAuto(deps));
    assert.equal(enabled, true);
    assert.deepEqual(first.stdout, ["Autostart on"]);

    const second = await captureConsole(() => runAuto(deps));
    assert.equal(enabled, false);
    assert.deepEqual(second.stdout, ["Autostart off"]);
    assert.deepEqual(lockCommands, ["auto", "auto"]);
  });
});
