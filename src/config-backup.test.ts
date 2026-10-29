import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { backupConfigYaml, configBackupPaths, removeLegacyConfigBackups } from "./config-backup.js";
import { MAX_CONFIG_BYTES } from "./config-yaml.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
function configFile(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-backup-"));
  homes.push(home);
  const file = path.join(home, "config.yaml");
  fs.writeFileSync(file, "port: 8317\n");
  return file;
}
function snapshots(file: string): string[] {
  return configBackupPaths(file)
    .filter((backup) => fs.existsSync(backup))
    .map((backup) => fs.readFileSync(backup, "utf8"));
}

describe("backupConfigYaml", () => {
  it("keeps only three exact, distinct snapshots after many changes", () => {
    const file = configFile();
    for (let i = 0; i < 20; i++) backupConfigYaml(file, `# original ${i}\nport: ${9000 + i}\n`);
    assert.deepEqual(
      snapshots(file),
      [19, 18, 17].map((i) => `# original ${i}\nport: ${9000 + i}\n`),
    );
    assert.deepEqual(fs.readdirSync(path.dirname(configBackupPaths(file)[0]!)).sort(), [
      "config.1.yaml",
      "config.2.yaml",
      "config.3.yaml",
    ]);
    assert.equal(
      fs.readdirSync(path.dirname(file)).some((name) => name.includes(".bak.")),
      false,
    );
    if (process.platform !== "win32") {
      for (const backup of configBackupPaths(file))
        assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
    }
  });

  it("promotes repeated content rather than writing another copy", () => {
    const file = configFile();
    for (const text of ["a", "b", "c", "a"]) backupConfigYaml(file, text);
    assert.deepEqual(snapshots(file), ["a", "c", "b"]);
    const originalOpen = fs.openSync;
    fs.openSync = (target, ...args) => {
      assert.ok(!String(target).endsWith(".tmp"), "identical latest snapshot must not write");
      return originalOpen(target, ...args);
    };
    try {
      backupConfigYaml(file, "a");
    } finally {
      fs.openSync = originalOpen;
    }
    assert.deepEqual(snapshots(file), ["a", "c", "b"]);
  });

  it("converges duplicate slots left by a interrupted rotation", () => {
    const file = configFile();
    const backups = configBackupPaths(file);
    fs.mkdirSync(path.dirname(backups[0]!), { recursive: true });
    for (const [index, text] of ["a", "a", "b"].entries()) fs.writeFileSync(backups[index]!, text);
    backupConfigYaml(file, "a");
    assert.deepEqual(snapshots(file), ["a", "b"]);
    assert.equal(fs.existsSync(backups[2]!), false);
  });

  it("does not touch config when a snapshot write fails", () => {
    const file = configFile();
    const originalOpen = fs.openSync;
    fs.openSync = (target, ...args) => {
      if (String(target).includes(".config.1.yaml.") && String(target).endsWith(".tmp"))
        throw new Error("backup denied");
      return originalOpen(target, ...args);
    };
    try {
      assert.throws(() => backupConfigYaml(file), /backup denied/);
    } finally {
      fs.openSync = originalOpen;
    }
    assert.equal(fs.readFileSync(file, "utf8"), "port: 8317\n");
  });

  it("never writes through a symlinked/junction backup directory", () => {
    const file = configFile();
    const outside = path.join(path.dirname(file), "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "config.1.yaml"), "unrelated data");
    fs.symlinkSync(
      outside,
      path.join(path.dirname(file), "backups"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.throws(() => backupConfigYaml(file), /Refusing symlinked config backup directory/);
    assert.equal(fs.readFileSync(path.join(outside, "config.1.yaml"), "utf8"), "unrelated data");
    assert.equal(fs.readFileSync(file, "utf8"), "port: 8317\n");
  });

  it("rejects oversized input without allocating an unbounded history", () => {
    const file = configFile();
    assert.throws(() => backupConfigYaml(file, "x".repeat(MAX_CONFIG_BYTES + 1)), /size limit/);
    assert.equal(fs.existsSync(path.dirname(configBackupPaths(file)[0]!)), false);
    fs.truncateSync(file, MAX_CONFIG_BYTES + 1);
    assert.throws(() => backupConfigYaml(file), /size limit/);
  });
});

describe("removeLegacyConfigBackups", () => {
  it("bulk-deletes only generated old config names, protecting all other data", () => {
    const file = configFile();
    const old = [`${file}.bak.2026-10-01T12-34-56-789Z`, `${file}.bak.2026-10-01T12-34-56-789Z.1`];
    const keep = [
      `${file}.bak.manual`,
      path.join(path.dirname(file), ".config.yaml.replace.bak"),
      path.join(path.dirname(file), "cli-proxy-api.bak"),
      path.join(path.dirname(file), ".env"),
    ];
    for (const name of [...old, ...keep]) fs.writeFileSync(name, "private");
    const newBackup = backupConfigYaml(file);
    assert.deepEqual(removeLegacyConfigBackups(file), { removed: 2, failures: [] });
    for (const name of old) assert.equal(fs.existsSync(name), false);
    for (const name of [...keep, file, newBackup]) assert.equal(fs.existsSync(name), true, name);
    assert.deepEqual(removeLegacyConfigBackups(file), { removed: 0, failures: [] });
  });

  it("reports deletion failures and leaves those files for the next update", () => {
    const file = configFile();
    const old = `${file}.bak.2026-10-01T12-34-56-789Z`;
    fs.writeFileSync(old, "private");
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = (target) => {
      if (String(target) === old) throw new Error("locked backup");
      originalUnlink(target);
    };
    try {
      const result = removeLegacyConfigBackups(file);
      assert.equal(result.removed, 0);
      assert.match(result.failures.join("\n"), /locked backup/);
    } finally {
      fs.unlinkSync = originalUnlink;
    }
    assert.equal(fs.existsSync(old), true);
  });
});
