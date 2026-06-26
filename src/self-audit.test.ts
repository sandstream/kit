import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SELF_AUDIT_RULES,
  runSelfAudit,
  resolveKitRoot,
  extractKitTools,
  READ_ONLY_SAFE,
  isConflictCopyFile,
  isConflictCopyDir,
  type SelfAuditRule,
  type SelfAuditCtx,
  type SourceFile,
} from "./self-audit.js";

// Compiled test lives at dist/self-audit.test.js; repo root is one dir up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ruleById = (id: string): SelfAuditRule => {
  const r = SELF_AUDIT_RULES.find((x) => x.id === id);
  assert.ok(r, `rule ${id} must exist`);
  return r;
};

/** Build a single-file ctx from inline source text. */
function ctxFromText(text: string, path = "fixture.ts", repoRoot = "/repo"): SelfAuditCtx {
  const sf: SourceFile = { path, text, lines: text.split("\n") };
  return { repoRoot, sources: [sf], pkgJson: {} };
}

/** Read a real kit source file as a SourceFile (the post-fix negative). */
function realSource(rel: string): SourceFile {
  const abs = join(REPO_ROOT, rel);
  const text = readFileSync(abs, "utf8");
  return { path: rel, text, lines: text.split("\n") };
}

function countStatus(results: { status: string }[], status: string): number {
  return results.filter((r) => r.status === status).length;
}

// ---------------------------------------------------------------------------
// Per-rule: FIRES on the pre-fix positive, SILENT on the post-fix negative.
// ---------------------------------------------------------------------------

describe("R1b-nan-fresh", () => {
  it("fires when a parsed timestamp is compared to a cutoff with no finite guard", () => {
    const pre = `function check(ts: string, cutoff: number) {
  const parsed = Date.parse(ts);
  if (parsed < cutoff) return false;
  return true;
}`;
    const res = ruleById("R1b-nan-fresh").run(ctxFromText(pre));
    assert.equal(countStatus(res, "warn"), 1);
  });

  it("is silent with a Number.isFinite guard (real cli.ts post-fix)", () => {
    const post = `function check(ts: string, cutoff: number) {
  const parsed = ts ? Date.parse(ts) : NaN;
  if (!Number.isFinite(parsed) || parsed < cutoff) return false;
  return true;
}`;
    const res = ruleById("R1b-nan-fresh").run(ctxFromText(post));
    assert.equal(countStatus(res, "warn"), 0);
    assert.equal(res[0].status, "pass");
  });
});

describe("R2-secret-argv", () => {
  it("fires when a secret-bearing exec error is surfaced raw", () => {
    const pre = `async function sync(name: string, value: string) {
  try {
    await exec("gh", ["secret", "set", name, "--body", value]);
  } catch (err) {
    failed.push(\`\${name}: \${err.message}\`);
  }
}`;
    const res = ruleById("R2-secret-argv").run(ctxFromText(pre));
    assert.equal(countStatus(res, "warn"), 1);
  });

  it("is silent when routed through safeErrorMessage (real secrets-sync.ts)", () => {
    const post = realSource("src/secrets-sync.ts");
    const res = ruleById("R2-secret-argv").run({
      repoRoot: REPO_ROOT,
      sources: [post],
      pkgJson: {},
    });
    assert.equal(countStatus(res, "warn"), 0);
  });
});

describe("R3-state-perms", () => {
  it("fires on a sensitive write without mode/secureFile", () => {
    const pre = `async function write(content: string) {
  await writeFile(".env.local", content, "utf-8");
}`;
    const res = ruleById("R3-state-perms").run(ctxFromText(pre));
    assert.equal(countStatus(res, "fail"), 1);
  });

  it("is silent with { mode: 0o600 } + secureFile (real secrets.ts)", () => {
    const post = realSource("src/secrets.ts");
    const res = ruleById("R3-state-perms").run({
      repoRoot: REPO_ROOT,
      sources: [post],
      pkgJson: {},
    });
    assert.equal(countStatus(res, "fail"), 0);
  });

  it("does not treat process.env as a sensitive .env path", () => {
    const ok = `async function summary(lines: string[]) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY!, lines.join("\\n"));
}`;
    const res = ruleById("R3-state-perms").run(ctxFromText(ok));
    assert.equal(countStatus(res, "fail"), 0);
  });

  it("FAILS on a world-readable mode (0o644) — presence of mode: is not enough", () => {
    const pre = `function w(v: string) {
  writeFileSync(".env", v, { mode: 0o644 });
}`;
    const res = ruleById("R3-state-perms").run(ctxFromText(pre));
    assert.equal(countStatus(res, "fail"), 1);
  });

  it("FAILS on mode: 0o777 (group/other writable)", () => {
    const pre = `function w(v: string) {
  writeFileSync(".env", v, { mode: 0o777 });
}`;
    const res = ruleById("R3-state-perms").run(ctxFromText(pre));
    assert.equal(countStatus(res, "fail"), 1);
  });

  it("is silent on owner-only mode 0o0600 (leading zero) and 0o600", () => {
    const ok0 = `function w(v: string) {
  writeFileSync(".env", v, { mode: 0o0600 });
}`;
    assert.equal(countStatus(ruleById("R3-state-perms").run(ctxFromText(ok0)), "fail"), 0);
    const ok1 = `function w(v: string) {
  writeFileSync(".env", v, { mode: 0o600 });
}`;
    assert.equal(countStatus(ruleById("R3-state-perms").run(ctxFromText(ok1)), "fail"), 0);
  });
});

