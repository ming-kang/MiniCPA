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
export async function acquireLockLease(
  lockPath: string,
  scope: "lifecycle" | "update" = "lifecycle",
): Promise<() => Promise<void>> {
  const stateDirectory =
    scope === "update" ? path.dirname(path.dirname(lockPath)) : path.dirname(lockPath);
  const directory = fs.realpathSync.native(stateDirectory);
  const key = process.platform === "win32" ? directory.toLowerCase() : directory;
  const digest = createHash("sha256").update(key).digest();
  // Reuse the existing root identity, not another hash scheme. Adjacent ports
  // keep our two macOS leases from ever colliding with each other.
  const name = `minicpa-${digest.toString("hex")}${scope === "update" ? "-update" : ""}`;
  const port = 1024 + ((digest.readUInt32BE(0) + (scope === "update" ? 1 : 0)) % 64512);
  const endpoint: net.ListenOptions =
    process.platform === "win32"
      ? { path: `\\\\.\\pipe\\${name}` }
      : process.platform === "linux"
        ? { path: `\0${name}` }
        : { host: "127.0.0.1", port, exclusive: true };
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
