import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractDocCommandRefs,
  extractDocFlagRefs,
  extractDocTomlSections,
  loadSourceFlagTokens,
  docExemption,
  loadContractVerbs,
  runDocsClaimsAudit,
  PRE_DISPATCH_VERBS,
} from "./self-audit-docs.js";
import { COMMANDS, COMMAND_HELP } from "./cli.js";

// The oracle is the committed contract plus a hardcoded list of verbs main()
// special-cases. A constant that exists to catch drift must itself be guarded, or
// the rule starts reporting real documentation as drift (it did, for `kit version`
// and `kit completions`, before this test existed).
describe("self-audit-docs — PRE_DISPATCH_VERBS matches the live surface", () => {
  it("every pre-dispatch verb is a real, documented command", () => {
    for (const verb of PRE_DISPATCH_VERBS) {
      assert.ok(COMMAND_HELP[verb], `${verb} must have a COMMAND_HELP entry`);
    }
  });

  it("every pre-dispatch verb is genuinely absent from the dispatch table", () => {
    // If one gets promoted into COMMANDS the contract will list it, and carrying it
    // here too would silently mask a future removal.
    const promoted = PRE_DISPATCH_VERBS.filter((v) => COMMANDS[v]);
    assert.deepEqual(promoted, [], `now dispatched — drop from PRE_DISPATCH_VERBS: ${promoted}`);
  });

  it("no other top-level help entry is missing from the dispatch table", () => {
    // The exhaustiveness half: anything else in COMMAND_HELP but not in COMMANDS is
    // a real command this rule would wrongly flag.
    const missing = [...new Set(Object.keys(COMMAND_HELP).map((k) => k.split(" ")[0]))]
      .filter((v) => !COMMANDS[v])
      .filter((v) => !(PRE_DISPATCH_VERBS as readonly string[]).includes(v));
    assert.deepEqual(missing, [], `add to PRE_DISPATCH_VERBS or the rule false-positives`);
  });
});

describe("self-audit-docs — extractDocCommandRefs (pure)", () => {
  it("finds a command in a fenced code block, with a 1-based line", () => {
    const md = ["# Title", "", "```bash", "kit check --json", "```", ""].join("\n");
    const refs = extractDocCommandRefs(md, "docs/x.md");
    assert.deepEqual(refs, [{ verb: "check", line: 4, file: "docs/x.md" }]);
  });

  it("finds a command in an inline code span", () => {
    const refs = extractDocCommandRefs("Run `kit fix` to repair.", "README.md");
    assert.deepEqual(
      refs.map((r) => r.verb),
      ["fix"],
    );
  });

  it("ignores English prose — the noise that swamps an unanchored scan", () => {
    const md = "kit is deterministic, kit does not phone home, and kit ships zero LLM code.";
    assert.deepEqual(extractDocCommandRefs(md, "README.md"), []);
  });

  it("ignores prose even when the sentence sits inside a code span", () => {
    // `kit enforces` in backticks is still prose; only command position counts.
    const refs = extractDocCommandRefs("see `the kit enforces rule`", "README.md");
    assert.deepEqual(refs, []);
  });

  it("reads a shell prompt and a && chain, capturing every ref on the line", () => {
    const md = ["```sh", "$ kit check && kit fix", "```"].join("\n");
    assert.deepEqual(
      extractDocCommandRefs(md, "d.md").map((r) => r.verb),
      ["check", "fix"],
    );
  });

  it("captures the verb of a subcommand, not the subcommand itself", () => {
    const refs = extractDocCommandRefs("`kit memory search foo`", "d.md");
    assert.deepEqual(
      refs.map((r) => r.verb),
      ["memory"],
    );
  });

  it("handles an npx-prefixed invocation", () => {
    assert.deepEqual(
      extractDocCommandRefs("`npx kit init`", "d.md").map((r) => r.verb),
      ["init"],
    );
  });

  it("skips placeholders so `kit <command>` is not reported as drift", () => {
    const md = ["```", "kit <command> --help", "kit cmd", "```"].join("\n");
    assert.deepEqual(extractDocCommandRefs(md, "d.md"), []);
  });

  it("does not treat the fence marker line itself as code", () => {
    const md = ["```kit check", "echo hi", "```"].join("\n");
    assert.deepEqual(extractDocCommandRefs(md, "d.md"), []);
  });

  it("closes the fence, so trailing prose is not scanned as code", () => {
    const md = ["```", "kit check", "```", "kit is fine"].join("\n");
    assert.deepEqual(
      extractDocCommandRefs(md, "d.md").map((r) => r.verb),
      ["check"],
    );
  });
});

