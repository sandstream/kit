#!/usr/bin/env node
// Nightly GuardDog sweep (#205): run ONLY the guarddog malware check, uncached,
// with the generous CI budget (KIT_GUARDDOG_TIMEOUT_MS). Fail closed: in the
// nightly sweep an UNVERIFIED/incomplete scan blocks — the sweep exists to
// guarantee a completed scan happens continuously, so "didn't finish" is a
// failure here, not a warning.
import { checkSecurity } from "../dist/check-security.js";

const all = await checkSecurity();
const guarddog = all.filter((r) => r.name === "guarddog (malware)");

console.log(JSON.stringify(guarddog, null, 2));

if (guarddog.length === 0) {
  console.error("FAIL: guarddog check did not run at all (opt-in env missing?)");
  process.exit(1);
}
const blocking = guarddog.filter((r) => r.status === "fail" || r.status === "warn");
if (blocking.length > 0) {
  console.error(`\nFAIL: guarddog sweep blocked:`);
  for (const f of blocking) console.error(`  - ${f.name} [${f.status}]: ${f.detail}`);
  process.exit(1);
}
const skipped = guarddog.filter((r) => r.status === "skip");
if (skipped.length === guarddog.length) {
  console.error("FAIL: guarddog sweep skipped — nothing was scanned (fail-closed in nightly)");
  process.exit(1);
}
console.log(`\nPASS: guarddog sweep clean (${guarddog.length} result(s))`);
