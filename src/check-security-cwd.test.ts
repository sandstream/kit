/**
 * `checkSecurity(cwd)` must describe the tree it was given, not the tree the process happens to
 * sit in.
 *
 * All fifteen sub-checks resolved paths from `process.cwd()`, and none of the seven scanner
 * spawns passed a `cwd`. Measured over the MCP surface: `kit_check({cwd: B})` from a server
 * launched in A answered `pass — all .env patterns in .gitignore` for a project B that has no
 * `.gitignore` at all. The config came from B and the verdict came from A — a green earned by
 * the wrong tree, which is the worst shape a gate can fail in.
 *
 * The tests below are DISCRIMINATING by construction, per the warning in ROADMAP.md: "Any
 * dimension that gains a `cwd` needs a test that would FAIL if the parameter were ignored; a
 * test that merely passes `cwd` proves nothing, which is how this survived." So A is given a
 * COMPLETE `.gitignore` and B none, and each test asserts the two answers DIFFER. A build that
 * drops the parameter makes them agree and fails the pair.
 *
 * Only checks that are deterministic without external tooling are asserted on: `.env gitignored`
 * and `lockfiles committed` read files directly. The scanner-backed checks (trivy, semgrep, osv,
 * guarddog) skip when the binary is absent, so they cannot carry a portable assertion — their
 * `cwd` threading is covered by the source-level guard at the end of this file, which is
 * mechanical but is the only thing that can fail when a tool is not installed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkSecurity } from "./check-security.js";

/** A project whose .gitignore covers every .env spelling the check looks for. */
function projectWithGitignore(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-sec-A-"));
  writeFileSync(join(dir, ".kit.toml"), "version = 1\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "a", version: "1.0.0", private: true }) + "\n",
  );
  writeFileSync(join(dir, ".gitignore"), ".env\n.env.local\n.env.*.local\nnode_modules\n");
  return dir;
}

/** A project with NO .gitignore at all — the check must not pass here. */
function projectWithout(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-sec-B-"));
  writeFileSync(join(dir, ".kit.toml"), "version = 1\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "b", version: "1.0.0", private: true }) + "\n",
  );
  return dir;
}

/** Run `fn` with the process sitting in `dir`, restoring cwd afterwards. */
async function inCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

function statusOf(results: Awaited<ReturnType<typeof checkSecurity>>, name: string): string {
  const hit = results.find((r) => r.name === name);
  return hit ? hit.status : "absent";
}