describe("R4-validate-before-use", () => {
  it("fires when npm pack runs before the validator", () => {
    const pre = `async function inspect(spec: string) {
  const { stdout } = await exec("npm", ["pack", spec, "--json"], { cwd });
  if (!isRegistrySpec(spec)) return stop();
}`;
    const res = ruleById("R4-validate-before-use").run(ctxFromText(pre));
    assert.equal(countStatus(res, "warn"), 1);
  });

  it("is silent when validator precedes the sink (real triage-sandbox.ts)", () => {
    const post = realSource("src/triage-sandbox.ts");
    const res = ruleById("R4-validate-before-use").run({
      repoRoot: REPO_ROOT,
      sources: [post],
      pkgJson: {},
    });
    assert.equal(countStatus(res, "warn"), 0);
  });

  it("does not flag static string-literal dynamic imports", () => {
    const ok = `async function x() {
  const { foo } = await import("node:fs/promises");
  return foo;
}`;
    const res = ruleById("R4-validate-before-use").run(ctxFromText(ok));
    assert.equal(countStatus(res, "warn"), 0);
  });

  it("FAILS to find a validator for a Prettier-wrapped dynamic import (multi-line)", () => {
    // Wrapped import() of a variable with no validator -> warn (same as inline).
    const pre = `async function load(name: string) {
  const mod = await import(
    name
  );
  return mod;
}`;
    const res = ruleById("R4-validate-before-use").run(ctxFromText(pre));
    assert.equal(countStatus(res, "warn"), 1);
  });
});

describe("R6-dynamic-import", () => {
  it("fires on import() of a variable with no name/containment guards", () => {
    const pre = `async function load(name: string) {
  const mod = await import(name);
  return mod;
}`;
    const res = ruleById("R6-dynamic-import").run(ctxFromText(pre));
    assert.equal(countStatus(res, "fail"), 1);
  });

  it("FAILS on a Prettier-wrapped import() of a variable (multi-line)", () => {
    // Prettier (kit's `npm run format`) wraps a long dynamic import across lines.
    // A per-physical-line scan misses this; the dot-all window scan must catch it.
    const pre = `async function load(name: string) {
  const mod = await import(
    name
  );
  return mod;
}`;
    const res = ruleById("R6-dynamic-import").run(ctxFromText(pre));
    assert.equal(countStatus(res, "fail"), 1);
  });

  it("is silent when name + containment are validated (real plugin-loader.ts)", () => {
    const post = realSource("src/plugin-loader.ts");
    const res = ruleById("R6-dynamic-import").run({
      repoRoot: REPO_ROOT,
      sources: [post],
      pkgJson: {},
    });
    assert.equal(countStatus(res, "fail"), 0);
  });
});

describe("R7-output-escaping", () => {
  it("fires on inconsistent escaping (some interps raw)", () => {
    const pre = `function emit(checks: any[]) {
  for (const ch of checks) {
    const msg = escapeWorkflowCmd(ch.name);
    console.log(\`::error::\${ch.detail}\`);
  }
}`;
    const res = ruleById("R7-output-escaping").run(ctxFromText(pre));
    assert.equal(countStatus(res, "fail"), 1);
  });

  it("is silent when every interpolation is escaped (real cli.ts emitters)", () => {
    const post = realSource("src/cli.ts");
    const res = ruleById("R7-output-escaping").run({
      repoRoot: REPO_ROOT,
      sources: [post],
      pkgJson: {},
    });
    assert.equal(countStatus(res, "fail"), 0);
  });
});

