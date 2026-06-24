// Make the built CLI executable on POSIX. No-op on Windows (NTFS has no +x bit;
// the .cmd/PATHEXT shim handles execution there). Cross-platform replacement for
// the build script's `chmod +x dist/cli.js` (#43).
import { chmodSync } from "node:fs";

if (process.platform !== "win32") {
  try {
    chmodSync("dist/cli.js", 0o755);
  } catch (err) {
    console.error("chmod dist/cli.js failed:", err.message);
    process.exit(1);
  }
}
