import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Scope-needs adoption gate.
 *
 * `withGovernance` checks `scopeNeeds` against the signed [scope]/RoE — but a
 * check nobody feeds is a structural no-op: the field existed for a full minor
 * series with ZERO production call sites declaring anything, which is exactly
 * the "silently no-op" failure the 6.0 plan warns about. This gate makes that
 * silence impossible: every `withGovernance` / `runGovernedBrokered` call site
 * in production code must either declare its effects or sit on the explicit
 * reviewed list below WITH a reason. An undeclared new site fails the build
 * instead of quietly bypassing scope mediation.
 *
 * Same pattern as the CLI=MCP drift guard and the publish-ordering tests:
 * drift is a test failure, never a silent regression.
 */

// Repo root: this compiled test lives at dist/scope-needs-adoption.test.js.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

/** Keys that count as an effect declaration on either governance wrapper. */
const DECLARATION_KEYS = [
  "scopeNeeds", // withGovernance: checked against the signed [scope]
  "egressTargets", // runGovernedBrokered: broker egress gate
  "fsWrites", // runGovernedBrokered: broker fs gate
  "envRequested", // runGovernedBrokered: broker env scoping
  "declaredEffects", // runGovernedBrokered: explicit "no effects" assertion
  "infrastructure", // runGovernedBrokered: kit's own provisioning, RoE-exempt
];

/**
 * Call sites reviewed and consciously left undeclared. This is NOT a
 * zero-effects claim — it is "a maintainer looked, and here is why no
 * declaration is made". Every entry must still match a real call site
 * (checked below), so the list cannot rot.
 */
const REVIEWED_UNDECLARED: { file: string; operation: string; reason: string }[] = [
  {
    file: "src/commands/check.ts",
    operation: "check",
    reason: "pure read — verification only; no egress, writes, or secret exposure",
  },
  {
    file: "src/commands/ci.ts",
    operation: "check",
    reason: "pure read — CI rendering of the same checks",
  },
  {
    file: "src/commands/info.ts",
    operation: "health",
    reason:
      "read-only sensors; the PAL sync writes kit-internal state under ~/.kit, which the project [scope] RoE does not govern",
  },
  {
    file: "src/commands/agent.ts",
    operation: "escalate",
    reason: "pure read — lists pending escalations from check results",
  },
  {
    file: "src/commands/install.ts",
    operation: "tools.install",
    reason:
      "infrastructure — mise provisioning into $HOME, mirrors the MCP site's `infrastructure: true`; no project-scope effects to declare",
  },
  {
    file: "src/commands/login.ts",
    operation: "services.login",
    reason:
      "egress happens inside provider CLIs' own subprocesses; hosts are adapter-owned and not statically enumerable — per-adapter needs is a named follow-up",
  },
];

/** Strip line/block comments; neutralize brackets inside strings (keeps braces balanced). */
function stripNoise(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += quote;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") {
          out += "\\" + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        // Keep string contents (operation names are matched later) but
        // neutralize brackets so brace-matching stays balanced.
        out += /[{}()[\]]/.test(source[i]) ? " " : source[i];
        i++;
      }
      out += quote;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Extract the second argument (the context object literal) of a call starting at `callStart`. */
function extractContextObject(code: string, callStart: number): string | null {
  const open = code.indexOf("(", callStart);
  if (open < 0) return null;
  // Walk to the first top-level comma (end of arg 1), then brace-match arg 2.
  let depth = 0;
  let i = open + 1;
  for (; i < code.length; i++) {
    const ch = code[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return null; // call ended before a second arg
      depth--;
    } else if (ch === "," && depth === 0) break;
  }
  const braceStart = code.indexOf("{", i);
  if (braceStart < 0) return null;
  let braces = 0;
  for (let j = braceStart; j < code.length; j++) {
    if (code[j] === "{") braces++;
    else if (code[j] === "}") {
      braces--;
      if (braces === 0) return code.slice(braceStart, j + 1);
    }
  }
  return null;
}

interface CallSite {
  file: string;
  wrapper: string;
  operation: string | null;
  declared: boolean;
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(p, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function findCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const path of collectSourceFiles(SRC)) {
    const rel = relative(REPO_ROOT, path).split("\\").join("/");
    // The wrappers' own definitions are not call sites.
    if (rel === "src/governance-middleware.ts") continue;
    const code = stripNoise(readFileSync(path, "utf8"));
    const callRe = /\b(withGovernance|runGovernedBrokered)\s*(?:<[^>]*>)?\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(code)) !== null) {
      const ctx = extractContextObject(code, m.index);
      if (!ctx) continue; // not a real call (e.g. a re-export or type position)
      const opMatch = /operation:\s*"([^"]+)"/.exec(ctx);
      // `key:` (explicit) or `key,`/`key}` (object shorthand, e.g. `egressTargets,`).
      const declared = DECLARATION_KEYS.some((k) =>
        new RegExp(`(?:^|[,{\\s])${k}\\s*[:,}]`).test(ctx),
      );
      sites.push({ file: rel, wrapper: m[1], operation: opMatch?.[1] ?? null, declared });
    }
  }
  return sites;
}

describe("scope-needs adoption gate", () => {
  const sites = findCallSites();

  it("finds the governed call sites at all (the scanner itself must not rot)", () => {
    // If a refactor renames the wrappers or moves everything, this gate would
    // otherwise pass vacuously — require a sane minimum.
    assert.ok(
      sites.length >= 8,
      `expected at least 8 governed call sites, found ${sites.length} — did the wrappers get renamed?`,
    );
  });

  it("every governed call site declares its effects or is explicitly reviewed", () => {
    const undeclared = sites.filter(
      (s) =>
        !s.declared &&
        !REVIEWED_UNDECLARED.some((r) => r.file === s.file && r.operation === s.operation),
    );
    assert.deepEqual(
      undeclared.map((s) => `${s.file} (${s.wrapper} "${s.operation}")`),
      [],
      "undeclared governed call site(s) — declare scopeNeeds/broker effects, or add a REVIEWED_UNDECLARED entry with a reason",
    );
  });

  it("the reviewed list matches real call sites (no rot)", () => {
    const stale = REVIEWED_UNDECLARED.filter(
      (r) => !sites.some((s) => s.file === r.file && s.operation === r.operation && !s.declared),
    );
    assert.deepEqual(
      stale.map((r) => `${r.file} ("${r.operation}")`),
      [],
      "stale REVIEWED_UNDECLARED entries — the site now declares needs (remove the entry) or moved (update it)",
    );
  });

  it("the flagship declarations stay declared", () => {
    // secrets.generate and fix are the two CLI sites with statically-known
    // effects — the dogfood proof that scope mediation runs on kit itself.
    for (const op of ["secrets.generate", "fix"]) {
      const site = sites.find((s) => s.operation === op && s.wrapper === "withGovernance");
      assert.ok(site, `withGovernance site for "${op}" not found`);
      assert.equal(site.declared, true, `"${op}" lost its scopeNeeds declaration`);
    }
  });
});
