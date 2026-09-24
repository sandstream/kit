import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";

const exec = promisify(execFile);
const source = import.meta.url.endsWith(".ts");
const moduleUrl = new URL(source ? "./config.ts" : "./config.js", import.meta.url).href;

for (const input of ["a=[1 #", "a={b=1 #"]) {
  it("configuration rejects an unterminated comment without hanging: " + input, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-toml-parser-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, ".kit.toml");
    writeFileSync(path, input);
    // A synchronous parser loop cannot be interrupted by a same-process test timeout.
    const script = `
      import { loadConfig, InvalidConfigError } from ${JSON.stringify(moduleUrl)};
      try { await loadConfig(process.argv[1]); process.exitCode = 2; }
      catch (error) {
        if (!(error instanceof InvalidConfigError)) throw error;
        console.log("invalid configuration rejected");
      }
    `;
    const result = await exec(
      process.execPath,
      [
        ...(source ? ["--import", import.meta.resolve("tsx")] : []),
        "--input-type=module",
        "-e",
        script,
        path,
      ],
      { timeout: 5000, killSignal: "SIGKILL" },
    );
    assert.equal(result.stdout.trim(), "invalid configuration rejected");
  });
}
