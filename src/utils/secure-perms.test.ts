import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secureFile, secureDir } from "./secure-perms.js";

// POSIX behavior is directly assertable (mode bits). The Windows icacls branch is
// exercised by the windows-latest probe (#43) — it's a no-op-on-POSIX here.
const posix = process.platform !== "win32";

describe("secure-perms (POSIX mode bits)", { skip: !posix }, () => {
  it("secureFile restricts a file to 0o600", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-sec-"));
    const f = join(dir, "secret");
    writeFileSync(f, "x", { mode: 0o644 });
    secureFile(f);
    assert.equal(statSync(f).mode & 0o777, 0o600);
  });

  it("secureDir restricts a dir to 0o700", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-sec-"));
    const sub = join(dir, "store");
    mkdirSync(sub, { mode: 0o755 });
    secureDir(sub);
    assert.equal(statSync(sub).mode & 0o777, 0o700);
  });
});
