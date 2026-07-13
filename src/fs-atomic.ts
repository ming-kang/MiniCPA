import fs from "node:fs";
import path from "node:path";

/** Write file via temp + rename (best-effort atomic on Windows). */
export function writeFileAtomic(filePath: string, data: string | Buffer): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, data);
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      fs.renameSync(temporaryPath, filePath);
    } catch (renameError) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        /* ignore */
      }
      throw renameError;
    }
  }
}
