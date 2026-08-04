// Cross-platform test runner (#43). POSIX inline env-vars (`FOO=1 node …`) don't
// work in Windows cmd/pwsh — they're parsed as a command and fail. So set the env
// here, collect the compiled test files ourselves (no shell-glob dependency, which
// also differs across shells), and invoke `node --test`. No external dep.
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const env = {
  ...process.env,
  KIT_NON_INTERACTIVE: "1",
  KIT_BUMBLEBEE: "0",
  KIT_NO_FAILURE_SIM: "1",
  KIT_NO_UPDATE_CHECK: "1",
  // Keep incidental audit appends from touching the real ~/.kit anchor. Tests
  // that exercise anchoring opt back in with an explicit KIT_AUDIT_ANCHOR_DIR.
  KIT_AUDIT_ANCHOR: "0",
};

if (!existsSync("dist")) {
  console.error("dist/ not found — run `npm run build` first");
  process.exit(1);
}

// Recursively collect compiled .test.js files under dist/ (deterministic; no
// shell/library glob expansion involved).
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(p));
    else if (entry.name.endsWith(".test.js")) out.push(p);
  }
  return out;
}

// The workspace packages compile to `packages/<pkg>/dist/`, which `collect("dist")` never sees.
// Measured: 11 compiled plugin test files, 76 tests — including every `KIT_READ_ONLY=1` refusal
// test the plugin write surfaces have — existed and were never executed by `npm test`, so CI has
// never run them. They pass; nobody was watching. A containment test that does not run is worth
// less than no test, because it reads as coverage.
function collectWorkspaceTests() {
  const out = [];
  if (!existsSync("packages")) return out;
  for (const pkg of readdirSync("packages", { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const dist = join("packages", pkg.name, "dist");
    if (existsSync(dist)) out.push(...collect(dist));
  }
  return out;
}

const files = [...collect("dist"), ...collectWorkspaceTests()];
if (files.length === 0) {
  console.error("no dist/**/*.test.js files found");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--test", "--test-timeout=180000", "--test-concurrency=2", ...files],
  { stdio: "inherit", env },
);
process.exit(result.status ?? 1);
