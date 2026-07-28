import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Anchored to this script's location: resolving "dist" against process.cwd()
// would silently delete another directory's dist/ when the script is invoked by
// absolute path from elsewhere (force: true does not even signal not-found).
rmSync(fileURLToPath(new URL("../dist", import.meta.url)), { recursive: true, force: true });
