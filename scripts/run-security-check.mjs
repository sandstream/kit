#!/usr/bin/env node
import { checkSecurity } from "../dist/check-security.js";

const all = await checkSecurity();

console.log(JSON.stringify(all, null, 2));

const failed = all.filter((r) => r.status === "fail");
if (failed.length > 0) {
  console.error(`\nFAIL: ${failed.length} security check(s) failed:`);
  for (const f of failed) console.error(`  - [${f.category}] ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log(`\nPASS: ${all.length} security check(s) ok`);
