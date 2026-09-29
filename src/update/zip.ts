import fs from "node:fs";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { open, type Entry, type ZipFile } from "yauzl";

/** Select lazily so even an archive with many entries does not accumulate metadata. */
function selectEntry(zip: ZipFile, name: string): Promise<Entry> {
  return new Promise((resolve, reject) => {
    zip.once("error", (error: Error) =>
      reject(
        new Error(`Unsafe zip entry path or invalid archive: ${error.message}`, { cause: error }),
      ),
    );
    zip.once("end", () => reject(new Error(`${name} not found in zip archive`)));
    zip.on("entry", (entry: Entry) => {
      if (path.posix.basename(entry.fileName) === name) resolve(entry);
      else zip.readEntry();
    });
    zip.readEntry();
  });
}

/** Inflate only the selected executable, enforcing the limit before and during streaming. */
export async function extractZipExecutable(
  archive: string,
  directory: string,
  name: string,
  maxBytes: number,
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
    const entry = await selectEntry(zip, name);
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
    // Exclusive creation also refuses a pre-existing symlink in the destination.
    const fd = fs.openSync(destination, "wx", 0o600);
    outputCreated = true;
    await pipeline(stream, limit, fs.createWriteStream(destination, { fd }));
    return destination;
  } catch (error) {
    if (outputCreated) {
      try {
        fs.unlinkSync(destination);
      } catch {
        /* preserve extraction failure */
      }
    }
    throw error;
  } finally {
    stream?.destroy();
    zip.close();
  }
}
