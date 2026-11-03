// Pure helpers for scripts/prepush.mjs, kept apart so they can be tested without running a build.

/** Declared packages whose installed version differs from package-lock.json. */
export function versionMismatches(pkg, lock, installed) {
  const names = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const out = [];
  for (const name of [...names].sort()) {
    const locked = lock.packages?.[`node_modules/${name}`]?.version;
    if (!locked) continue; // a local or workspace package the lockfile does not version
    const have = installed(name);
    if (have !== locked) out.push({ name, installed: have, locked });
  }
  return out;
}

/** Compiled tests to run for the changed files: each changed source's own test, or the test itself. */
export function testsForChanged(changed, exists) {
  const out = [];
  for (const file of changed) {
    const m = /^src\/(.+)\.ts$/.exec(file.split("\\").join("/"));
    if (!m || m[1].endsWith(".test-support") || m[1].endsWith(".d")) continue;
    const base = m[1].endsWith(".test") ? m[1].slice(0, -".test".length) : m[1];
    const test = `dist/${base}.test.js`;
    if (exists(test) && !out.includes(test)) out.push(test);
  }
  return out;
}

/** Failing findings in a `kit review --json` report, minus the checks named as known. Exact names only. */
export function failedChecks(report, allow) {
  const known = new Set(allow);
  const out = [];
  for (const stage of report.stages ?? []) {
    for (const f of stage.findings ?? []) {
      if (f.status === "fail" && !known.has(f.name)) {
        out.push({ stage: stage.stage, name: f.name, detail: f.detail ?? "" });
      }
    }
  }
  return out;
}

export function parseArgs(argv) {
  const out = { allow: [], strict: false, skip: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--strict") out.strict = true;
    else if (argv[i] === "--allow" && argv[i + 1] !== undefined) out.allow.push(argv[++i]);
    else if (argv[i] === "--skip" && argv[i + 1] !== undefined) out.skip.push(argv[++i]);
  }
  return out;
}

/** CLAUDE.md forbids a session URL in public PR text. */
export function sessionUrlIn(text) {
  return /claude\.ai\/code\/session_/.test(text);
}

/** The report in `kit review --json` output, which may carry a banner before it and warnings after it. */
export function parseReviewJson(text) {
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from < 0 || to < from) return undefined;
  try {
    return JSON.parse(text.slice(from, to + 1));
  } catch {
    return undefined;
  }
}

/** The Semgrep version CI installs, read from the workflow so the local run cannot drift from it. */
export function pinnedSemgrepVersion(workflow) {
  return /semgrep==(\d+\.\d+\.\d+)/.exec(workflow)?.[1];
}

/** The rule packs CI scans with, read from the `for config in ...; do` loop of the workflow. */
export function semgrepPacks(workflow) {
  const m = /for config in ([^;]+); do/.exec(workflow);
  return m ? m[1].trim().split(/\s+/) : [];
}

/** The version in `semgrep --version` output, which may carry an update banner before it. */
export function semgrepVersionFrom(output) {
  const lines = output.split("\n").map((l) => l.trim());
  return lines.reverse().find((l) => /^\d+\.\d+\.\d+$/.test(l));
}

const ANSI = /\u001b\[[0-9;]*m/g;

/** The files listed under the unit-test coverage row of `kit check --category tests` output. */
export function untestedFiles(output) {
  const out = [];
  let inRow = false;
  for (const line of output.replace(ANSI, "").split("\n")) {
    if (line.includes("unit-test coverage")) {
      inRow = true;
      continue;
    }
    if (!inRow) continue;
    const m = /^\s*-\s+(\S+)\s*$/.exec(line);
    if (m) out.push(m[1]);
    else inRow = false;
  }
  return out;
}
