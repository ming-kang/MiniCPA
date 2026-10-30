import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { activeExecutablePath, backupExecutablePath } from "../paths.js";
import { readInstallState, writeInstallState } from "../state.js";
import {
  clearRuntimeBinaryBackup,
  findRunnableExecutable,
  inspectRunnableExecutable,
  parseCpaVersionFromHelp,
  readCurrentRuntimeVersion,
  resolveRunnableExecutable,
  restoreRuntimeBinaryFromBackup,
  RuntimeBinaryTransaction,
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

function installBinary(home: string, sourceExe: string): void {
  const transaction = new RuntimeBinaryTransaction(home);
  try {
    transaction.prepare(sourceExe);
    transaction.install();
    transaction.commit();
  } finally {
    transaction.discard();
  }
}

function prepareTransaction(home: string, sourceExe: string): RuntimeBinaryTransaction {
  const transaction = new RuntimeBinaryTransaction(home);
  transaction.prepare(sourceExe);
  return transaction;
}

describe("RuntimeBinaryTransaction installation", () => {
  it("installs a fresh binary and leaves no staging residue", () => {
    const home = tempHome();
    installBinary(home, writeSourceExe(home, "new-binary"));
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
    const transaction = prepareTransaction(home, writeSourceExe(home, "new-binary"));
    try {
      transaction.install();
      assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "new-binary");
      assert.equal(fs.readFileSync(backupExecutablePath(home), "utf8"), "old-binary");
      transaction.commit();
    } finally {
      transaction.discard();
    }
  });

  it("fsyncs the staged binary before publishing it", () => {
    const home = tempHome();
    const original = fs.fsyncSync;
    const synced: number[] = [];
    fs.fsyncSync = (fd: number): void => {
      synced.push(fd);
      original(fd);
    };
    const transaction = new RuntimeBinaryTransaction(home);
    try {
      transaction.prepare(writeSourceExe(home, "durable-binary"));
      transaction.install();
      transaction.commit();
    } finally {
      fs.fsyncSync = original;
      transaction.discard();
    }
    assert.ok(synced.length >= 1, "expected preparation to fsync the staged binary");
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "durable-binary");
  });
});

describe("RuntimeBinaryTransaction preparation", () => {
  it("stages before publishing and commits without another copy", () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "old");
    const transaction = prepareTransaction(home, writeSourceExe(home, "new"));
    try {
      assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "old");
      assert.equal(fs.readFileSync(`${activeExecutablePath(home)}.new`, "utf8"), "new");
      const originalCopy = fs.copyFileSync;
      fs.copyFileSync = () => {
        throw new Error("commit must not copy");
      };
      try {
        transaction.install();
      } finally {
        fs.copyFileSync = originalCopy;
      }
      assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "new");
      assert.equal(fs.readFileSync(backupExecutablePath(home), "utf8"), "old");
      transaction.commit();
    } finally {
      transaction.discard();
    }
  });

  it("backs up a binary recovered after preparation began", () => {
    const home = tempHome();
    const transaction = prepareTransaction(home, writeSourceExe(home, "new"));
    try {
      fs.writeFileSync(activeExecutablePath(home), "recovered-during-download");
      transaction.install();
      assert.equal(
        fs.readFileSync(backupExecutablePath(home), "utf8"),
        "recovered-during-download",
      );
      transaction.rollback();
      assert.equal(
        fs.readFileSync(activeExecutablePath(home), "utf8"),
        "recovered-during-download",
      );
    } finally {
      transaction.discard();
    }
  });

  it("leaves staging residue for caller discard when preparation fails", () => {
    const home = tempHome();
    const transaction = new RuntimeBinaryTransaction(home);
    const nonExistent = path.join(home, "does-not-exist");
    try {
      assert.throws(() => transaction.prepare(nonExistent));
    } finally {
      transaction.discard();
    }
    assert.equal(fs.existsSync(`${activeExecutablePath(home)}.new`), false);
  });
});

describe("findRunnableExecutable", () => {
  it("returns the path from inspectRunnableExecutable", () => {
    const home = tempHome();
    assert.equal(findRunnableExecutable(home), undefined);

    fs.writeFileSync(activeExecutablePath(home), "active");
    assert.equal(findRunnableExecutable(home), activeExecutablePath(home));
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

  it("labels the backup when only the rollback copy survives", () => {
    const home = tempHome();
    fs.writeFileSync(backupExecutablePath(home), "rollback-binary");
    const before = snapshotHome(home);

    assert.deepEqual(inspectRunnableExecutable(home), {
      path: backupExecutablePath(home),
      kind: "backup",
    });

    assert.deepEqual(snapshotHome(home), before, "the read must not touch the home");
  });

  it("returns undefined only when nothing is on disk", () => {
    assert.equal(inspectRunnableExecutable(tempHome()), undefined);
  });
});

describe("restoreRuntimeBinaryFromBackup", () => {
  it("restores without allocating another executable-sized copy", () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "broken-new");
    fs.writeFileSync(backupExecutablePath(home), "known-good");
    const originalCopy = fs.copyFileSync;
    fs.copyFileSync = () => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    };
    try {
      assert.equal(restoreRuntimeBinaryFromBackup(home), true);
    } finally {
      fs.copyFileSync = originalCopy;
    }
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "known-good");
  });

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
