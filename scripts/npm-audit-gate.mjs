#!/usr/bin/env node
// CI form of the npm audit gate: `npm audit --audit-level=high`, except that the time-limited
// exceptions in audit-exceptions.json can cover findings that have no patched version.
// The rules live in src/audit-exceptions.ts (build first). Exit 0 = clean or fully covered.
import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = spawnSync(npm, ["audit", "--audit-level=high", "--json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  shell: process.platform === "win32",
});

if (run.status === 0) {
  console.log("npm audit: no high or critical vulnerabilities");
  process.exit(0);
}

let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error(`npm audit could not run (exit ${run.status}): ${(run.stderr || "").trim()}`);
  process.exit(1);
}

const meta = report.metadata?.vulnerabilities ?? {};
const counts = `${meta.critical ?? 0} critical, ${meta.high ?? 0} high vulnerabilities`;
// No build, no exceptions: the gate then behaves exactly like a bare `npm audit`.
let decision = { covered: false, note: "" };
try {
  const { auditDecision } = await import("../dist/audit-exceptions.js");
  decision = await auditDecision(process.cwd(), report);
} catch {
  decision.note = "exceptions not read (run npm run build)";
}
const { covered, note } = decision;
if (covered) {
  console.log(`npm audit: ${counts}, all covered by a time-limited exception (${note})`);
  process.exit(0);
}
console.error(`npm audit failed: ${counts}${note ? `; ${note}` : ""}`);
console.error("Run `npm audit` for the list.");
process.exit(1);
