// Side-effect module: must stay dependency-free so it runs before anything
// that might rely on Node 24+ APIs. Imported first by cli.ts.
const REQUIRED_NODE_MAJOR = 24;

const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (major < REQUIRED_NODE_MAJOR) {
  console.error(
    `MiniCPA requires Node.js ${REQUIRED_NODE_MAJOR} or newer (found ${process.versions.node}).`,
  );
  process.exit(1);
}

export {};
