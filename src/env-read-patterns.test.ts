import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { envReadPatterns } from "./env-read-patterns.js";
import { loadKnownEnvVars } from "./self-audit-docs.js";

describe("envReadPatterns", () => {
  it("scans TypeScript, mjs, bash and Python, but no test file", () => {
    for (const n of ["a.ts", "a.mjs", "a.sh", "a.py"]) assert.ok(envReadPatterns(n), n);
    for (const n of ["a.test.ts", "a.test.mjs", "test_a.py", "a.md", "a.d"])
      assert.equal(envReadPatterns(n), null, n);
  });

  it("counts os.environ reads in the bundled skills' Python, but not a Python test", () => {
    // triage.py and docker_label.py read their registry overrides from os.environ; before this,
    // a var only the skill reads (KIT_DOCKER_V2_REGISTRY) failed the docs rule as nonexistent.
    const root = mkdtempSync(join(tmpdir(), "kit-envvars-py-"));
    try {
      mkdirSync(join(root, "skills", "s"), { recursive: true });
      writeFileSync(
        join(root, "skills", "s", "a.py"),
        [
          'A = os.environ.get("KIT_PY_GET", "x")',
          "B = os.environ['KIT_PY_INDEX']",
          'if "KIT_PY_IN" not in os.environ: pass',
          'print("KIT_PY_ONLY_PRINTED")',
        ].join("\n"),
        "utf-8",
      );
      writeFileSync(join(root, "skills", "s", "test_a.py"), 'os.environ["KIT_PY_TEST"]', "utf-8");
      const known = loadKnownEnvVars(root);
      for (const v of ["KIT_PY_GET", "KIT_PY_INDEX", "KIT_PY_IN"]) assert.ok(known.has(v), v);
      assert.equal(known.has("KIT_PY_ONLY_PRINTED"), false);
      assert.equal(known.has("KIT_PY_TEST"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("kit's own tree knows the docker label registry var", () => {
    assert.ok(loadKnownEnvVars(join(import.meta.dirname, "..")).has("KIT_DOCKER_V2_REGISTRY"));
  });
});
