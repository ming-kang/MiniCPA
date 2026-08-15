import { formatBytes } from "../util.js";

export type DownloadProgressEvent = {
  label: string;
  receivedBytes: number;
  /** 0 when the server did not declare a content length. */
  totalBytes: number;
  /** True exactly once, after the download completed. */
  done: boolean;
};

/** Presentation seam for update flows: commands pass the console implementation. */
export type UpdateReporter = {
  info(message: string): void;
  warn(message: string): void;
  progress?(event: DownloadProgressEvent): void;
};

/** Interactive rendering: info→stdout, warn→stderr, throttled \r progress on stderr. */
export function consoleUpdateReporter(): UpdateReporter {
  let lastPct = -1;
  let lastBytesMark = -1;
  let wroteProgress = false;
  return {
    info(message) {
      console.log(message);
    },
    warn(message) {
      console.error(message);
    },
    progress({ label, receivedBytes, totalBytes, done }) {
      // \r rewriting only makes sense on a terminal; piped/redirected stderr
      // (CI logs, files) would otherwise accumulate one growing line per chunk.
      if (!process.stderr.isTTY) return;
      if (done) {
        if (wroteProgress) process.stderr.write("\n");
        lastPct = -1;
        lastBytesMark = -1;
        wroteProgress = false;
        return;
      }
      if (totalBytes > 0) {
        const pct = Math.min(100, Math.floor((receivedBytes / totalBytes) * 100));
        if (pct !== lastPct && (pct % 5 === 0 || pct === 100)) {
          lastPct = pct;
          wroteProgress = true;
          process.stderr.write(
            `\rDownloading ${label}: ${pct}% (${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)})`,
          );
        }
      } else if (lastBytesMark < 0 || receivedBytes - lastBytesMark >= 2 * 1024 * 1024) {
        lastBytesMark = receivedBytes;
        wroteProgress = true;
        process.stderr.write(`\rDownloading ${label}: ${formatBytes(receivedBytes)}`);
      }
    },
  };
}

/** Default for library callers and tests: no output. */
export const silentUpdateReporter: UpdateReporter = {
  info() {},
  warn() {},
};
