import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

// Kernel-owned endpoint for mutual exclusion: Windows named pipes, Linux abstract
// sockets, and macOS exclusive loopback listeners fail closed and clean up on exit.
export async function acquireLockLease(
  lockPath: string,
  scope: "lifecycle" | "update" = "lifecycle",
): Promise<() => Promise<void>> {
  const stateDirectory =
    scope === "update" ? path.dirname(path.dirname(lockPath)) : path.dirname(lockPath);
  const directory = fs.realpathSync.native(stateDirectory);
  const key = process.platform === "win32" ? directory.toLowerCase() : directory;
  const digest = createHash("sha256").update(key).digest();
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
