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

// A FULL TAP log always lands on disk, in addition to whatever the caller sees on stdout.
//
// Why: a run of this suite reported `# fail 1` and the failing test's NAME was unrecoverable,
// because the invocation was piped through `tail` and everything above the summary was discarded.
// Four re-runs were green, so the flake could not be re-caught, and an intermittent failure with no
// name is the shape that teaches people to re-run until green. The detail must not depend on how the
// caller happened to redirect stdout — so node writes a second, complete report to a file itself.
//
// `--test-reporter`/`--test-reporter-destination` are positional PAIRS: spec to stdout for humans,
// tap to the log for the next time this happens.
// Naming a reporter REPLACES node's default entirely, and that default is adaptive: `spec` when
// stdout is a TTY, `tap` when it is piped. Forcing one would silently change the output contract —
// a `npm test | grep '# fail'` that worked before would stop matching. So the stdout reporter is
// node's own choice, reproduced, and the file reporter is purely additive.
const TAP_LOG = ".kit-test-run.tap";
const stdoutReporter = process.stdout.isTTY ? "spec" : "tap";
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-timeout=180000",
    "--test-concurrency=2",
    `--test-reporter=${stdoutReporter}`,
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    `--test-reporter-destination=${TAP_LOG}`,
    ...files,
  ],
  { stdio: "inherit", env },
);
if (result.status !== 0) {
  console.error(
    `\n[kit] full TAP report written to ${TAP_LOG} — grep '^not ok' for the failing test names.`,
  );
}
process.exit(result.status ?? 1);
