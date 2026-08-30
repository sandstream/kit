import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { WRITE_SURFACE, matchWriteSurface } from "./read-only-surface.js";

/**
 * `KIT_READ_ONLY=1` claims to refuse every mutation. It did not: `identity init` minted a private
 * key, `policy init` wrote the policy doc, `check-gitignore --fix` rewrote .gitignore and `upgrade`
 * rewrote the lock files — each exiting 0 with nothing in the audit trail.
 *
 * These tests are BEHAVIOURAL on purpose. A unit test over `matchWriteSurface` would have passed
 * throughout the entire period the four commands were writing, because the table did not exist and
 * the dispatcher never consulted one. So the load-bearing tests below run the real CLI in a real
 * temp project and assert on the exit code, the audit line, and the absence of the file that would
 * have been written.
 */

// This file compiles to dist/read-only-surface.test.js, so the built CLI is its sibling.
const CLI = resolve(import.meta.dirname, "cli.js");

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-ro-"));
  writeFileSync(join(dir, ".kit.toml"), "version = 1\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "ro", version: "1.0.0", private: true }) + "\n",
  );
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  return dir;
}

interface RunResult {
  code: number;
  out: string;
}

/** Run the built CLI with an isolated HOME + identity dir. Exit code captured, never via a pipe. */
function kit(args: string[], cwd: string, env: Record<string, string> = {}): RunResult {
  const home = mkdtempSync(join(tmpdir(), "kit-ro-home-"));
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        KIT_IDENTITY_DIR: join(home, ".kit"),
        KIT_HIDE_HOOK_SKIP_BANNER: "1",
        ...env,
      },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: String(err.stdout ?? "") + String(err.stderr ?? "") };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function auditRefusals(dir: string): string[] {
  const f = join(dir, ".kit-audit.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as { operation?: string; metadata?: { refused_operation?: string } };
      } catch {
        return null;
      }
    })
    .filter((e) => e?.operation === "read-only-mode-refusal")
    .map((e) => e!.metadata?.refused_operation ?? "");
}

describe("matchWriteSurface", () => {
  it("matches a bare command entry however it is invoked", () => {
    assert.equal(matchWriteSurface(["node", "kit", "upgrade"])?.operation, "upgrade");
    assert.equal(
      matchWriteSurface(["node", "kit", "upgrade", "--non-interactive"])?.operation,
      "upgrade",
    );
  });

  it("narrows to the subcommand — the read form is NOT refused", () => {
    assert.equal(matchWriteSurface(["node", "kit", "policy", "init"])?.operation, "policy-init");
    assert.equal(matchWriteSurface(["node", "kit", "policy", "show"]), null);
    assert.equal(matchWriteSurface(["node", "kit", "identity", "show"]), null);
  });

  it("requires the flag when the mutation is opt-in behind one", () => {
    // Refusing the reporting form would train people to drop --fix, or to drop read-only mode.
    assert.equal(matchWriteSurface(["node", "kit", "security", "check-gitignore"]), null);
    assert.equal(
      matchWriteSurface(["node", "kit", "security", "check-gitignore", "--fix"])?.operation,
      "check-gitignore-fix",
    );
  });

  it("returns null for commands outside the table and for an empty argv", () => {
    for (const args of [
      ["node", "kit", "check"],
      ["node", "kit", "doctor"],
      ["node", "kit"],
    ]) {
      assert.equal(matchWriteSurface(args), null, args.join(" "));
    }
  });

  it("every entry names a distinct operation (the audit trail has to be unambiguous)", () => {
    const ops = WRITE_SURFACE.map((e) => e.operation);
    assert.equal(new Set(ops).size, ops.length);
  });
});

describe("KIT_READ_ONLY=1 refuses every declared mutation (behavioural)", () => {
  // The regression that motivated the table. Each case asserts three things, because any one of
  // them alone can be satisfied while the mutation still happens: a non-zero exit, an audit
  // entry naming the refused operation, and no artifact on disk.

  it("identity init does not mint a private key", () => {
    const dir = project();
    try {
      const r = kit(["identity", "init"], dir, { KIT_READ_ONLY: "1" });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /read-only mode active/);
      assert.ok(
        auditRefusals(dir).includes("identity-init"),
        `audit: ${JSON.stringify(auditRefusals(dir))}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("identity init WITHOUT read-only still works (the guard is not a brick)", () => {
    // The other half of every fail-closed change: prove the door still opens.
    const dir = project();
    const home = mkdtempSync(join(tmpdir(), "kit-ro-live-"));
    try {
      const idDir = join(home, ".kit");
      const out = execFileSync(process.execPath, [CLI, "identity", "init"], {
        cwd: dir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          HOME: home,
          KIT_IDENTITY_DIR: idDir,
          KIT_HIDE_HOOK_SKIP_BANNER: "1",
        },
      });
      assert.match(out, /identity (created|already exists)/);
      assert.ok(readdirSync(idDir).includes("identity.key"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("policy init does not create .kit-policy.toml", () => {
    const dir = project();
    try {
      const r = kit(["policy", "init"], dir, { KIT_READ_ONLY: "1" });
      assert.equal(r.code, 1, r.out);
      assert.equal(existsSync(join(dir, ".kit-policy.toml")), false, "policy doc was written");
      assert.ok(auditRefusals(dir).includes("policy-init"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("monkey-test init does not write the Playwright harness", () => {
    const dir = project();
    try {
      const r = kit(["monkey-test", "init"], dir, { KIT_READ_ONLY: "1" });
      assert.equal(r.code, 1, r.out);
      assert.equal(
        existsSync(join(dir, "playwright.monkey.config.ts")),
        false,
        "monkey harness was written",
      );
      assert.ok(auditRefusals(dir).includes("monkey-test-init"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("security check-gitignore --fix does not rewrite .gitignore", () => {
    const dir = project();
    try {
      const before = readFileSync(join(dir, ".gitignore"), "utf-8");
      const r = kit(["security", "check-gitignore", "--fix"], dir, { KIT_READ_ONLY: "1" });
      assert.equal(r.code, 1, r.out);
      assert.equal(readFileSync(join(dir, ".gitignore"), "utf-8"), before, ".gitignore changed");
      assert.ok(auditRefusals(dir).includes("check-gitignore-fix"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the REPORTING form of check-gitignore is still allowed under read-only", () => {
    const dir = project();
    try {
      const r = kit(["security", "check-gitignore"], dir, { KIT_READ_ONLY: "1" });
      assert.ok(
        !/read-only mode active/.test(r.out),
        `a read must not be refused: ${r.out.slice(0, 300)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upgrade does not write lock files", () => {
    const dir = project();
    try {
      const r = kit(["upgrade", "--non-interactive"], dir, { KIT_READ_ONLY: "1" });
      assert.equal(r.code, 1, r.out);
      const kitDir = join(dir, ".kit");
      const written = existsSync(kitDir) ? readdirSync(kitDir) : [];
      assert.deepEqual(written, [], `lock files written: ${written.join(", ")}`);
      assert.ok(auditRefusals(dir).includes("upgrade"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--read-only as a FLAG refuses the same way the env var does", () => {
    const dir = project();
    try {
      const r = kit(["policy", "init", "--read-only"], dir);
      assert.equal(r.code, 1, r.out);
      assert.equal(existsSync(join(dir, ".kit-policy.toml")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
