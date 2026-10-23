#!/usr/bin/env node
// Weekly upstream watch: observe every entry in contracts/upstream-watch.json, classify it
// against its baseline (src/upstream-watch.ts), print a markdown report.
//
//   node scripts/upstream-watch.mjs [--write-baseline] > report.md
//
// --write-baseline records today's observations as the reviewed state. Run it in a PR,
// after reading what changed; never from the scheduled workflow.
// Exit code is 0 unless the contract itself is unreadable: drift is reported, not failed on
// (see the module header for why it stays out of every verdict).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, needsAttention, observe, renderReport } from "../dist/upstream-watch.js";

const CONTRACT = join(import.meta.dirname, "..", "contracts", "upstream-watch.json");
const args = process.argv.slice(2);
const writeBaseline = args.includes("--write-baseline");

const token = process.env.GITHUB_TOKEN;

async function fetchJson(url) {
  const headers = { Accept: "application/json", "User-Agent": "sandstream-kit-upstream-watch" };
  if (token && url.startsWith("https://api.github.com/")) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(60_000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`GET ${url} returned HTTP ${res.status}`);
  return res.json();
}

const contract = JSON.parse(readFileSync(CONTRACT, "utf8"));
const today = new Date().toISOString().slice(0, 10);
const results = [];
for (const entry of contract.entries) {
  try {
    results.push(evaluate(entry, await observe(entry.source, fetchJson)));
  } catch (error) {
    results.push(evaluate(entry, null, error instanceof Error ? error.message : String(error)));
  }
}

const report = renderReport(results, today);
process.stdout.write(report);

const attention = needsAttention(results).length;
process.stderr.write(`${attention} of ${results.length} upstream(s) need a look\n`);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `attention=${attention}\n`);

if (writeBaseline) {
  for (const entry of contract.entries) {
    const result = results.find((r) => r.id === entry.id);
    // A failed lookup or a dead upstream is never written as reviewed.
    if (!result?.observed || result.state === "dead") continue;
    entry.baseline = { version: result.observed.version, observedAt: today };
  }
  writeFileSync(CONTRACT, JSON.stringify(contract, null, 2) + "\n");
  process.stderr.write(`baseline written to ${CONTRACT}\n`);
}
