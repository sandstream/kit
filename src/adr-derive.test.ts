import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bucketOf,
  detectRoot,
  deriveLayerCandidates,
  importRegexFor,
  renderCandidateAdr,
  renderCandidateToml,
  ruleWouldFire,
  DEFAULT_MIN_SUPPORT,
  type LayerCandidate,
} from "./adr-derive.js";
import { parseAdr, evaluateAdr, globToRegExp } from "./adr.js";
import { buildImportGraph, type FileImports, type RepoGraph } from "./repomap/graph.js";

/** Build a graph from `{ file: [imported files] }`, the shape the deriver consumes. */
function graphOf(spec: Record<string, string[]>): RepoGraph {
  const files: FileImports[] = Object.entries(spec).map(([path, internal]) => ({
    path,
    internal,
    external: [],
  }));
  // Referenced-but-not-listed files still need to be nodes, as they are in a real repo.
  const known = new Set(Object.keys(spec));
  for (const deps of Object.values(spec)) {
    for (const d of deps) if (!known.has(d)) files.push({ path: d, internal: [], external: [] });
  }
  return buildImportGraph(files);
}

/** A repo where `commands` imports `utils` many times and `utils` never reciprocates. */
function layeredRepo(reverseEdges = DEFAULT_MIN_SUPPORT): Record<string, string[]> {
  const spec: Record<string, string[]> = {};
  for (let i = 0; i < reverseEdges; i++) spec[`src/commands/c${i}.ts`] = [`src/utils/u${i}.ts`];
  spec["src/utils/leaf.ts"] = [];
  return spec;
}

describe("bucketOf", () => {
  it("returns the first path segment under the root", () => {
    assert.equal(bucketOf("src/utils/colors.ts", "src"), "utils");
    assert.equal(bucketOf("src/utils/deep/nested.ts", "src"), "utils");
  });

  it("returns null for a file sitting directly in the root", () => {
    // Such a file reaches a sibling bucket as `./x`, not `../x` — a different rule
    // shape, so it is excluded rather than guessed at.
    assert.equal(bucketOf("src/cli.ts", "src"), null);
  });

  it("returns null for a file outside the root", () => {
    assert.equal(bucketOf("scripts/build.ts", "src"), null);
    assert.equal(bucketOf("srcfoo/x/y.ts", "src"), null);
  });
});

describe("detectRoot", () => {
  it("finds the first conventional root present", () => {
    assert.equal(detectRoot(graphOf({ "src/a/x.ts": [] })), "src");
    assert.equal(detectRoot(graphOf({ "lib/a/x.ts": [] })), "lib");
  });

  it("returns null when no conventional root exists", () => {
    assert.equal(detectRoot(graphOf({ "pkg/a/x.ts": [] })), null);
  });
});

describe("importRegexFor", () => {
  it("matches a sibling-bucket import at any nesting depth", () => {
    const re = new RegExp(importRegexFor("commands"));
    assert.ok(re.test("../commands/adr.js"));
    assert.ok(re.test("../../commands/adr.js"));
    assert.ok(re.test("../../../commands/deep/adr.js"));
  });

  it("does not match a same-named segment that is not the first", () => {
    const re = new RegExp(importRegexFor("commands"));
    assert.ok(!re.test("../../other/commands/adr.js"));
    assert.ok(!re.test("./commands/adr.js"));
    assert.ok(!re.test("../commandsx/adr.js"));
  });

  it("escapes regex metacharacters in a bucket name", () => {
    const re = new RegExp(importRegexFor("a.b"));
    assert.ok(re.test("../a.b/x.js"));
    assert.ok(!re.test("../axb/x.js"));
  });
});

describe("deriveLayerCandidates", () => {
  const opts = { root: "src", minSupport: DEFAULT_MIN_SUPPORT };

  it("proposes the absent direction of an asymmetric pair", () => {
    const out = deriveLayerCandidates(graphOf(layeredRepo()), opts);
    const hit = out.find((k) => k.from === "utils" && k.to === "commands");
    assert.ok(hit, "utils → commands should be proposed");
    assert.equal(hit.support, DEFAULT_MIN_SUPPORT);
    assert.equal(hit.pathsGlob, "src/utils/**");
  });

  it("never proposes the direction that actually occurs", () => {
    const out = deriveLayerCandidates(graphOf(layeredRepo()), opts);
    assert.equal(
      out.find((k) => k.from === "commands" && k.to === "utils"),
      undefined,
    );
  });

  it("drops a candidate the moment the edge appears — the rule is no longer true", () => {
    const spec = layeredRepo();
    spec["src/utils/leaf.ts"] = ["src/commands/c0.ts"];
    const out = deriveLayerCandidates(graphOf(spec), opts);
    assert.equal(
      out.find((k) => k.from === "utils" && k.to === "commands"),
      undefined,
    );
  });

  it("enforces the evidence floor — one lonely edge is noise, not a decision", () => {
    const thin = graphOf({ "src/a/x.ts": ["src/b/y.ts"] });
    assert.deepEqual(deriveLayerCandidates(thin, opts), []);
    // ...but the same asymmetry IS a candidate once the floor is lowered to match it.
    const lowered = deriveLayerCandidates(thin, { root: "src", minSupport: 1 });
    assert.equal(lowered.length, 1);
    assert.equal(lowered[0].from, "b");
    assert.equal(lowered[0].to, "a");
  });

  it("ignores buckets outside the named root", () => {
    const spec = layeredRepo();
    spec["lib/other/z.ts"] = ["lib/thing/w.ts"];
    const out = deriveLayerCandidates(graphOf(spec), { root: "src", minSupport: 1 });
    assert.ok(out.every((k) => k.from !== "other" && k.to !== "thing"));
  });

  it("counts files in scope so a rule over an empty scope is visible", () => {
    const out = deriveLayerCandidates(graphOf(layeredRepo()), opts);
    const hit = out.find((k) => k.from === "utils" && k.to === "commands");
    assert.equal(hit?.filesInScope, DEFAULT_MIN_SUPPORT + 1); // u0..u4 + leaf.ts
  });

  it("is deterministic and ranked by evidence weight", () => {
    const spec = layeredRepo(6);
    spec["src/api/a0.ts"] = ["src/model/m0.ts"];
    spec["src/api/a1.ts"] = ["src/model/m1.ts"];
    const graph = graphOf(spec);
    const a = deriveLayerCandidates(graph, { root: "src", minSupport: 2 });
    const b = deriveLayerCandidates(graph, { root: "src", minSupport: 2 });
    assert.deepEqual(a, b);
    assert.ok(a[0].support >= a[a.length - 1].support);
    assert.equal(a[0].to, "commands"); // 6 beats 2
  });
});