describe("self-audit-docs — docExemption (pure)", () => {
  it("exempts the changelog as a historical record", () => {
    assert.equal(docExemption("CHANGELOG.md"), "historical record");
  });

  it("exempts the roadmap as planned surface", () => {
    assert.equal(docExemption("ROADMAP.md"), "planned surface");
  });

  it("exempts design specs", () => {
    assert.equal(docExemption("docs/specs/2026-06-21-thing.md"), "design document");
  });

  it("does NOT exempt ordinary docs — including ones that look adjacent", () => {
    assert.equal(docExemption("docs/PERFORMANCE_AND_DIAGNOSTICS.md"), null);
    assert.equal(docExemption("README.md"), null);
    assert.equal(docExemption("docs/spec-notes.md"), null);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator, over a synthetic repo
// ---------------------------------------------------------------------------

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kit-docs-audit-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body, "utf-8");
  }
  return root;
}

const CONTRACT = JSON.stringify({
  opencliVersion: "0.1",
  commands: { check: { kind: "command" }, fix: { kind: "command" } },
});

describe("self-audit-docs — runDocsClaimsAudit", () => {
  it("passes when every documented command is contracted", () => {
    const root = makeRepo({
      "contracts/kit.opencli.json": CONTRACT,
      "README.md": "Run `kit check` then `kit fix`.",
    });
    try {
      const res = runDocsClaimsAudit(root);
      // One result per claim class: commands, flags, config sections.
      assert.equal(res.length, 3);
      assert.deepEqual(
        res.map((r) => r.name),
        ["documented commands", "documented flags", "documented config sections"],
      );
      assert.equal(res[0].status, "pass");
      assert.match(res[0].detail, /2 `kit <command>` ref\(s\)/);
      // 2 contracted + the 3 pre-dispatch verbs main() special-cases.
      assert.match(res[0].detail, /5 known/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails on a doc naming a command that does not exist, and names the file:line", () => {
    const root = makeRepo({
      "contracts/kit.opencli.json": CONTRACT,
      "docs/PERF.md": ["# Perf", "", "```bash", "kit metrics --export=csv", "```"].join("\n"),
    });
    try {
      const res = runDocsClaimsAudit(root);
      assert.equal(res[0].status, "fail");
      assert.match(res[0].detail, /kit metrics \(docs\/PERF\.md:4\)/);
      assert.deepEqual(res[0].files, ["docs/PERF.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fail on an exempt doc, and counts it as exempt", () => {
    const root = makeRepo({
      "contracts/kit.opencli.json": CONTRACT,
      "CHANGELOG.md": "- removed `kit agent` in 5.0",
      "ROADMAP.md": "- planned: `kit eval`",
      "docs/specs/x.md": "`kit watch`",
      "README.md": "`kit check`",
    });
    try {
      const res = runDocsClaimsAudit(root);
      assert.equal(res[0].status, "pass", res[0].detail);
      assert.match(res[0].detail, /3 doc\(s\) exempt/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports didNotRun when the contract is missing — cannot verify is not clean", () => {
    const root = makeRepo({ "README.md": "`kit check`" });
    try {
      const res = runDocsClaimsAudit(root);
      assert.equal(res[0].status, "warn");
      assert.equal(res[0].didNotRun, true);
      assert.match(res[0].detail, /NOT verified/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports didNotRun when the contract is unparsable rather than throwing", () => {
    const root = makeRepo({
      "contracts/kit.opencli.json": "{ not json",
      "README.md": "`kit check`",
    });
    try {
      const res = runDocsClaimsAudit(root);
      assert.equal(res[0].didNotRun, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips node_modules so a dependency's docs never gate kit", () => {
    const root = makeRepo({
      "contracts/kit.opencli.json": CONTRACT,
      "node_modules/dep/README.md": "`kit totally-not-a-command`",
      "README.md": "`kit check`",
    });
    try {
      const res = runDocsClaimsAudit(root);
      assert.equal(res[0].status, "pass", res[0].detail);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("self-audit-docs — loadContractVerbs", () => {
  it("returns null for a contract with an empty command map", () => {
    const root = makeRepo({ "contracts/kit.opencli.json": JSON.stringify({ commands: {} }) });
    try {
      assert.equal(loadContractVerbs(root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the real repo contract and finds a known command", () => {
    const root = makeRepo({ "contracts/kit.opencli.json": CONTRACT });
    try {
      const verbs = loadContractVerbs(root);
      assert.ok(verbs);
      assert.ok(verbs.has("check"));
      assert.equal(verbs.has("metrics"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Claim class 2: flags
// ---------------------------------------------------------------------------

describe("self-audit-docs — extractDocFlagRefs (pure)", () => {
  it("finds flags on a kit invocation", () => {
    const md = ["```bash", "kit check --json --strict", "```"].join("\n");
    assert.deepEqual(
      extractDocFlagRefs(md, "d.md").map((r) => r.verb),
      ["--json", "--strict"],
    );
  });

  it("ignores flags on a line that does not invoke kit", () => {
    // A doc showing `npm test --watch` must not be read as a kit claim.
    const md = ["```bash", "npm test --watch", "mise use --global node", "```"].join("\n");
    assert.deepEqual(extractDocFlagRefs(md, "d.md"), []);
  });

  it("normalises --flag=value to --flag", () => {
    assert.deepEqual(
      extractDocFlagRefs("`kit check --category=security`", "d.md").map((r) => r.verb),
      ["--category"],
    );
  });

  it("reports the line the flag appears on", () => {
    const md = ["# T", "", "```", "kit doctor --save-baseline", "```"].join("\n");
    assert.deepEqual(extractDocFlagRefs(md, "p.md"), [
      { verb: "--save-baseline", line: 4, file: "p.md" },
    ]);
  });
});

describe("self-audit-docs — loadSourceFlagTokens", () => {
  it("collects flag literals from source and misses fabricated ones", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-flag-oracle-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "a.ts"),
        'const x = flagValue(args, "--json");\nif (args.includes("--strict")) {}\n',
        "utf-8",
      );
      const flags = loadSourceFlagTokens(root);
      assert.ok(flags.has("--json"));
      assert.ok(flags.has("--strict"));
      assert.equal(flags.has("--max-parallel"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an empty set rather than throwing when src/ is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-flag-empty-"));
    try {
      assert.equal(loadSourceFlagTokens(root).size, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Claim class 3: config sections
// ---------------------------------------------------------------------------

describe("self-audit-docs — extractDocTomlSections (pure)", () => {
  it("reduces a sub-section to its top-level parent", () => {
    const md = ["```toml", "# .kit.toml", "[services.supabase]", 'login = "x"', "```"].join("\n");
    assert.deepEqual(
      extractDocTomlSections(md, "d.md").map((r) => r.verb),
      ["services"],
    );
  });

  it("skips a toml fence that does not say it shows .kit.toml", () => {
    // docs/POLICY.md documents a POLICY file with [thresholds] — correct there, and
    // unknown to .kit.toml. Guessing would fire the gate on correct documentation.
    const md = ["```toml", "version = 1", "[thresholds]", "code_health = 7.5", "```"].join("\n");
    assert.deepEqual(extractDocTomlSections(md, "docs/POLICY.md"), []);
  });

  it("accepts attribution from the prose introducing the fence", () => {
    const md = ["Add this to `.kit.toml`:", "", "```toml", "[tools]", "```"].join("\n");
    assert.deepEqual(
      extractDocTomlSections(md, "d.md").map((r) => r.verb),
      ["tools"],
    );
  });

  it("only reads toml-tagged fences", () => {
    const md = ["```bash", "[not-a-section]", "```"].join("\n");
    assert.deepEqual(extractDocTomlSections(md, "d.md"), []);
  });

  it("handles an array-of-tables header", () => {
    const md = ["```toml", "# .kit.toml", "[[tools]]", "```"].join("\n");
    assert.deepEqual(
      extractDocTomlSections(md, "d.md").map((r) => r.verb),
      ["tools"],
    );
  });
});

describe("self-audit-docs — runDocsClaimsAudit over the other two classes", () => {
  it("fails on a fabricated flag and names it", () => {
    const root = makeRepo({
      "contracts/kit.opencli.json": CONTRACT,
      "src/a.ts": 'flagValue(args, "--json");',
      "docs/P.md": ["```bash", "kit check --max-parallel=4", "```"].join("\n"),
    });
    try {
      const flags = runDocsClaimsAudit(root).find((r) => r.name === "documented flags");
      assert.equal(flags?.status, "fail");
      assert.match(flags!.detail, /--max-parallel \(docs\/P\.md:2\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails on a config section kit does not know", () => {
    const root = makeRepo({
      "contracts/kit.opencli.json": CONTRACT,
      "docs/P.md": ["```toml", "# .kit.toml", "[config]", "metrics_enabled = true", "```"].join(
        "\n",
      ),
    });
    try {
      const secs = runDocsClaimsAudit(root).find((r) => r.name === "documented config sections");
      assert.equal(secs?.status, "fail");
      assert.match(secs!.detail, /\[config\] \(docs\/P\.md:3\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes a real section, and does not flag a user-defined key under it", () => {
    // The reason key-level checking is deliberately absent: ServiceConfig has an
    // index signature, so `project_ref` is correct usage that no oracle over source
    // could confirm.
    const root = makeRepo({
      "contracts/kit.opencli.json": CONTRACT,
      "docs/P.md": [
        "```toml",
        "# .kit.toml",
        "[services.supabase]",
        'project_ref = "abc"',
        "```",
      ].join("\n"),
    });
    try {
      const secs = runDocsClaimsAudit(root).find((r) => r.name === "documented config sections");
      assert.equal(secs?.status, "pass", secs?.detail);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
