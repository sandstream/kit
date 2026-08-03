/**
 * `kit fix` must write into the project it was asked to fix.
 *
 * `cmdFix` took no `cwd` at all: it loaded `.kit.toml` from `process.cwd()`, appended to the
 * `process.cwd()` `.gitignore`, resolved `[secrets].template` against the process, and — the
 * sharpest part — `lock.ts` had the asymmetry backwards. Its READ helpers (`readSkillsLock`,
 * `readCliLock`, `readkitMeta`) all took a `cwd`; its WRITE helpers (`writeSkillsLock`,
 * `writeCliLock`, `writekitMeta`, `ensurekitDir`) did not. So a caller with a project directory
 * of its own read that project's locks and then wrote the calling process's. That is the ROADMAP
 * symptom verbatim: "`kit_fix` was worse — it created B's lock files inside A."
 *
 * Each test below asserts on WHERE THE BYTES LANDED, in both trees, because "did it write
 * something" passes just as well when it wrote to the wrong place. The negative half — nothing
 * appeared in the process's own tree — is the half that fails when the parameter is dropped.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdFix } from "./fix.js";

/** A minimal project: no tools/services/skills/hooks, so fix only writes locks + files. */
function project(extra = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-fix-cwd-"));
  writeFileSync(join(dir, ".kit.toml"), `version = 1\n${extra}`);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "f", version: "1.0.0", private: true }) + "\n",
  );
  return dir;
}

/** Run with the process in `dir` and an isolated identity dir, restoring both. */
async function inCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prevCwd = process.cwd();
  const prevId = process.env.KIT_IDENTITY_DIR;
  const idDir = mkdtempSync(join(tmpdir(), "kit-fix-id-"));
  // Never let a probe mint or touch the real ~/.kit identity key.
  process.env.KIT_IDENTITY_DIR = idDir;
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prevCwd);
    if (prevId === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = prevId;
    rmSync(idDir, { recursive: true, force: true });
  }
}

