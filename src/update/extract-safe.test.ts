import AdmZip from "adm-zip";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import zlib from "node:zlib";
import * as tar from "tar";
import { executableName } from "../paths.js";
import {
  extractArchive,
  findSafeExtractedExecutable,
  isUnsafeArchiveEntryName,
} from "./binary.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeZip(entryName: string, content: Buffer | string): string {
  const dir = tempDir("minicpa-zip-");
  const file = path.join(dir, "payload.zip");
  const zip = new AdmZip();
  zip.addFile(entryName, Buffer.isBuffer(content) ? content : Buffer.from(content));
  zip.writeZip(file);
  return file;
}

/**
 * Hand-craft a single-entry STORED zip. AdmZip's addFile normalizes hostile
 * entry names (`../`, absolute), so traversal payloads must be built raw.
 */
function craftStoredZip(entryName: string, data: Buffer): string {
  const name = Buffer.from(entryName);
  const crc = zlib.crc32(data);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(data.length, 18); // compressed size (stored)
  localHeader.writeUInt32LE(data.length, 22); // uncompressed size
  localHeader.writeUInt16LE(name.length, 26);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
  centralHeader.writeUInt16LE(20, 4); // version made by
  centralHeader.writeUInt16LE(20, 6); // version needed
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(data.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(name.length, 28);

  const local = Buffer.concat([localHeader, name, data]);
  const central = Buffer.concat([centralHeader, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16); // central directory offset

  const file = path.join(tempDir("minicpa-zip-"), "crafted.zip");
  fs.writeFileSync(file, Buffer.concat([local, central, eocd]));
  return file;
}

describe("isUnsafeArchiveEntryName", () => {
  it("rejects traversal and absolute paths in any separator style", () => {
    assert.equal(isUnsafeArchiveEntryName("../evil"), true);
    assert.equal(isUnsafeArchiveEntryName("a/../b"), true);
    assert.equal(isUnsafeArchiveEntryName("..\\evil"), true);
    assert.equal(isUnsafeArchiveEntryName("/abs/path"), true);
    assert.equal(isUnsafeArchiveEntryName("C:\\abs\\path"), true);
    assert.equal(isUnsafeArchiveEntryName("C:/abs/path"), true);
  });

  it("accepts plain relative entries", () => {
    assert.equal(isUnsafeArchiveEntryName("cli-proxy-api"), false);
    assert.equal(isUnsafeArchiveEntryName("nested/dir/cli-proxy-api.exe"), false);
    assert.equal(isUnsafeArchiveEntryName("dotted..name/file"), false);
  });
});

describe("extractArchive (zip)", () => {
  it("extracts a plain zip entry", async () => {
    const archive = writeZip(executableName(), "binary-bytes");
    const dest = tempDir("minicpa-extract-");
    const out = await extractArchive(archive, dest);
    assert.equal(fs.readFileSync(out, "utf8"), "binary-bytes");
  });

  it("rejects a zip entry with path traversal", async () => {
    const archive = craftStoredZip(`../${executableName()}`, Buffer.from("evil"));
    const dest = tempDir("minicpa-extract-");
    await assert.rejects(() => extractArchive(archive, dest), /Unsafe zip entry path/);
    assert.equal(fs.existsSync(path.join(path.dirname(dest), executableName())), false);
  });

  it("rejects a zip entry with an absolute path", async () => {
    const archive = craftStoredZip(`/evil/${executableName()}`, Buffer.from("evil"));
    const dest = tempDir("minicpa-extract-");
    await assert.rejects(() => extractArchive(archive, dest), /Unsafe zip entry path/);
  });

  it("rejects an entry whose declared size exceeds the limit", async () => {
    const archive = writeZip(executableName(), Buffer.alloc(64, "x"));
    const dest = tempDir("minicpa-extract-");
    await assert.rejects(
      () => extractArchive(archive, dest, { maxExtractedBytes: 16 }),
      /exceeds extraction size limit/,
    );
  });

  it("rejects a zip whose declared size lies about the inflated payload", async () => {
    // Declare 4 bytes but store a 64-byte payload: extraction must fail, never
    // silently produce data past the declared/limit checks (decompression bomb).
    const dir = tempDir("minicpa-zip-");
    const file = path.join(dir, "liar.zip");
    const zip = new AdmZip();
    zip.addFile(executableName(), Buffer.alloc(64, "x"));
    zip.getEntries()[0]!.header.size = 4;
    zip.writeZip(file);
    const dest = tempDir("minicpa-extract-");
    await assert.rejects(() => extractArchive(file, dest, { maxExtractedBytes: 16 }));
    assert.equal(fs.existsSync(path.join(dest, executableName())), false);
  });
});

describe("extractArchive (tar)", () => {
  it(
    "filters symlink entries instead of following them",
    { skip: process.platform === "win32" },
    async () => {
      const fixture = tempDir("minicpa-tar-src-");
      const outside = tempDir("minicpa-tar-outside-");
      fs.writeFileSync(path.join(outside, "target"), "outside-secret");
      fs.symlinkSync(path.join(outside, "target"), path.join(fixture, executableName()));
      const archive = path.join(tempDir("minicpa-tar-"), "payload.tar.gz");
      await tar.c({ gzip: true, file: archive, cwd: fixture }, [executableName()]);

      const dest = tempDir("minicpa-extract-");
      // The symlink entry is filtered out, so no executable is found at all.
      await assert.rejects(() => extractArchive(archive, dest), /not found/);
      assert.equal(fs.existsSync(path.join(dest, executableName())), false);
    },
  );

  it("extracts a nested tar layout", async () => {
    const fixture = tempDir("minicpa-tar-src-");
    fs.mkdirSync(path.join(fixture, "nested"));
    fs.writeFileSync(path.join(fixture, "nested", executableName()), "tar-binary");
    const archive = path.join(tempDir("minicpa-tar-"), "payload.tar.gz");
    await tar.c({ gzip: true, file: archive, cwd: fixture }, ["nested"]);

    const dest = tempDir("minicpa-extract-");
    const out = await extractArchive(archive, dest);
    assert.equal(fs.readFileSync(out, "utf8"), "tar-binary");
  });

  it("rejects an oversized tar entry", async () => {
    const fixture = tempDir("minicpa-tar-src-");
    fs.writeFileSync(path.join(fixture, executableName()), Buffer.alloc(64, "y"));
    const archive = path.join(tempDir("minicpa-tar-"), "payload.tar.gz");
    await tar.c({ gzip: true, file: archive, cwd: fixture }, [executableName()]);

    const dest = tempDir("minicpa-extract-");
    await assert.rejects(
      () => extractArchive(archive, dest, { maxExtractedBytes: 16 }),
      /exceeds extraction size limit/,
    );
  });
});

describe("findSafeExtractedExecutable", () => {
  it("finds nested executable inside staging", () => {
    const dest = tempDir("minicpa-extract-");
    const nested = path.join(dest, "nested");
    fs.mkdirSync(nested);
    const exeName = "cli-proxy-api";
    const exePath = path.join(nested, exeName);
    fs.writeFileSync(exePath, "bin");
    const found = findSafeExtractedExecutable(dest, exeName);
    assert.equal(path.basename(found), exeName);
    assert.ok(found.startsWith(fs.realpathSync(dest)));
  });

  it("throws when missing", () => {
    const dest = tempDir("minicpa-extract-");
    assert.throws(() => findSafeExtractedExecutable(dest, "cli-proxy-api"), /not found/);
  });
});