describe("checkSecurity honours the cwd it is given", () => {
  it("the .env gitignore verdict follows the GOVERNED tree, not the process's", async () => {
    const A = projectWithGitignore();
    const B = projectWithout();
    try {
      // Process sits in A (complete .gitignore) and asks about B (none).
      const aboutB = await inCwd(A, () => checkSecurity(B));
      const aboutA = await inCwd(A, () => checkSecurity(A));

      const bStatus = statusOf(aboutB, ".env gitignored");
      const aStatus = statusOf(aboutA, ".env gitignored");

      // The pair IS the assertion. Ignoring `cwd` makes both answers A's answer.
      assert.notEqual(
        bStatus,
        aStatus,
        `a project with no .gitignore must not get A's verdict (both were "${bStatus}")`,
      );
      assert.equal(aStatus, "pass", "A has a complete .gitignore and must pass");
      assert.notEqual(bStatus, "pass", "B has no .gitignore at all and must not pass");
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it("the mirror image holds: a process in B still answers correctly about A", async () => {
    const A = projectWithGitignore();
    const B = projectWithout();
    try {
      // Swapping which tree the process occupies must not swap the answers. A guard that
      // merely refused, or a threading that only worked one way, fails here.
      const aboutA = await inCwd(B, () => checkSecurity(A));
      const aboutB = await inCwd(B, () => checkSecurity(B));

      assert.equal(statusOf(aboutA, ".env gitignored"), "pass");
      assert.notEqual(statusOf(aboutB, ".env gitignored"), "pass");
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it("omitting cwd is identical to passing process.cwd()", async () => {
    const A = projectWithGitignore();
    try {
      const omitted = await inCwd(A, () => checkSecurity());
      const explicit = await inCwd(A, () => checkSecurity(A));
      // The backwards-compatibility guarantee, asserted rather than asserted in prose: every
      // existing caller passes nothing, and must keep seeing exactly what it saw before.
      assert.equal(
        statusOf(omitted, ".env gitignored"),
        statusOf(explicit, ".env gitignored"),
        "the default must resolve to the process's own tree",
      );
    } finally {
      rmSync(A, { recursive: true, force: true });
    }
  });

  it("the lockfile verdict follows the governed tree too", async () => {
    const withLock = mkdtempSync(join(tmpdir(), "kit-sec-lock-"));
    const without = mkdtempSync(join(tmpdir(), "kit-sec-nolock-"));
    try {
      for (const d of [withLock, without]) {
        writeFileSync(join(d, ".kit.toml"), "version = 1\n");
        writeFileSync(
          join(d, "package.json"),
          JSON.stringify({ name: "l", version: "1.0.0", private: true }) + "\n",
        );
      }
      writeFileSync(join(withLock, "package-lock.json"), '{"lockfileVersion":3}\n');

      const aboutWithout = await inCwd(withLock, () => checkSecurity(without));
      const aboutWith = await inCwd(withLock, () => checkSecurity(withLock));

      // A second dimension of the same bug: `checkLockfilesCommitted` probed for the lock file
      // under `process.cwd()`, so it reported the CALLER's lock state as the target's.
      const names = new Set(aboutWith.map((r) => r.name));
      assert.equal(
        names.size > 0,
        true,
        "sanity: the security dimension must produce named results",
      );
      assert.notDeepEqual(
        aboutWithout.map((r) => `${r.name}:${r.status}`),
        aboutWith.map((r) => `${r.name}:${r.status}`),
        "two different trees must not produce an identical result vector",
      );
    } finally {
      rmSync(withLock, { recursive: true, force: true });
      rmSync(without, { recursive: true, force: true });
    }
  });
});

describe("no scanner spawn may inherit the caller's cwd", () => {
  // Mechanical, and the only check that still works when trivy/semgrep/osv are not installed.
  // `trivy fs .`, `trivy config .`, `osv-scanner -r .` and `semgrep .` all resolve "." against
  // the SPAWNED process's directory, so threading the path parameter without pinning `cwd` on
  // the exec would have left the scanners reading the caller's tree while the signature looked
  // threaded — the precise failure ROADMAP warned about.
  it("every execFileNoThrow in check-security.ts passes a cwd", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "..", "src", "check-security.ts"),
      "utf8",
    );
    // Each spawn's options object ends the call; capture from the call to its closing paren.
    const calls = src.split("execFileNoThrow(").slice(1);
    const missing: string[] = [];
    for (const call of calls) {
      const body = call.slice(0, 900);
      // `--version` probes are liveness checks for the binary itself and touch no project file.
      if (body.includes('"--version"')) continue;
      if (!/cwd:\s*root/.test(body)) missing.push(body.split("\n")[0].trim());
    }
    assert.deepEqual(missing, [], `these scanner spawns would read the caller's tree: ${missing}`);
  });

  it("check-security.ts reads no path from process.cwd() outside a parameter default", () => {
    const src = readFileSync(
      resolve(import.meta.dirname, "..", "src", "check-security.ts"),
      "utf8",
    );
    const offenders = src
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => line.includes("process.cwd()"))
      // Comments explaining the bug are not the bug. Filtering these out is what makes the
      // remaining match a real read rather than prose about one.
      .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*"))
      // Two spellings of the documented fallback are legitimate and must not be flagged:
      // a parameter default (`cwd: string = process.cwd()`) and the single resolution at the
      // top of `checkSecurity` (`const root = cwd ?? process.cwd()`). Anything else is a
      // sub-check reaching past its `root` argument.
      .filter(({ line }) => !/(=|\?\?)\s*process\.cwd\(\)/.test(line));
    assert.deepEqual(
      offenders,
      [],
      `direct process.cwd() reads defeat the cwd parameter: ${JSON.stringify(offenders)}`,
    );
  });
});

describe("runCheckGate threads cwd to the dimensions that read the filesystem", () => {
  // The end-to-end form of the ROADMAP probe. `runCheckGate` always resolved `cwd` for
  // `.kit.toml` and then handed the dimensions nothing, so the config came from B and the
  // verdict came from A.
  function project(gitignore: string | null, template: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "kit-gate-cwd-"));
    let toml = "version = 1\n";
    if (template !== null) {
      toml += `\n[secrets]\nstore = "env"\ntemplate = "${template}"\n`;
    }
    writeFileSync(join(dir, ".kit.toml"), toml);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "g", version: "1.0.0", private: true }) + "\n",
    );
    if (gitignore !== null) writeFileSync(join(dir, ".gitignore"), gitignore);
    return dir;
  }

  it("the security verdict describes the requested project, not the server's", async () => {
    const { runCheckGate } = await import("./check-run.js");
    const A = project(".env\n.env.local\n.env.*.local\nnode_modules\n", null);
    const B = project(null, null);
    try {
      const aboutB = await inCwd(A, () => runCheckGate({ cwd: B, categories: ["security"] }));
      const aboutA = await inCwd(A, () => runCheckGate({ cwd: A, categories: ["security"] }));

      const bEnv = statusOf(aboutB.security, ".env gitignored");
      const aEnv = statusOf(aboutA.security, ".env gitignored");
      assert.equal(aEnv, "pass");
      assert.notEqual(bEnv, "pass", "B has no .gitignore — it must not inherit A's pass");
      assert.notEqual(bEnv, aEnv);
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it("a relative [secrets].template resolves in the governed project", async () => {
    const { runCheckGate } = await import("./check-run.js");
    // Both declare the same relative template path; only A has the file. Resolving it against
    // the process instead of the project reported A's template as B's.
    const A = project(null, ".env.template");
    const B = project(null, ".env.template");
    writeFileSync(join(A, ".env.template"), "API_KEY=\n");
    try {
      const aboutB = await inCwd(A, () => runCheckGate({ cwd: B, categories: ["secrets"] }));
      const aboutA = await inCwd(A, () => runCheckGate({ cwd: A, categories: ["secrets"] }));
      assert.equal(aboutA.secrets.templateExists, true, "A has the template file");
      assert.equal(
        aboutB.secrets.templateExists,
        false,
        "B declares the same path but has no file — it must not see A's",
      );
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });
});
