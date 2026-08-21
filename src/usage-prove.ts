/**
 * Proof, not claims: run the floor against things it must refuse, here, now.
 *
 * Every other tab in `kit usage` counts what kit recorded. That is evidence of activity, not
 * evidence that the floor still works — a gate can be installed, counted, and broken. So this
 * module does what the test suite does, on the operator's machine, in a throwaway directory:
 * it hands kit inputs that MUST be refused and reports what happened.
 *
 * Why this shape rather than a self-test flag on each gate: a negative control is the only
 * evidence that distinguishes "the check ran and found nothing" from "the check did not run".
 * kit's own history is full of the second reading as the first — a `latest` pin compared against
 * nothing, a lock recording a guessed installer, an unarmed `context-check` passing every push.
 * A control that fails loudly is the cheapest defence against that class.
 *
 * Constraints held deliberately:
 *   - **Offline.** Every control is refused before any registry lookup, so nothing here needs the
 *     network and nothing is charged to a rate limit.
 *   - **Throwaway.** All work happens in a temp dir that is removed afterwards; the operator's
 *     repo, git config and hooks are never touched.
 *   - **Honest failure.** A control that cannot be set up (git missing, no wrapper) reports
 *     `inconclusive` with the reason. It never reports a pass it did not observe.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface Control {
  name: string;
  /** What the floor is supposed to do. */
  expected: string;
  /** What it did. */
  observed: string;
  verdict: "refused" | "allowed" | "inconclusive";
  /** True only when the observed behaviour is the required one. */
  ok: boolean;
}

/** The kit entrypoint to exercise: this build, so the proof is about the installed code. */
function kitEntry(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

function run(
  args: string[],
  opts: { cwd?: string; input?: string } = {},
): { code: number; out: string; stdout: string } {
  const r = spawnSync(process.execPath, [kitEntry(), ...args], {
    cwd: opts.cwd,
    input: opts.input,
    encoding: "utf-8",
    env: { ...process.env, KIT_HIDE_HOOK_SKIP_BANNER: "1", KIT_AUDIT_ANCHOR: "0" },
    timeout: 60_000,
  });
  // stdout is kept separate: node prints an experimental-feature warning on stderr, and a
  // concatenated stream is not parseable JSON — which is exactly how the determinism control
  // first reported "inconclusive" against a check run that had worked perfectly.
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "" };
}

/**
 * Control 1 — the install gate refuses a command it cannot reduce to a triage target.
 *
 * `$PM install evil`: argv0 is an unresolvable variable, so kit cannot know what would run. The
 * required behaviour is exit 2 (the PreToolUse deny contract), refused before any network call.
 */
export function controlUnverifiableInstall(): Control {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "$PM install some-package-that-must-not-install" },
  });
  const r = run(["gate-bash"], { input: payload });
  const refused = r.code === 2 && /BLOCKED/.test(r.out);
  return {
    name: "install gate refuses an unverifiable install",
    expected: "exit 2, BLOCKED — argv0 is a variable, so what runs cannot be verified",
    observed: refused ? `exit ${r.code}, blocked` : `exit ${r.code}, NOT blocked`,
    verdict: refused ? "refused" : "allowed",
    ok: refused,
  };
}

/**
 * Control 2 — the install gate lets a harmless command through.
 *
 * A gate that refuses everything is not a gate, it is an outage. The pair (refuse / allow) is
 * what makes the first control mean anything.
 */
export function controlHarmlessCommandAllowed(): Control {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "git status --short" },
  });
  const r = run(["gate-bash"], { input: payload });
  return {
    name: "and allows a command that installs nothing",
    expected: "exit 0 — no in-scope package install detected",
    observed: `exit ${r.code}`,
    verdict: r.code === 0 ? "allowed" : "refused",
    ok: r.code === 0,
  };
}

/**
 * Control 3 — the pre-commit hook refuses a staged credential, in a throwaway repo.
 *
 * The strongest control available offline: kit installs its own hook into a temp git repo, a fake
 * Stripe test key is staged, and the commit must fail. Then a clean commit must succeed — same
 * pairing as above.
 */
