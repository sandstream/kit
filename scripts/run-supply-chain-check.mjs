#!/usr/bin/env node
// Runs only the bumblebee (known-compromise catalog) check.
// Other supply-chain checks (semgrep, socket, trivy, license) run as their
// own dedicated stages in the workflow — avoid running them twice.
import { checkSecurity } from "../dist/check-security.js";

const all = await checkSecurity();
const bumblebee = all.filter((r) => r.name && r.name.startsWith("bumblebee"));

console.log(JSON.stringify(bumblebee, null, 2));

// Publish gate: by default only a hard "fail" blocks. But scanner-unavailable /
// download-failed / scan-incomplete return "warn" — an UNSCANNED release would
// then ship green. KIT_BUMBLEBEE_REQUIRED=1 makes "warn" block too (fail-closed),
// so a release can never ship without a completed, clean scan.
const required = ["1", "true", "on", "yes"].includes(
  (process.env.KIT_BUMBLEBEE_REQUIRED ?? "").trim().toLowerCase(),
);
const blocking = bumblebee.filter((r) => r.status === "fail" || (required && r.status === "warn"));
if (blocking.length > 0) {
  console.error(`\nFAIL: ${blocking.length} bumblebee check(s) blocked the publish gate:`);
  for (const f of blocking) console.error(`  - ${f.name} [${f.status}]: ${f.detail}`);
  if (required) console.error("(KIT_BUMBLEBEE_REQUIRED=1 — warnings are fatal)");
  process.exit(1);
}
console.log(`\nPASS: bumblebee scan ok (${bumblebee.length} result(s))`);
