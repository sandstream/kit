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
  flagValidationCoverage,
  loadKnownEnvVars,
  extractDocEnvVars,
  docExemption,
  loadContractVerbs,
  runDocsClaimsAudit,
  undocumentedCommands,
  loadCommandSurface,
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
      // Flag-validation rows (one per non-validating module, or one pass), then one
      // result per claim class.
      assert.deepEqual(
        res.filter((r) => r.category === "self-audit/docs-claims").map((r) => r.name),
        [
          "documented commands",
          "documented flags",
          "documented config sections",
          "documented env vars",
          "undocumented commands",
        ],
      );
      // The synthetic repo has no src/commands, so coverage reports a single pass.
      const cov = res.filter((r) => r.category === "self-audit/flag-validation");
      assert.equal(cov.length, 1);
      assert.equal(cov[0].status, "pass");
      const commands = res.find((r) => r.name === "documented commands")!;
      assert.equal(commands.status, "pass");
      assert.match(commands.detail, /2 `kit <command>` ref\(s\)/);
      // 2 contracted + the 3 pre-dispatch verbs main() special-cases.
      assert.match(commands.detail, /5 known/);
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
      const cmds = runDocsClaimsAudit(root).find((r) => r.name === "documented commands")!;
      assert.equal(cmds.status, "fail");
      assert.match(cmds.detail, /kit metrics \(docs\/PERF\.md:4\)/);
      assert.deepEqual(cmds.files, ["docs/PERF.md"]);
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
      const cmds = runDocsClaimsAudit(root).find((r) => r.name === "documented commands")!;
      assert.equal(cmds.status, "pass", cmds.detail);
      assert.match(cmds.detail, /3 doc\(s\) exempt/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports didNotRun when the contract is missing — cannot verify is not clean", () => {
    const root = makeRepo({ "README.md": "`kit check`" });
    try {
      const res = runDocsClaimsAudit(root);
      assert.equal(res.length, 1, "the unverifiable-contract path short-circuits");
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
      // By name, not by position: this test is about node_modules being skipped, and a
      // positional assertion made it fail when an unrelated row was added first.
      const flags = res.find((r) => r.category === "self-audit/flag-validation")!;
      assert.equal(flags.status, "pass", flags.detail);
      const cmds = res.find((r) => r.name === "documented commands")!;
      assert.equal(cmds.status, "pass", cmds.detail);
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

// ---------------------------------------------------------------------------
// Flag-validation coverage — the systemic gap, measured rather than hidden
// ---------------------------------------------------------------------------

describe("self-audit-docs — flagValidationCoverage", () => {
  it("splits command modules by whether they validate argv", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-flagcov-"));
    try {
      mkdirSync(join(root, "src", "commands"), { recursive: true });
      writeFileSync(
        join(root, "src", "commands", "good.ts"),
        'if (unknownFlags(process.argv, ["--json"]).length) return false;',
        "utf-8",
      );
      writeFileSync(
        join(root, "src", "commands", "lax.ts"),
        'const j = hasFlag(process.argv, "--json");',
        "utf-8",
      );
      const cov = flagValidationCoverage(root);
      assert.deepEqual(cov.validating, ["good"]);
      assert.deepEqual(cov.missing, ["lax"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores test files so a module is judged on its own source", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-flagcov2-"));
    try {
      mkdirSync(join(root, "src", "commands"), { recursive: true });
      writeFileSync(join(root, "src", "commands", "a.test.ts"), "unknownFlags(", "utf-8");
      writeFileSync(join(root, "src", "commands", "a.ts"), "nothing here", "utf-8");
      const cov = flagValidationCoverage(root);
      assert.deepEqual(cov.validating, []);
      assert.deepEqual(cov.missing, ["a"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns empty sets rather than throwing when there is no commands dir", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-flagcov3-"));
    try {
      assert.deepEqual(flagValidationCoverage(root), { validating: [], missing: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("kit's own check command is on the validating side", () => {
    // The one that motivated the measurement. If this ever regresses, --category can
    // silently become a no-op again.
    const cov = flagValidationCoverage(join(import.meta.dirname, ".."));
    assert.ok(cov.validating.includes("check"), "commands/check.ts must validate its flags");
  });
});

// ---------------------------------------------------------------------------
// Claim class 4: env vars
// ---------------------------------------------------------------------------

describe("self-audit-docs — extractDocEnvVars (pure)", () => {
  it("finds a var in a fence and in prose — both are the same claim to a reader", () => {
    const md = ["Set `KIT_ONE` first.", "```bash", "export KIT_TWO=1", "```"].join("\n");
    assert.deepEqual(
      extractDocEnvVars(md, "d.md").map((r) => r.verb),
      ["KIT_ONE", "KIT_TWO"],
    );
  });

  it("drops a trailing-underscore wildcard — it names a family, not a variable", () => {
    assert.deepEqual(extractDocEnvVars("`KIT_PROVENANCE_`*", "d.md"), []);
  });

  it("ignores non-KIT env vars", () => {
    assert.deepEqual(extractDocEnvVars("`NODE_ENV` and `PATH`", "d.md"), []);
  });

  it("reports the line", () => {
    assert.deepEqual(extractDocEnvVars(["a", "b", "`KIT_XY`"].join("\n"), "d.md"), [
      { verb: "KIT_XY", line: 3, file: "d.md" },
    ]);
  });
});

describe("self-audit-docs — loadKnownEnvVars", () => {
  it("counts process.env reads, destructured env reads, and vars set for children", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-envvars-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "a.ts"),
        [
          "const a = process.env.KIT_DIRECT;",
          'const b = process.env["KIT_BRACKET"];',
          // airgap/config.ts reads its vars off a destructured env object.
          "const c = pick(env.KIT_DESTRUCTURED, x);",
          // set for a hook / child process
          'spawn(cmd, { env: { KIT_SET_FOR_CHILD: "1" } });',
        ].join("\n"),
        "utf-8",
      );
      const known = loadKnownEnvVars(root);
      for (const v of ["KIT_DIRECT", "KIT_BRACKET", "KIT_DESTRUCTURED", "KIT_SET_FOR_CHILD"]) {
        assert.ok(known.has(v), `${v} must be recognised`);
      }
      assert.equal(known.has("KIT_NEVER_MENTIONED"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes test files, so a var only a test names does not count as wired", () => {
    // This is the KIT_MEMORY_CLASS shape: a pure resolver unit-tested in isolation
    // with zero production call sites. A test must not make the claim true.
    const root = mkdtempSync(join(tmpdir(), "kit-envvars2-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "a.test.ts"), "process.env.KIT_ONLY_IN_TEST;", "utf-8");
      assert.equal(loadKnownEnvVars(root).has("KIT_ONLY_IN_TEST"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("kit's own tree knows the hardware mandate var, and not the misspelling", () => {
    // README, doctor's remediation hint and the NIST evidence map all documented
    // KIT_REQUIRE_HARDWARE; the variable the code reads is KIT_REQUIRE_HARDWARE_IDENTITY.
    const known = loadKnownEnvVars(join(import.meta.dirname, ".."));
    assert.ok(known.has("KIT_REQUIRE_HARDWARE_IDENTITY"));
  });
});

/**
 * The INVERSE gate. Its siblings prove no doc names something kit lacks; these prove kit
 * ships nothing a reader cannot find. The distinction matters because the forward gate is
 * structurally incapable of catching this class: an undocumented command has, by
 * definition, no doc reference to check.
 */
describe("self-audit-docs — undocumentedCommands (the inverse gate)", () => {
  const CONTRACT_WITH_HARNESS = JSON.stringify({
    opencliVersion: "0.1",
    commands: {
      check: { kind: "command", "x-kit-audience": "all" },
      "gate-fs": { kind: "command", "x-kit-audience": "harness" },
    },
  });

  it("passes when every human-facing command appears in a doc", () => {
    const root = makeRepo({
      "contracts/kit.opencli.json": CONTRACT,
      "README.md": "Run `kit check` then `kit fix`.",
    });
    try {
      const r = undocumentedCommands(root);
      assert.equal(r.status, "pass");
      assert.match(r.detail, /all 2 human-facing command\(s\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FAILS naming a command that exists but no doc mentions", () => {
    const root = makeRepo({
      "contracts/kit.opencli.json": CONTRACT,
      "README.md": "Run `kit check`.", // `kit fix` deliberately absent
    });
    try {
      const r = undocumentedCommands(root);
      assert.equal(r.status, "fail");
      assert.match(r.detail, /kit fix/);
      assert.match(r.detail, /1 of 2/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts the brace form, so the repo's own house style is not 40 false gaps", () => {
    // `kit hooks {install,add,sync}` is how README documents a subcommand family. A
    // literal-only matcher would report every one of them as undocumented.
    const root = makeRepo({
      "contracts/kit.opencli.json": JSON.stringify({
        opencliVersion: "0.1",
        commands: { hooks: { kind: "command", "x-kit-audience": "human" } },
      }),
      "src/cli.ts":
        'const COMMAND_HELP = {\n  "hooks install": "x",\n  "hooks uninstall": "y",\n};',
      "README.md": "Use `kit hooks {install,uninstall}` to manage them.",
    });
    try {
      assert.equal(undocumentedCommands(root).status, "pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes harness-audience commands, read from the contract not a hardcoded list", () => {
    // `gate-fs` is invoked by hook wiring, never typed by a human. Requiring it in human
    // docs would manufacture busywork; the exclusion has to come from the contract so a
    // newly added gate verb inherits it without editing this rule.
    const root = makeRepo({
      "contracts/kit.opencli.json": CONTRACT_WITH_HARNESS,
      "README.md": "Run `kit check`.", // gate-fs deliberately undocumented
    });
    try {
      const r = undocumentedCommands(root);
      assert.equal(r.status, "pass");
      assert.match(r.detail, /1 harness-audience excluded/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sees a SUBCOMMAND the contract cannot express — the union oracle's whole point", () => {
    // Measured on the real tree: the contract lists top-level verbs only, so a
    // contract-only oracle reported 1 gap while the help-map oracle reported 9, and
    // neither was a superset. `kit hooks uninstall` — an enforcement off-switch — is
    // invisible to the contract alone.
    const root = makeRepo({
      "contracts/kit.opencli.json": JSON.stringify({
        opencliVersion: "0.1",
        commands: { hooks: { kind: "command", "x-kit-audience": "human" } },
      }),
      "src/cli.ts": 'const COMMAND_HELP = {\n  "hooks uninstall": "Remove the hooks",\n};',
      "README.md": "Use `kit hooks` for git hooks.",
    });
    try {
      const r = undocumentedCommands(root);
      assert.equal(r.status, "fail");
      assert.match(r.detail, /kit hooks uninstall/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cannot verify => didNotRun, rather than a green with no oracle", () => {
    const root = makeRepo({ "README.md": "no contract, no cli.ts" });
    try {
      const r = undocumentedCommands(root);
      assert.equal(r.status, "warn");
      assert.equal(r.didNotRun, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loadCommandSurface unions both oracles and marks harness verbs", () => {
    const root = makeRepo({
      "contracts/kit.opencli.json": CONTRACT_WITH_HARNESS,
      "src/cli.ts": 'const COMMAND_HELP = {\n  "check --json": "x",\n  "memory context": "y",\n};',
    });
    try {
      const s = loadCommandSurface(root);
      const verbs = s.map((c) => c.verb);
      assert.ok(verbs.includes("check"), "contract verb present");
      assert.ok(verbs.includes("memory context"), "help-map subcommand present");
      assert.equal(s.find((c) => c.verb === "gate-fs")?.harness, true);
      assert.equal(s.find((c) => c.verb === "check")?.harness, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