export function controlSecretScanBlocksCommit(): Control[] {
  const name = "pre-commit refuses a staged credential";
  const inconclusive = (why: string): Control[] => [
    {
      name,
      expected: "the commit is blocked",
      observed: `inconclusive: ${why}`,
      verdict: "inconclusive",
      ok: false,
    },
  ];

  const git = (cwd: string, ...args: string[]): { code: number; out: string } => {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 60_000 });
    return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };

  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "kit-prove-"));
    if (spawnSync("git", ["init", "-q", dir]).status !== 0) return inconclusive("git init failed");
    git(dir, "config", "user.email", "prove@kit.local");
    git(dir, "config", "user.name", "kit prove");
    writeFileSync(join(dir, ".kit.toml"), '[tools]\nnode = "22"\n');

    const install = run(["hooks", "add", "secret-scan", "--non-interactive"], { cwd: dir });
    if (install.code !== 0) return inconclusive("could not install the hook");

    // A Stripe TEST key shape: recognised by the scanner, worthless if it ever leaked.
    writeFileSync(join(dir, "leak.ts"), `const k = "sk_test_${"A".repeat(20)}";\n`);
    git(dir, "add", "leak.ts");
    const blocked = git(dir, "commit", "-m", "must be blocked");
    const commits = git(dir, "rev-list", "--count", "HEAD");
    const nothingCommitted = commits.code !== 0 || commits.out.trim() === "0";
    const first: Control = {
      name,
      expected: "commit refused, nothing in history",
      observed:
        blocked.code !== 0 && nothingCommitted
          ? "refused, 0 commits"
          : `commit exit ${blocked.code}, history: ${commits.out.trim() || "?"}`,
      verdict: blocked.code !== 0 && nothingCommitted ? "refused" : "allowed",
      ok: blocked.code !== 0 && nothingCommitted,
    };

    // The other half: a clean commit must still pass, or the hook is just breakage.
    rmSync(join(dir, "leak.ts"), { force: true });
    git(dir, "rm", "-q", "--cached", "leak.ts");
    writeFileSync(join(dir, "ok.ts"), "export const x = 1;\n");
    git(dir, "add", "ok.ts");
    const clean = git(dir, "commit", "-m", "clean");
    const after = git(dir, "rev-list", "--count", "HEAD");
    const second: Control = {
      name: "and lets a clean commit through",
      expected: "commit succeeds",
      observed:
        clean.code === 0 ? `committed (${after.out.trim()})` : `refused: exit ${clean.code}`,
      verdict: clean.code === 0 ? "allowed" : "refused",
      ok: clean.code === 0,
    };

    return [first, second];
  } catch (e) {
    return inconclusive((e as Error).message.slice(0, 60));
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Control 4 — the same input produces the same verdict.
 *
 * Determinism is the reliability claim, so it gets measured rather than asserted: run the
 * security dimension twice and compare the (name → status) sets. An LLM asked "is this safe?"
 * cannot pass this control by construction.
 */
export function controlDeterminism(cwd: string): Control {
  const verdicts = (): Map<string, string> | null => {
    const r = run(["check", "--category", "security", "--json"], { cwd });
    try {
      const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as Record<string, unknown>;
      for (const value of Object.values(parsed)) {
        if (!Array.isArray(value) || value.length === 0) continue;
        const first = value[0] as Record<string, unknown>;
        if (typeof first?.status !== "string") continue;
        return new Map(
          (value as Array<Record<string, unknown>>).map((c) => [
            `${String(c.category)}/${String(c.name)}`,
            String(c.status),
          ]),
        );
      }
    } catch {
      return null;
    }
    return null;
  };

  const a = verdicts();
  const b = a ? verdicts() : null;
  if (!a || !b) {
    return {
      name: "two runs, one verdict set",
      expected: "identical verdicts",
      observed: "inconclusive: could not read a check run",
      verdict: "inconclusive",
      ok: false,
    };
  }
  const same = a.size === b.size && [...a.entries()].every(([k, v]) => b.get(k) === v);
  return {
    name: "two runs, one verdict set",
    expected: `identical verdicts across ${a.size} checks`,
    observed: same ? `identical (${a.size} checks)` : "DIFFERED between runs",
    verdict: same ? "refused" : "allowed", // "refused" == the required outcome held
    ok: same,
  };
}

export interface ProofResult {
  controls: Control[];
  ok: boolean;
  /** Set when the wrapper the hooks resolve through is missing — proof would be meaningless. */
  note?: string;
}

/**
 * Run every control. `deep` adds the determinism control, which spawns two real check runs and
 * therefore costs seconds — opt-in so the default proof stays fast.
 */
export function proveFloor(
  cwd: string = process.cwd(),
  opts: { deep?: boolean } = {},
): ProofResult {
  const controls: Control[] = [
    controlUnverifiableInstall(),
    controlHarmlessCommandAllowed(),
    ...controlSecretScanBlocksCommit(),
  ];
  if (opts.deep) controls.push(controlDeterminism(cwd));

  const wrapper = join(process.env.HOME ?? "", ".kit", "bin", "kit");
  return {
    controls,
    ok: controls.every((c) => c.ok),
    note: existsSync(wrapper)
      ? undefined
      : "no ~/.kit/bin/kit wrapper — hooks on this machine resolve differently than these controls",
  };
}

/** Used by the test to build a temp repo without duplicating the setup. */
export function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-prove-fixture-"));
  mkdirSync(join(dir, ".kit"), { recursive: true });
  return dir;
}
