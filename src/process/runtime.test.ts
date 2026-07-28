import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { activeExecutablePath, backupExecutablePath, unlockProbePath } from "../paths.js";
import { readInstallState, writeInstallState } from "../state.js";
import {
  clearRuntimeBinaryBackup,
  findRunnableExecutable,
  inspectRunnableExecutable,
  installRuntimeBinary,
  parseCpaVersionFromHelp,
  readCurrentRuntimeVersion,
  recoverUnlockProbeBinary,
  resolveRunnableExecutable,
  restoreRuntimeBinaryFromBackup,
} from "./runtime.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-runtime-"));
  temps.push(home);
  return home;
}

/** `name=content` listing used to prove a read left the home byte-identical. */
function snapshotHome(home: string): string[] {
  return fs
    .readdirSync(home)
    .sort()
    .map((name) => `${name}=${fs.readFileSync(path.join(home, name), "utf8")}`);
}

function writeSourceExe(home: string, content: string): string {
  const source = path.join(home, "staged-source");
  fs.writeFileSync(source, content);
  return source;
}

describe("installRuntimeBinary", () => {
  it("installs a fresh binary and leaves no staging residue", () => {
    const home = tempHome();
    installRuntimeBinary(home, writeSourceExe(home, "new-binary"));
    const active = activeExecutablePath(home);
    assert.equal(fs.readFileSync(active, "utf8"), "new-binary");
    assert.equal(fs.existsSync(`${active}.new`), false);
    if (process.platform !== "win32") {
      assert.ok(fs.statSync(active).mode & 0o100);
    }
  });

  it("keeps the previous binary as .bak when replacing", () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "old-binary");
    installRuntimeBinary(home, writeSourceExe(home, "new-binary"));
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "new-binary");
    assert.equal(fs.readFileSync(backupExecutablePath(home), "utf8"), "old-binary");
  });

  it("fsyncs the staged binary before publishing it", () => {
    const home = tempHome();
    const original = fs.fsyncSync;
    const synced: number[] = [];
    fs.fsyncSync = (fd: number): void => {
      synced.push(fd);
      original(fd);
    };
    try {
      installRuntimeBinary(home, writeSourceExe(home, "durable-binary"));
    } finally {
      fs.fsyncSync = original;
    }
    assert.ok(synced.length >= 1, "expected installRuntimeBinary to fsync the staged binary");
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "durable-binary");
  });
});

describe("findRunnableExecutable", () => {
  it("returns the active binary when it exists", () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "active");
    assert.equal(findRunnableExecutable(home), activeExecutablePath(home));
  });

  it("returns the backup path without restoring it", () => {
    const home = tempHome();
    fs.writeFileSync(backupExecutablePath(home), "rollback-binary");
    const before = fs.readdirSync(home).sort();

    assert.equal(findRunnableExecutable(home), backupExecutablePath(home));

    assert.deepEqual(fs.readdirSync(home).sort(), before);
    assert.equal(fs.existsSync(activeExecutablePath(home)), false);
    assert.equal(fs.readFileSync(backupExecutablePath(home), "utf8"), "rollback-binary");
  });

  it("returns undefined for an empty home", () => {
    assert.equal(findRunnableExecutable(tempHome()), undefined);
  });

  it("reports the unlock-probe residue instead of claiming the binary is missing", () => {
    const home = tempHome();
    fs.writeFileSync(unlockProbePath(home), "probe-binary");

    // Undefined here is what made `cpa doctor` tell the user to re-download the
    // whole binary while reporting the recoverable residue two lines below.
    assert.equal(findRunnableExecutable(home), unlockProbePath(home));
  });
});

describe("inspectRunnableExecutable", () => {
  it("labels the active binary", () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "active");
    assert.deepEqual(inspectRunnableExecutable(home), {
      path: activeExecutablePath(home),
      kind: "active",
    });
  });

  it("reports unlock-probe residue without recovering it", () => {
    const home = tempHome();
    fs.writeFileSync(unlockProbePath(home), "probe-binary");
    const before = snapshotHome(home);

    assert.deepEqual(inspectRunnableExecutable(home), {
      path: unlockProbePath(home),
      kind: "unlock-probe",
    });

    assert.deepEqual(snapshotHome(home), before, "the read must not touch the home");
    assert.equal(fs.existsSync(activeExecutablePath(home)), false);
  });

  it("prefers the unlock probe over the older backup", () => {
    const home = tempHome();
    fs.writeFileSync(unlockProbePath(home), "current-binary");
    fs.writeFileSync(backupExecutablePath(home), "previous-binary");
    const before = snapshotHome(home);

    assert.deepEqual(inspectRunnableExecutable(home), {
      path: unlockProbePath(home),
      kind: "unlock-probe",
    });

    assert.deepEqual(snapshotHome(home), before, "the read must not touch the home");
  });

  it("labels the backup when only the rollback copy survives", () => {
    const home = tempHome();
    fs.writeFileSync(backupExecutablePath(home), "rollback-binary");
    assert.deepEqual(inspectRunnableExecutable(home), {
      path: backupExecutablePath(home),
      kind: "backup",
    });
  });

  it("returns undefined only when nothing is on disk", () => {
    assert.equal(inspectRunnableExecutable(tempHome()), undefined);
  });
});

