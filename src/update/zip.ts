import fs from "node:fs";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { open, type Entry, type ZipFile } from "yauzl";

function selectEntry(zip: ZipFile, name: string, maxPathDepth: number): Promise<Entry> {
  return new Promise((resolve, reject) => {
    zip.once("error", (error: Error) =>
      reject(
        new Error(`Unsafe zip entry path or invalid archive: ${error.message}`, { cause: error }),
      ),
    );
    zip.once("end", () => reject(new Error(`${name} not found in zip archive`)));
    zip.on("entry", (entry: Entry) => {
      if (entry.fileName.split("/").filter(Boolean).length > maxPathDepth) {
        reject(new Error("Archive exceeds path depth limit"));
      } else if (path.posix.basename(entry.fileName) === name) resolve(entry);
      else zip.readEntry();
    });
    zip.readEntry();
  });
}

export async function extractZipExecutable(
  archive: string,
  directory: string,
  name: string,
  maxBytes: number,
  options?: { maxEntries: number; maxPathDepth: number },
): Promise<string> {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    open(
      archive,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true },
      (error, file) =>
        error || !file ? reject(error ?? new Error("Cannot open zip")) : resolve(file),
    );
  });
  const destination = path.join(directory, name);
  let outputCreated = false;
  let stream: Readable | undefined;
  try {
    if (zip.entryCount > (options?.maxEntries ?? 10_000)) {
      throw new Error("Archive exceeds entry count limit");
    }
    const entry = await selectEntry(zip, name, options?.maxPathDepth ?? 32);
    if (entry.uncompressedSize > maxBytes) throw new Error(`${name} exceeds extraction size limit`);
    const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
    if (unixType !== 0 && unixType !== 0o100000)
      throw new Error(`Unsafe zip entry type: ${entry.fileName}`);
    stream = await new Promise<Readable>((resolve, reject) => {
      zip.openReadStream(entry, (error, input) =>
        error || !input ? reject(error ?? new Error("Cannot read zip entry")) : resolve(input),
      );
    });
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(
          bytes > maxBytes ? new Error(`${name} exceeds extraction size limit`) : null,
          chunk,
        );
      },
    });
    const fd = fs.openSync(destination, "wx", 0o600);
    outputCreated = true;
    await pipeline(stream, limit, fs.createWriteStream(destination, { fd }));
    return destination;
  } catch (error) {
    if (outputCreated) {
      try {
        fs.unlinkSync(destination);
      } catch {
        /* best-effort */
      }
    }
    throw error;
  } finally {
    stream?.destroy();
    zip.close();
  }
}
