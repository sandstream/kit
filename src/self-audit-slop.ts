// The "slop" rules: claims and exports that drift because nothing re-counts them, and tests
// that pass whatever the code does.
// They live here, not in self-audit.ts, so the registry only spreads them in; the rule
// count they check against is the registry's own length, read when the rule runs.

import type { SelfAuditRule } from "./self-audit.js";
import { runExportsAudit } from "./self-audit-exports.js";
import { runCountClaimsAudit } from "./self-audit-counts.js";
import { runJunkTestsAudit } from "./self-audit-junk-tests.js";

export function slopRules(ruleCount: () => number): SelfAuditRule[] {
  return [
    {
      id: "R16-unreferenced-exports",
      name: "unreferenced exports",
      detectionClass: "unreferenced-export",
      // error: an export no other file names is dead or over-exported, and either way
      // the fix is mechanical. Protected paths come back as warn (the owner decides).
      severity: "error",
      enabled: true,
      run: (ctx) => runExportsAudit(ctx.repoRoot),
    },
    {
      id: "R17-count-claims",
      name: "count claims",
      detectionClass: "count-claims",
      severity: "error",
      enabled: true,
      run: (ctx) => runCountClaimsAudit(ctx.repoRoot, ruleCount()),
    },
    {
      id: "R18-junk-tests",
      name: "junk-pattern tests",
      detectionClass: "junk-tests",
      // error: a test that asserts nothing, compares a value with itself or repeats another
      // test word for word passes whatever the code does. The fix is in the test file.
      severity: "error",
      enabled: true,
      run: (ctx) => runJunkTestsAudit(ctx.repoRoot, "junk-pattern tests"),
    },
  ];
}
