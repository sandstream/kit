/**
 * `kit triage npm` gave a package with a `postinstall` 100/100 and said nothing about it, though the
 * registry metadata it already reads declares the script (kit-research astryx-revisit-vs-kit). These
 * run the real triage.py against a local registry fixture (KIT_NPM_REGISTRY is the air-gap override).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { warmPython } from "./python-warmup.test-support.js";

before(() => warmPython());

const exec = promisify(execFile);
const TRIAGE_PY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "triage",
  "scripts",
  "triage.py",
);
const OLD = new Date(Date.now() - 900 * 86_400_000).toISOString();
const doc = (scripts: Record<string, string>) => ({
  "dist-tags": { latest: "1.0.0" },
  versions: { "1.0.0": { license: "MIT", scripts } },
  time: { created: OLD, "1.0.0": OLD },
  maintainers: [{ name: "a" }, { name: "b" }],
});
const PACKAGES: Record<string, unknown> = {
  "with-postinstall": doc({ postinstall: "node nudge.js", test: "node --test" }),
  "no-hooks": doc({ test: "node --test", prepare: "tsc" }),
};

let server: Server;
let base = "";
before(async () => {
  server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "").slice(1));
    const body = PACKAGES[name];
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { error: "not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
after(() => server.close());

async function triage(t: { skip(m: string): void }, pkg: string): Promise<string | null> {
  try {
    const run = await exec("python3", ["-I", TRIAGE_PY, "npm", pkg], {
      env: { ...process.env, KIT_NPM_REGISTRY: base },
      timeout: 30_000,
    });
    return run.stdout;
  } catch (err) {
    const e = err as { code?: string | number; stdout?: string };
    if (e.code === "ENOENT") {
      t.skip("python3 not installed — triage.py's own behaviour is NOT verified in this run");
      return null;
    }
    return e.stdout ?? "";
  }
}

describe("kit triage npm: install scripts", () => {
  it("names a postinstall the package runs on install", async (t) => {
    const out = await triage(t, "with-postinstall");
    if (out === null) return;
    assert.match(out, /runs install script\(s\) on install: postinstall/);
    assert.match(out, /TRIAGE PASSED/, "named, not scored");
  });

  it("says nothing for scripts npm does not run on a registry install", async (t) => {
    const out = await triage(t, "no-hooks");
    if (out === null) return;
    assert.doesNotMatch(out, /install script/);
  });
});
