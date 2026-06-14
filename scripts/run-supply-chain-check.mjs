#!/usr/bin/env node
// Runs only the bumblebee (known-compromise catalog) check.
// Other supply-chain checks (semgrep, socket, trivy, license) run as their
// own dedicated stages in the workflow — avoid running them twice.
import { checkSecurity } from "../dist/check-security.js";

const all = await checkSecurity();
const bumblebee = all.filter((r) => r.name && r.name.startsWith("bumblebee"));

console.log(JSON.stringify(bumblebee, null, 2));

const failed = bumblebee.filter((r) => r.status === "fail");
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length} bumblebee check(s) failed:`);
  for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log(`\nPASS: bumblebee scan ok (${bumblebee.length} result(s))`);
