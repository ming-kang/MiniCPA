import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

/**
 * A kernel-owned endpoint serializes lock-file transitions and the entire operation.
 * Windows named pipes and Linux abstract sockets disappear automatically on death.
 * macOS uses an exclusive loopback listener because its Unix sockets leave stale
 * filesystem entries. A busy endpoint always fails closed; nothing is stolen.
 */
export async function acquireLockLease(lockPath: string): Promise<() => Promise<void>> {
  const directory = fs.realpathSync.native(path.dirname(lockPath));
  const key = process.platform === "win32" ? directory.toLowerCase() : directory;
  const digest = createHash("sha256").update(key).digest();
  const name = `minicpa-${digest.toString("hex")}`;
  const endpoint: net.ListenOptions =
    process.platform === "win32"
      ? { path: `\\\\.\\pipe\\${name}` }
      : process.platform === "linux"
        ? { path: `\0${name}` }
        : { host: "127.0.0.1", port: 1024 + (digest.readUInt32BE(0) % 64512), exclusive: true };
  const label = "port" in endpoint ? `127.0.0.1:${endpoint.port}` : name;
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void =>
      reject(
        new Error(
          `Cannot acquire MiniCPA lock lease (${label}). Another cpa command may be running, ` +
            `or another application owns the local endpoint. Lock record: ${lockPath}`,
          { cause: error },
        ),
      );
    server.once("error", onError);
    server.listen(endpoint, () => {
      server.removeListener("error", onError);
      server.unref();
      resolve();
    });
  });
  return () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
}
