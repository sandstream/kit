import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveAdrs } from "./adr-derive.js";

describe("deriveAdrs — a proposal is not shown until the repo disproves nothing", () => {
  let dir = "";

  /** Write a repo where `commands` imports `utils` 5× and `utils` never reciprocates. */
  const seed = (extra: Record<string, string> = {}): string => {
    const root = mkdtempSync(join(tmpdir(), "kit-derive-"));
    mkdirSync(join(root, "src", "commands"), { recursive: true });
    mkdirSync(join(root, "src", "utils"), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, "src", "utils", `u${i}.ts`), "export const x = 1;\n");
      writeFileSync(join(root, "src", "commands", `c${i}.ts`), `import "../utils/u${i}.js";\n`);
    }
    for (const [relPath, body] of Object.entries(extra)) {
      mkdirSync(join(root, relPath, ".."), { recursive: true });
      writeFileSync(join(root, relPath), body);
    }
    return root;
  };

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("proposes the asymmetric direction, verified against the real repo", async () => {
    dir = seed();
    const { buildRepoGraph } = await import("./repomap.js");
    const out = deriveAdrs(dir, buildRepoGraph(dir), { minSupport: 5 });
    assert.ok(out);
    assert.equal(out.root, "src");
    assert.equal(out.rejected.length, 0);
    const hit = out.proposed.find((p) => p.candidate.from === "utils");
    assert.ok(hit, "utils → commands should survive verification");
    assert.equal(hit.candidate.to, "commands");
    assert.match(hit.draft, /status: proposed/);
  });

  it("REJECTS a candidate whose rule fires today — the graph proposes, the evaluator disproves", async () => {
    // The over-match the verification pass exists for: a nested dir named after another
    // bucket, so `../commands/` resolves INSIDE utils and no cross-bucket edge exists.
    dir = seed({
      "src/utils/commands/x.ts": "export const y = 1;\n",
      "src/utils/deep/z.ts": 'import "../commands/x.js";\n',
    });
    const { buildRepoGraph } = await import("./repomap.js");
    const out = deriveAdrs(dir, buildRepoGraph(dir), { minSupport: 5 });
    assert.ok(out);
    assert.equal(out.proposed.length, 0, "an over-matching rule must not be proposed");
    assert.equal(out.rejected.length, 1);
    assert.match(out.rejected[0].reason, /fires today/);
    assert.match(out.rejected[0].reason, /src\/utils\/deep\/z\.ts/);
  });

  it("returns null when there is no source root to reason about", async () => {
    dir = mkdtempSync(join(tmpdir(), "kit-derive-empty-"));
    mkdirSync(join(dir, "pkg", "a"), { recursive: true });
    writeFileSync(join(dir, "pkg", "a", "x.ts"), "export const x = 1;\n");
    const { buildRepoGraph } = await import("./repomap.js");
    assert.equal(deriveAdrs(dir, buildRepoGraph(dir), {}), null);
  });
});