describe("restoreRuntimeBinaryFromBackup", () => {
  it("returns false without a backup", () => {
    assert.equal(restoreRuntimeBinaryFromBackup(tempHome()), false);
  });

  it("restores the backup over the active binary", () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "broken-new");
    fs.writeFileSync(backupExecutablePath(home), "known-good");
    assert.equal(restoreRuntimeBinaryFromBackup(home), true);
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "known-good");
  });
});

describe("clearRuntimeBinaryBackup", () => {
  it("removes the backup and is idempotent", () => {
    const home = tempHome();
    fs.writeFileSync(backupExecutablePath(home), "old");
    clearRuntimeBinaryBackup(home);
    assert.equal(fs.existsSync(backupExecutablePath(home)), false);
    clearRuntimeBinaryBackup(home);
  });
});

describe("recoverUnlockProbeBinary", () => {
  it("restores the canonical name from a crashed unlock probe", () => {
    const home = tempHome();
    fs.writeFileSync(unlockProbePath(home), "probe-binary");
    assert.equal(recoverUnlockProbeBinary(home), true);
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "probe-binary");
    assert.equal(fs.existsSync(unlockProbePath(home)), false);
  });

  it("does nothing when the active binary already exists", () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "active");
    fs.writeFileSync(unlockProbePath(home), "probe");
    assert.equal(recoverUnlockProbeBinary(home), false);
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "active");
  });
});

describe("resolveRunnableExecutable", () => {
  it("auto-restores from .bak when the active binary is missing", () => {
    const home = tempHome();
    fs.writeFileSync(backupExecutablePath(home), "rollback-binary");
    const resolved = resolveRunnableExecutable(home);
    assert.equal(resolved, activeExecutablePath(home));
    assert.equal(fs.readFileSync(resolved, "utf8"), "rollback-binary");
  });

  it("throws when neither active nor backup exists", () => {
    assert.throws(() => resolveRunnableExecutable(tempHome()), /Run: cpa update/);
  });
});

describe("parseCpaVersionFromHelp", () => {
  it("extracts version line", () => {
    assert.equal(parseCpaVersionFromHelp("CLIProxyAPI Version: 7.2.66\nUsage:"), "7.2.66");
  });

  it("returns undefined when missing", () => {
    assert.equal(parseCpaVersionFromHelp("no version here"), undefined);
  });
});

describe("readCurrentRuntimeVersion", () => {
  it("does not trust a recorded version when the binary is missing", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-runtime-"));
    temps.push(home);
    writeInstallState(home, { runtimeVersion: "7.0.0" });

    assert.equal(fs.existsSync(activeExecutablePath(home)), false);
    assert.equal(await readCurrentRuntimeVersion(home), undefined);
  });

  it("does not rewrite install state while probing", {
    skip: process.platform === "win32",
  }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-runtime-"));
    temps.push(home);
    const executable = activeExecutablePath(home);
    fs.writeFileSync(executable, "#!/bin/sh\necho 'CLIProxyAPI Version: 8.0.0'\n");
    fs.chmodSync(executable, 0o755);
    writeInstallState(home, { runtimeVersion: "7.0.0" });

    assert.equal(await readCurrentRuntimeVersion(home), "8.0.0");
    assert.equal(readInstallState(home).runtimeVersion, "7.0.0");
  });

  it("does not trust a recorded version when the binary cannot be probed", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-runtime-"));
    temps.push(home);
    const executable = activeExecutablePath(home);
    fs.writeFileSync(executable, "not an executable");
    writeInstallState(home, { runtimeVersion: "7.0.0" });

    assert.equal(await readCurrentRuntimeVersion(home), undefined);
  });
});
