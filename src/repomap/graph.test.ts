import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildImportGraph, relevantSlice, type FileImports } from "./graph.js";

const files: FileImports[] = [
  { path: "src/a.ts", internal: ["src/b.ts"], external: ["node:fs"] },
  { path: "src/b.ts", internal: ["src/c.ts"], external: ["zod"] },
  { path: "src/c.ts", internal: [], external: [] },
  { path: "src/unrelated.ts", internal: [], external: [] },
];

describe("repomap graph — buildImportGraph", () => {
  it("makes a node per file + external, and an imports edge per dep (sorted, deduped)", () => {
    const g = buildImportGraph(files);
    assert.deepEqual(
      g.nodes.filter((n) => n.kind === "file").map((n) => n.id),
      ["src/a.ts", "src/b.ts", "src/c.ts", "src/unrelated.ts"],
    );
    assert.deepEqual(
      g.nodes.filter((n) => n.kind === "external").map((n) => n.id),
      ["node:fs", "zod"],
    );
    assert.ok(g.edges.some((e) => e.from === "src/a.ts" && e.to === "src/b.ts"));
    assert.ok(g.edges.some((e) => e.from === "src/b.ts" && e.to === "zod"));
  });

  it("adds a file node for a referenced-but-unwalked target", () => {
    const g = buildImportGraph([{ path: "src/x.ts", internal: ["src/gen.ts"], external: [] }]);
    assert.ok(g.nodes.some((n) => n.id === "src/gen.ts" && n.kind === "file"));
  });

  it("is deterministic — same input → identical output", () => {
    assert.deepEqual(buildImportGraph(files), buildImportGraph(files));
  });
});

describe("repomap graph — relevantSlice", () => {
  const g = buildImportGraph(files);

  it("depth 1 includes direct neighbors in BOTH directions", () => {
    // b imports c and is imported by a → slice around b at depth 1 = {a,b,c,zod}
    const s = relevantSlice(g, ["src/b.ts"], 1);
    const ids = s.nodes.map((n) => n.id).sort();
    assert.deepEqual(ids, ["src/a.ts", "src/b.ts", "src/c.ts", "zod"]);
    assert.ok(!ids.includes("src/unrelated.ts"), "unrelated file excluded");
  });

  it("depth 0 is just the seed", () => {
    assert.deepEqual(
      relevantSlice(g, ["src/b.ts"], 0).nodes.map((n) => n.id),
      ["src/b.ts"],
    );
  });

  it("depth 2 reaches two hops (a → b → c)", () => {
    const ids = relevantSlice(g, ["src/a.ts"], 2).nodes.map((n) => n.id);
    assert.ok(ids.includes("src/c.ts"), "c reached from a at depth 2");
  });

  it("only keeps edges among kept nodes", () => {
    const s = relevantSlice(g, ["src/c.ts"], 1);
    for (const e of s.edges) {
      const keep = new Set(s.nodes.map((n) => n.id));
      assert.ok(keep.has(e.from) && keep.has(e.to));
    }
  });

  it("an unknown seed yields an empty slice (never throws)", () => {
    assert.deepEqual(relevantSlice(g, ["nope.ts"], 3).nodes, []);
  });
});
