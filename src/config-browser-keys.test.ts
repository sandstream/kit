import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config.js";

async function warningsFor(toml: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "kit-browser-keys-"));
  const warn = mock.method(console, "warn", () => {});
  try {
    const file = join(dir, ".kit.toml");
    writeFileSync(file, toml);
    await loadConfig(file);
    return warn.mock.calls.map((call) => String(call.arguments[0]));
  } finally {
    warn.mock.restore();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("[browser] unknown keys (BH-12)", () => {
  it("warns on a key kit does not read, naming the key and the known ones", async () => {
    const warnings = await warningsFor('[browser]\nport = 3000\nstrategy = "bogus"\n');
    assert.ok(
      warnings.some((w) => w.includes("[browser].strategy") && w.includes("cdp_url")),
      `expected an unknown-key warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  it("stays quiet for every documented key", async () => {
    const warnings = await warningsFor(
      '[browser]\napp = "web"\nstart = "x"\nbuild = "y"\nroutes = "r"\nport = 3000\ncdp_url = "http://127.0.0.1:9222"\n',
    );
    assert.deepEqual(warnings, []);
  });
});