describe("renderCandidateAdr", () => {
  const cand: LayerCandidate = {
    from: "utils",
    to: "commands",
    support: 112,
    filesInScope: 32,
    importRegex: importRegexFor("commands"),
    pathsGlob: "src/utils/**",
    message: "src/utils must not import src/commands",
  };

  it("renders a draft that parses into exactly one enforceable rule", () => {
    const adr = parseAdr(renderCandidateAdr(cand, "ADR-0042"));
    assert.ok(adr);
    assert.equal(adr.id, "ADR-0042");
    assert.equal(adr.rules.length, 1);
    assert.ok(adr.hasEnforceBlock);
  });

  it("ships DISARMED — a derived draft is proposed, and proposed gates nothing", () => {
    const adr = parseAdr(renderCandidateAdr(cand, "ADR-0042"));
    assert.equal(adr?.status, "proposed");
    const violating = [{ path: "src/utils/x.ts", content: 'import "../commands/adr.js";' }];
    assert.deepEqual(evaluateAdr(adr!, violating), [], "a proposed ADR must never gate");
  });

  it("arms on exactly one human edit: proposed → accepted", () => {
    const adr = parseAdr(renderCandidateAdr(cand, "ADR-0042"))!;
    const violating = [{ path: "src/utils/x.ts", content: 'import "../commands/adr.js";' }];
    const found = evaluateAdr({ ...adr, status: "accepted" }, violating);
    assert.equal(found.length, 1);
    assert.equal(found[0].rule, "forbid-import");
    assert.equal(found[0].adrId, "ADR-0042");
    assert.equal(found[0].kind, "violation");
  });

  it("carries the measurement, so a reviewer can judge the evidence not the prose", () => {
    const body = renderCandidateAdr(cand, "ADR-0042");
    assert.match(body, /\*\*112\*\*/);
    assert.match(body, /\*\*zero\*\* times/);
    assert.match(body, /32 file\(s\)/);
  });
});

describe("renderCandidateToml", () => {
  it("escapes the regex so the emitted TOML round-trips", () => {
    const cand: LayerCandidate = {
      from: "utils",
      to: "commands",
      support: 5,
      filesInScope: 1,
      importRegex: importRegexFor("commands"),
      pathsGlob: "src/utils/**",
      message: "m",
    };
    const adr = parseAdr(renderCandidateAdr(cand, "ADR-0001"))!;
    const rule = adr.rules[0];
    assert.equal(rule.type, "forbid-import");
    if (rule.type !== "forbid-import") return;
    // The backslashes survived TOML parsing: the rule still matches a real specifier.
    assert.ok(new RegExp(rule.import).test("../commands/x.js"));
    assert.ok(renderCandidateToml(cand).includes("[[forbid_import]]"));
  });
});

describe("the emitted scope actually covers the derived bucket", () => {
  it("matches nested files and the bucket's tests, not a sibling bucket", () => {
    const re = globToRegExp("src/utils/**");
    assert.ok(re.test("src/utils/colors.ts"));
    assert.ok(re.test("src/utils/deep/nested.ts"));
    assert.ok(re.test("src/utils/colors.test.ts"), "tests are in scope — the rule must hold there");
    assert.ok(!re.test("src/commands/adr.ts"));
  });
});

describe("ruleWouldFire", () => {
  it("is true for a well-formed candidate", () => {
    assert.ok(
      ruleWouldFire({
        from: "utils",
        to: "commands",
        support: 5,
        filesInScope: 1,
        importRegex: importRegexFor("commands"),
        pathsGlob: "src/utils/**",
        message: "m",
      }),
    );
  });

  it("is false for a rule that cannot match a violating specifier", () => {
    // A green gate that can never go red is the failure mode this guards.
    assert.equal(
      ruleWouldFire({
        from: "utils",
        to: "commands",
        support: 5,
        filesInScope: 1,
        importRegex: "^never-matches-anything$",
        pathsGlob: "src/utils/**",
        message: "m",
      }),
      false,
    );
  });
});
