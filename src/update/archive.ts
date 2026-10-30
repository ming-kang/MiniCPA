import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Unpack, type ReadEntry } from "tar";
import { executableName } from "../paths.js";
import { extractZipExecutable } from "./zip.js";

const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_PATH_DEPTH = 32;

function isPathInsideDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function findSafeExtractedExecutable(destDir: string, exeName: string): string {
  const resolvedDest = fs.realpathSync(destDir);
  const candidates = fs
    .readdirSync(destDir, { recursive: true })
    .map(String)
    .filter((relative) => path.basename(relative) === exeName);
  for (const relative of candidates) {
    const candidate = path.join(destDir, relative);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    const realCandidate = fs.realpathSync(candidate);
    if (!isPathInsideDirectory(realCandidate, resolvedDest)) {
      throw new Error(`Refusing extracted path outside staging: ${candidate}`);
    }
    return realCandidate;
  }
  throw new Error(`${exeName} not found in extract directory`);
}

export function isUnsafeArchiveEntryName(entryName: string): boolean {
  const normalized = entryName.replace(/\\/g, "/");
  return (
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    normalized.split("/").some((part) => part === "..")
  );
}

export async function extractArchive(
  archivePath: string,
  destDir: string,
  options?: {
    maxExtractedBytes?: number;
    maxEntries?: number;
    maxPathDepth?: number;
    maxUnpackedBytes?: number;
  },
): Promise<string> {
  const name = executableName();
  const maxBytes = options?.maxExtractedBytes ?? MAX_EXTRACTED_BYTES;
  const maxEntries = options?.maxEntries ?? MAX_ARCHIVE_ENTRIES;
  const maxPathDepth = options?.maxPathDepth ?? MAX_PATH_DEPTH;
  fs.mkdirSync(destDir, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    return extractZipExecutable(archivePath, destDir, name, maxBytes, { maxEntries, maxPathDepth });
  }
  if (!archivePath.endsWith(".tar.gz") && !archivePath.endsWith(".tgz")) {
    throw new Error(`Unsupported archive: ${archivePath}`);
  }

  let entries = 0;
  let selectedBytes = 0;
  const unpack = new Unpack({
    cwd: destDir,
    maxDepth: maxPathDepth,
    filter: (entryPath, entry) => {
      const normalized = entryPath.replace(/\\/g, "/");
      let error: string | undefined;
      if (++entries > maxEntries) error = "Archive exceeds entry count limit";
      else if (normalized.split("/").filter(Boolean).length > maxPathDepth)
        error = "Archive exceeds path depth limit";
      if (error) {
        // abort emits a handled stream error; throwing from a tar filter does not.
        unpack.abort(new Error(error));
        return false;
      }
      const type = (entry as ReadEntry).type;
      if (isUnsafeArchiveEntryName(entryPath) || type === "SymbolicLink" || type === "Link")
        return false;
      if (type === "Directory") return true;
      if (path.posix.basename(normalized) !== name) return false;
      selectedBytes += entry.size;
      if (selectedBytes > maxBytes) {
        unpack.abort(new Error(`${name} in ${archivePath} exceeds extraction size limit`));
        return false;
      }
      return type === "File" || type === "OldFile";
    },
  });
  // Bound the actual decompressed stream, including entries we do not extract.
  const maxUnpackedBytes = options?.maxUnpackedBytes ?? maxBytes + 16 * 1024 * 1024;
  let unpackedBytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      unpackedBytes += chunk.length;
      callback(
        unpackedBytes > maxUnpackedBytes
          ? new Error("Archive exceeds decompressed size limit")
          : null,
        chunk,
      );
    },
  });
  await pipeline(fs.createReadStream(archivePath), createGunzip(), limit, unpack);
  return findSafeExtractedExecutable(destDir, name);
}