describe("R8-readonly-guard", () => {
  it("fires when a mutating MCP tool handler lacks the readonly guard", () => {
    // Not allowlisted + a real side-effect (installTools) + no guard -> finding.
    const pre = `function register(server: any) {
  server.tool(
    "kit_install",
    "desc",
    {},
    async ({ cwd }) => {
      const config = await loadConfig(configPath(cwd));
      return installTools(config);
    },
  );
}`;
    const res = ruleById("R8-readonly-guard").run(ctxFromText(pre, "mcp-server.ts"));
    assert.ok(countStatus(res, "warn") >= 1);
  });

  it("does NOT fire on a no-op stub (no side-effect) even if not allowlisted", () => {
    const stub = `function register(server: any) {
  server.tool(
    "kit_future_tool",
    "desc",
    {},
    async ({ cwd }) => {
      return { content: [{ type: "text", text: JSON.stringify({ cwd }) }] };
    },
  );
}`;
    const res = ruleById("R8-readonly-guard").run(ctxFromText(stub, "mcp-server.ts"));
    assert.equal(countStatus(res, "warn"), 0);
  });

  it("is silent when each mutating tool opens with the guard (real mcp-server.ts)", () => {
    const post = realSource("src/mcp-server.ts");
    const res = ruleById("R8-readonly-guard").run({
      repoRoot: REPO_ROOT,
      sources: [post],
      pkgJson: {},
    });
    assert.equal(countStatus(res, "warn"), 0);
  });

  it("completeness: every kit_* tool is classified (allowlisted OR guarded/stub)", () => {
    // Fail-closed contract: no registered tool may be UNclassified. A tool is
    // classified iff it is read-only-allowlisted, OR (mutating) it has a guard, OR
    // it has no real side-effect (a stub). An unclassified mutating tool == a new
    // fail-open hole; this asserts the allowlist stays in sync with mcp-server.ts.
    const post = realSource("src/mcp-server.ts");
    const tools = extractKitTools(post);
    assert.ok(tools.length >= 17, `expected >= 17 kit_* tools, found ${tools.length}`);

    const unclassified: string[] = [];
    for (const t of tools) {
      if (READ_ONLY_SAFE.has(t.name)) continue;
      // Find the handler entry and inspect the guard window + body.
      let handlerIdx = -1;
      for (let i = t.regIdx; i < Math.min(post.lines.length, t.regIdx + 30); i++) {
        if (/async\s*\([^)]*\)\s*=>/.test(post.lines[i])) {
          handlerIdx = i;
          break;
        }
      }
      if (handlerIdx < 0) {
        unclassified.push(`${t.name} (no handler found)`);
        continue;
      }
      const guardWindow = post.lines.slice(handlerIdx, handlerIdx + 12).join("\n");
      const guarded = /isReadOnlyMode\s*\(|readOnlyRefusal\s*\(/.test(guardWindow);
      const body = post.lines.slice(handlerIdx, handlerIdx + 80).join("\n");
      const sideEffect =
        /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|generateSecrets|loginServices|provisionService|installTools|executeCommand|execFileSync|execFile|execSync|spawnSync|spawn|exec)\s*\(/.test(
          body,
        );
      // Classified iff guarded, or a no-op stub (no side-effect).
      if (!guarded && sideEffect) unclassified.push(t.name);
    }
    assert.deepEqual(
      unclassified,
      [],
      `unclassified mutating MCP tools (add guard or allowlist): ${unclassified.join(", ")}`,
    );
  });
});

describe("R9-unkeyed-anchor", () => {
  it("fires on a raw write to .kit-audit.jsonl", () => {
    const pre = `async function record(line: string) {
  await appendFile(".kit-audit.jsonl", line);
}`;
    const res = ruleById("R9-unkeyed-anchor").run(ctxFromText(pre));
    assert.equal(countStatus(res, "fail"), 1);
  });

  it("is silent when findings target .kit-findings.jsonl (real check-security.ts)", () => {
    const post = realSource("src/check-security.ts");
    const res = ruleById("R9-unkeyed-anchor").run({
      repoRoot: REPO_ROOT,
      sources: [post],
      pkgJson: {},
    });
    assert.equal(countStatus(res, "fail"), 0);
  });
});

describe("R10-toolchain-pin", () => {
  it("flags a bare untrusted command (info -> warn/low)", () => {
    const pre = `function extract(p: string) {
  execFileSync("tar", ["-xzf", p]);
}`;
    const res = ruleById("R10-toolchain-pin").run(ctxFromText(pre));
    const w = res.filter((r) => r.status === "warn");
    assert.ok(w.length >= 1);
    assert.equal(w[0].severity, "low");
  });

  it("does not flag trusted builtins", () => {
    const ok = `function build() {
  execFileSync("npm", ["run", "build"]);
  execFileSync("git", ["status"]);
}`;
    const res = ruleById("R10-toolchain-pin").run(ctxFromText(ok));
    assert.equal(countStatus(res, "warn"), 0);
  });
});

describe("R5-env-trust", () => {
  it("flags a KIT_* env that relaxes a check to skip (info -> warn/low)", () => {
    const pre = `function check() {
  if (envFlagDisabled(process.env.KIT_BUMBLEBEE)) {
    return { status: "skip", detail: "disabled" };
  }
}`;
    const res = ruleById("R5-env-trust").run(ctxFromText(pre));
    const w = res.filter((r) => r.status === "warn");
    assert.equal(w.length, 1);
    assert.equal(w[0].severity, "low");
  });

  it("does not flag a KIT_* env that tightens to fail", () => {
    const ok = `function check() {
  const required = envFlagEnabled(process.env.KIT_BUMBLEBEE_REQUIRED);
  const unscanned = required ? "fail" : "warn";
  return unscanned;
}`;
    const res = ruleById("R5-env-trust").run(ctxFromText(ok));
    assert.equal(countStatus(res, "warn"), 0);
  });
});

describe("R1-fail-open-ci", () => {
  it("FAILS on unannotated '|| true' (gates) and WARNS on continue-on-error", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-r1-"));
    try {
      const wf = join(dir, ".github", "workflows");
      mkdirSync(wf, { recursive: true });
      writeFileSync(
        join(wf, "ci.yml"),
        `name: ci
on: [push]
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - run: npm test || true
      - uses: some/action@v1
        continue-on-error: true
`,
      );
      const res = ruleById("R1-fail-open-ci").run({ repoRoot: dir, sources: [], pkgJson: {} });
      // `|| true` now GATES (fail/high); continue-on-error stays a warn (advisory).
      assert.equal(countStatus(res, "fail"), 1);
      const fail = res.find((r) => r.status === "fail");
      assert.equal(fail?.severity, "high");
      assert.equal(countStatus(res, "warn"), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores '|| true' inside a comment and honours allow-annotation", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-r1b-"));
    try {
      const wf = join(dir, ".github", "workflows");
      mkdirSync(wf, { recursive: true });
      writeFileSync(
        join(wf, "ci.yml"),
        `name: ci
on: [push]
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      # no '|| true' here — set +e/RC instead
      - run: gh release upload "$TAG" file --clobber || true  # kit-self-audit: allow-continue-on-error
`,
      );
      const res = ruleById("R1-fail-open-ci").run({ repoRoot: dir, sources: [], pkgJson: {} });
      assert.equal(res.length, 1);
      assert.equal(res[0].status, "pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R11-script-paths", () => {
  it("delegates to runCiScriptAudit: fails on a missing script ref", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-r11-"));
    try {
      const wf = join(dir, ".github", "workflows");
      mkdirSync(wf, { recursive: true });
      writeFileSync(
        join(wf, "ci.yml"),
        `jobs:\n  x:\n    steps:\n      - run: node scripts/missing.mjs\n`,
      );
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: {} }));
      const res = ruleById("R11-script-paths").run({ repoRoot: dir, sources: [], pkgJson: {} });
      assert.equal(countStatus(res, "fail"), 1);
      assert.equal(res[0].category, "self-audit/ci-script-paths");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R12-dup-source", () => {
  it("predicate: fires on ' N.ext' conflict copies, silent on normal names", () => {
    // Positive: a space, digits, then a source extension at end-of-string.
    assert.equal(isConflictCopyFile("foo 2.ts"), true);
    assert.equal(isConflictCopyFile("bar 3.js"), true);
    assert.equal(isConflictCopyFile("notes 10.md"), true);
    assert.equal(isConflictCopyFile("esm 2.mjs"), true);
    assert.equal(isConflictCopyFile("legacy 2.cjs"), true);
    // Negative: no space before the digit, or a non-source extension.
    assert.equal(isConflictCopyFile("cloudflare-r2.ts"), false);
    assert.equal(isConflictCopyFile("cli.ts"), false);
    assert.equal(isConflictCopyFile("base64.ts"), false);
    assert.equal(isConflictCopyFile("data 2.json"), false);
    assert.equal(isConflictCopyFile("cli 2.d.ts"), false);
  });

  it("predicate: fires on top-level dist/src mirror dirs only", () => {
    assert.equal(isConflictCopyDir("dist 2"), true);
    assert.equal(isConflictCopyDir("src 3"), true);
    assert.equal(isConflictCopyDir("dist"), false);
    assert.equal(isConflictCopyDir("src"), false);
    assert.equal(isConflictCopyDir("distribution 2"), false);
  });

  it("WARNS (never fails) on conflict copies in the tree; silent on clean names", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-r12-"));
    try {
      // Conflict copies (should fire).
      writeFileSync(join(dir, "foo 2.ts"), "export const x = 1;\n");
      writeFileSync(join(dir, "bar 3.js"), "module.exports = {};\n");
      mkdirSync(join(dir, "dist 2"));
      writeFileSync(join(dir, "dist 2", "cli.js"), "// mirror\n");
      // Clean names (should stay silent).
      writeFileSync(join(dir, "cloudflare-r2.ts"), "export const r2 = 1;\n");
      writeFileSync(join(dir, "cli.ts"), "export const cli = 1;\n");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "index.ts"), "export {};\n");

      const res = ruleById("R12-dup-source").run({ repoRoot: dir, sources: [], pkgJson: {} });
      // It must never gate: zero fails, severity is advisory.
      assert.equal(countStatus(res, "fail"), 0);
      // foo 2.ts, bar 3.js, and the dist 2/ mirror dir = 3 warns; the dir is NOT
      // descended, so dist 2/cli.js does not produce a second finding.
      assert.equal(countStatus(res, "warn"), 3);
      for (const r of res) assert.equal(r.status, "warn");
      const flagged = res.flatMap((r) => r.files ?? []);
      assert.ok(flagged.some((f) => f.startsWith("foo 2.ts")));
      assert.ok(flagged.some((f) => f.startsWith("bar 3.js")));
      assert.ok(flagged.some((f) => f.startsWith("dist 2")));
      assert.ok(!flagged.some((f) => f.includes("cloudflare-r2.ts")));
      assert.ok(!flagged.some((f) => f.startsWith("cli.ts")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// resolveKitRoot
// ---------------------------------------------------------------------------

describe("resolveKitRoot", () => {
  it("finds the sandstream-kit root from the compiled module dir", () => {
    const root = resolveKitRoot();
    assert.ok(root, "kit root must resolve");
    const pkg = JSON.parse(readFileSync(join(root!, "package.json"), "utf8"));
    assert.equal(pkg.name, "sandstream-kit");
  });

  it("returns null when no sandstream-kit package.json is up-tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-noroot-"));
    try {
      // A tmp dir under /tmp has no sandstream-kit ancestor.
      assert.equal(resolveKitRoot(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runSelfAudit shape + only-filter
// ---------------------------------------------------------------------------

describe("runSelfAudit", () => {
  it("categories are all prefixed self-audit/", () => {
    const root = resolveKitRoot();
    assert.ok(root);
    const res = runSelfAudit(root!);
    assert.ok(res.length > 0);
    for (const r of res) assert.ok(r.category.startsWith("self-audit/"), r.category);
  });

  it("only-filter restricts to the requested rule ids", () => {
    const root = resolveKitRoot();
    assert.ok(root);
    const res = runSelfAudit(root!, { only: ["R10-toolchain-pin"] });
    for (const r of res) assert.equal(r.category, "self-audit/toolchain-pin");
  });
});

// ---------------------------------------------------------------------------
// KEYSTONE: kit self-audits clean (0 fail) over its CURRENT tree.
// This is the green=honest regression anchor — a rule that flags fixed code is a
// bug. warn/info results are allowed; only `fail` is asserted to be zero.
// ---------------------------------------------------------------------------

describe("keystone: kit self-audits clean", () => {
  it("runSelfAudit over the current kit tree returns ZERO fail results", () => {
    const root = resolveKitRoot();
    assert.ok(root, "kit root must resolve for the keystone");
    assert.ok(existsSync(join(root!, "src")), "kit src/ must exist");
    const res = runSelfAudit(root!);
    const fails = res.filter((r) => r.status === "fail");
    assert.equal(
      fails.length,
      0,
      `expected 0 fail, got ${fails.length}:\n` +
        fails.map((f) => `  ${f.category} ${(f.files ?? []).join(",")} — ${f.detail}`).join("\n"),
    );
  });
});