describe("cmdFix writes into the project it was given", () => {
  it("lock files land in the governed tree and NOT in the process's", async () => {
    const A = project();
    const B = project();
    try {
      await inCwd(A, () => cmdFix(B));

      // Positive half: B got its locks.
      assert.equal(
        existsSync(join(B, ".kit", "skills-lock.json")),
        true,
        "B was the target and must have its skills lock",
      );
      assert.equal(existsSync(join(B, ".kit", "cli-lock.json")), true, "B must have its CLI lock");

      // Negative half: this is what fails when the parameter is dropped. Before the fix the
      // reads honoured `cwd` and the writes did not, so the bytes landed here instead.
      assert.equal(
        existsSync(join(A, ".kit", "skills-lock.json")),
        false,
        "A only hosted the process — it must not have gained B's skills lock",
      );
      assert.equal(
        existsSync(join(A, ".kit", "cli-lock.json")),
        false,
        "A must not have gained B's CLI lock",
      );
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it(".gitignore hardening edits the governed tree's file", async () => {
    const A = project();
    const B = project();
    try {
      // Both start with the same content, so the only way to tell them apart afterwards is
      // which one grew.
      writeFileSync(join(A, ".gitignore"), "node_modules\n");
      writeFileSync(join(B, ".gitignore"), "node_modules\n");

      await inCwd(A, () => cmdFix(B));

      const aAfter = readFileSync(join(A, ".gitignore"), "utf-8");
      const bAfter = readFileSync(join(B, ".gitignore"), "utf-8");
      assert.equal(aAfter, "node_modules\n", "A's .gitignore must be untouched");
      assert.notEqual(bAfter, "node_modules\n", "B's .gitignore must have been hardened");
      assert.match(bAfter, /\.env/, "B's .gitignore must have gained the .env patterns");
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it("a relative [secrets].template is created in the governed tree", async () => {
    const secrets =
      '\n[secrets]\nstore = "env"\ntemplate = ".env.template"\n\n[secrets.keys.API_KEY]\nsource = "env"\n';
    const A = project(secrets);
    const B = project(secrets);
    try {
      await inCwd(A, () => cmdFix(B));

      assert.equal(
        existsSync(join(B, ".env.template")),
        true,
        "B declared the template and must have it created",
      );
      assert.equal(
        existsSync(join(A, ".env.template")),
        false,
        "A must not have gained a template generated for B",
      );
      assert.match(readFileSync(join(B, ".env.template"), "utf-8"), /API_KEY=/);
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it("an existing template in the PROCESS's tree is not mistaken for the target's", async () => {
    const secrets =
      '\n[secrets]\nstore = "env"\ntemplate = ".env.template"\n\n[secrets.keys.API_KEY]\nsource = "env"\n';
    const A = project(secrets);
    const B = project(secrets);
    try {
      // A has the file; B does not. Probing the path against the process would report
      // "Template .env.template exists" and skip generating B's — a silent no-op fix.
      writeFileSync(join(A, ".env.template"), "SOMETHING_ELSE=\n");

      await inCwd(A, () => cmdFix(B));

      assert.equal(existsSync(join(B, ".env.template")), true, "B's template must be generated");
      assert.match(readFileSync(join(B, ".env.template"), "utf-8"), /API_KEY=/);
      assert.equal(
        readFileSync(join(A, ".env.template"), "utf-8"),
        "SOMETHING_ELSE=\n",
        "A's template must be left exactly as it was",
      );
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it("omitting cwd still fixes the process's own tree", async () => {
    const A = project();
    try {
      // The backwards-compatibility guarantee: every existing caller passes nothing.
      await inCwd(A, () => cmdFix());
      assert.equal(
        existsSync(join(A, ".kit", "skills-lock.json")),
        true,
        "the default must resolve to the process's own tree",
      );
    } finally {
      rmSync(A, { recursive: true, force: true });
    }
  });

  it("an existing lock in the process's tree does not suppress the target's", async () => {
    const A = project();
    const B = project();
    try {
      // A is already fixed; B is not. If the READ honoured cwd but the WRITE did not — the
      // original asymmetry — this is the case that silently did nothing at all.
      mkdirSync(join(A, ".kit"), { recursive: true });
      writeFileSync(join(A, ".kit", "skills-lock.json"), '{"version":1,"skills":{}}\n');
      writeFileSync(join(A, ".kit", "cli-lock.json"), '{"version":1,"tools":{}}\n');

      await inCwd(A, () => cmdFix(B));

      assert.equal(existsSync(join(B, ".kit", "skills-lock.json")), true);
      assert.equal(
        readFileSync(join(A, ".kit", "skills-lock.json"), "utf-8"),
        '{"version":1,"skills":{}}\n',
        "A's pre-existing lock must not be rewritten by a fix aimed at B",
      );
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });
});

describe("a governed operation files its evidence in the governed tree", () => {
  // `withGovernance` took no `cwd` and `logAuditEvent` resolved `.kit-audit.jsonl` against
  // `process.cwd()`, so a fix performed FOR B recorded its proof in A. That is not cosmetic:
  // `exec-broker/broker.ts`'s own `audit()` docstring says foreign-project records pollute the
  // host repo's chain and poison `kit broker enforce-readiness`, "whose verdict is only as honest
  // as the evidence file it reads". It was the last thing keeping the MCP cross-project refusal
  // in place for `kit_fix`.
  function governedProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "kit-audit-cwd-"));
    writeFileSync(
      join(dir, ".kit.toml"),
      "version = 1\n\n[governance]\nenabled = true\n\n[governance.audit]\nenabled = true\n",
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "ga", version: "1.0.0", private: true }) + "\n",
    );
    return dir;
  }

  it("the audit line lands in B's chain and not in A's", async () => {
    const A = governedProject();
    const B = governedProject();
    try {
      await inCwd(A, () => cmdFix(B));

      const bLog = join(B, ".kit-audit.jsonl");
      const aLog = join(A, ".kit-audit.jsonl");

      assert.equal(existsSync(bLog), true, "the governed project must carry the fix's evidence");
      assert.match(
        readFileSync(bLog, "utf-8"),
        /"operation":\s*"fix"/,
        "B's chain must contain the fix operation",
      );
      // The half that fails when the parameter is dropped: A merely hosted the process.
      assert.equal(
        existsSync(aLog),
        false,
        "A must not have gained an audit entry for an operation performed on B",
      );
    } finally {
      rmSync(A, { recursive: true, force: true });
      rmSync(B, { recursive: true, force: true });
    }
  });

  it("omitting cwd still audits in the process's own tree", async () => {
    const A = governedProject();
    try {
      await inCwd(A, () => cmdFix());
      assert.equal(
        existsSync(join(A, ".kit-audit.jsonl")),
        true,
        "the default must keep filing evidence where it always did",
      );
    } finally {
      rmSync(A, { recursive: true, force: true });
    }
  });
});
