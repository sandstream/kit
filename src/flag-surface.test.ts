/**
 * The flag floor, driven rather than described.
 *
 * Two command modules validated their flags after #487 and 43 did not (#488). The class is
 * not theoretical: `kit check --category security` ran the FULL check for six majors because
 * nothing rejected the flag, and `kit upgrade --self.` — one trailing period — fell through
 * to the lock-file branch, rewrote every `installedAt`, installed nothing, and printed the
 * success line.
 *
 * The fix is a declared table plus one refusal at dispatch, the same shape as the read-only
 * floor. That design has exactly one failure mode worth testing hard: a table that falls
 * behind the code REJECTS A WORKING FLAG, which is worse than the silence it replaced. So the
 * drift test's oracle is the source scan itself (`scripts/derive-command-flags.mjs`), not a
 * restated list — and the behavioural half spawns the compiled CLI, because a table with no
 * enforcement and enforcement with no table both pass a unit test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { COMMAND_FLAGS, flagsForCommand } from "./flag-surface.js";
import { rejectUnknownFlags, unknownFlags, GLOBAL_FLAGS } from "./utils/flags.js";
import { flagValidationCoverage } from "./self-audit-docs.js";
import { COMMANDS } from "./cli.js";

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CLI_PATH = join(HERE, "cli.js");

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, KIT_HIDE_HOOK_SKIP_BANNER: "1", KIT_AUDIT_ANCHOR: "0" },
      timeout: 60_000,
    });
    return { exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

describe("flag surface — the table covers the live command surface", () => {
  it("every dispatchable verb has an entry, so the floor never skips one", () => {
    const cov = flagValidationCoverage(REPO_ROOT);
    assert.deepEqual(
      cov.missing,
      [],
      `verbs with no allowlist are unvalidated: ${cov.missing.join(", ")}`,
    );
    assert.equal(cov.validating.length, Object.keys(COMMANDS).length);
  });

  it("has no entry for a verb that no longer dispatches (stale rows reject nothing)", () => {
    const stale = Object.keys(COMMAND_FLAGS).filter((v) => !(v in COMMANDS));
    assert.deepEqual(stale, [], `stale flag-surface entries: ${stale.join(", ")}`);
  });

  it("flagsForCommand returns null for an unknown verb rather than an empty allowlist", () => {
    // Null means "skip the floor and report the gap". An empty array would mean "this command
    // accepts no flags at all", which would reject every documented flag it has.
    assert.equal(flagsForCommand("no-such-verb"), null);
    assert.notEqual(flagsForCommand("check"), null);
  });

  it("is in sync with the source scan — a new flag cannot land unlisted", async () => {
    const mod = (await import(
      pathToFileURL(join(REPO_ROOT, "scripts", "derive-command-flags.mjs")).href
    )) as { deriveFlagSurface: (depth?: number) => { surface: Record<string, string[]> } };
    const { surface } = mod.deriveFlagSurface();

    const drift: string[] = [];
    for (const [verb, derived] of Object.entries(surface)) {
      const tabled = new Set(COMMAND_FLAGS[verb] ?? []);
      for (const flag of derived) {
        // GLOBAL_FLAGS are unioned in by the floor, never listed per verb.
        if ((GLOBAL_FLAGS as readonly string[]).includes(flag)) continue;
        if (!tabled.has(flag)) drift.push(`kit ${verb} reads ${flag}, not in the table`);
      }
    }
    assert.deepEqual(
      drift,
      [],
      `${drift.length} flag(s) drifted — run 'node scripts/derive-command-flags.mjs --emit':\n${drift.join("\n")}`,
    );
  });

  it("the documented flags of a sample of commands are all accepted", () => {
    // Under-accepting is the dangerous direction, so spot-check the ones whose omission
    // caused a real outage: --category (six majors of silent full runs) and --attest /
    // --no-auto-install (rejected by the first hand-built CHECK_FLAGS, read one import away).
    for (const flag of ["--category", "--attest", "--no-auto-install", "--json"]) {
      assert.ok(COMMAND_FLAGS.check.includes(flag), `kit check must accept ${flag}`);
    }
    assert.ok(COMMAND_FLAGS.upgrade.includes("--self"));
    for (const flag of ["--only", "--skip", "--exclude"]) {
      // Read through a local `commaList()` helper — a reader-only scan missed all three.
      assert.ok(COMMAND_FLAGS.security.includes(flag), `kit security must accept ${flag}`);
    }
  });
});

describe("rejectUnknownFlags (pure)", () => {
  it("reports nothing and writes nothing when every flag is known", () => {
    const lines: string[] = [];
    const rejected = rejectUnknownFlags("kit x", ["--json"], ["node", "kit", "x", "--json"], (m) =>
      lines.push(m),
    );
    assert.equal(rejected, false);
    assert.deepEqual(lines, []);
  });

  it("names every unknown flag and prints the accepted set once", () => {
    const lines: string[] = [];
    const rejected = rejectUnknownFlags(
      "kit x",
      ["--json", "--json", "--strict"],
      ["node", "kit", "x", "--jsn", "--strct"],
      (m) => lines.push(m),
    );
    assert.equal(rejected, true);
    assert.match(lines[0], /unknown flags for kit x: --jsn, --strct/);
    // Deduped: callers union their list with GLOBAL_FLAGS, which overlap.
    assert.equal(lines[1], "accepted: --json --strict");
  });

  it("leaves pass-through args after `--` alone", () => {
    assert.equal(
      rejectUnknownFlags(
        "kit run",
        ["--env"],
        ["node", "kit", "run", "--", "--not-a-kit-flag"],
        () => {},
      ),
      false,
    );
    assert.deepEqual(unknownFlags(["--", "--anything"], []), []);
  });
});

describe("flag floor — the compiled CLI actually refuses", () => {
  it("rejects an unknown flag with exit 1 and names what is accepted", async () => {
    const r = await runCli(["status", "--bogus-flag"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /unknown flag for kit status: --bogus-flag/);
    assert.match(r.stderr, /accepted: /);
    // The rejection must not corrupt a machine-readable stdout.
    assert.equal(r.stdout.trim(), "");
  });

  it("does not print an accepted list that repeats itself", async () => {
    const r = await runCli(["status", "--bogus-flag"]);
    const accepted = /accepted: (.*)/.exec(r.stderr)?.[1]?.trim().split(/\s+/) ?? [];
    assert.ok(accepted.length > 0);
    assert.deepEqual(accepted, [...new Set(accepted)], "accepted list must be deduped");
  });

  it("still runs a command whose flags are all known", async () => {
    const r = await runCli(["audit", "--limit", "1"]);
    assert.equal(r.exitCode, 0, r.stderr);
  });

  it("still honours a global flag written before the command word", async () => {
    const r = await runCli(["--read-only", "status"]);
    assert.equal(r.exitCode, 0, r.stderr);
  });

  it("catches the typo class that motivated the floor", async () => {
    // `kit upgrade --self.` used to fall through to the lock-file branch and print success.
    const r = await runCli(["upgrade", "--self."]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr + r.stdout, /unknown flag/);
  });

  it("a verb whose module never validated on its own is now covered", async () => {
    // `secrets` is the side-effectful one #488 put first in the suggested order.
    const r = await runCli(["secrets", "--drry-run"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /unknown flag for kit secrets: --drry-run/);
  });
});

/**
 * kit must never PRINT an invocation its own floor rejects.
 *
 * This is where the sweep earned its keep. Two invocations kit printed to users were read by
 * nothing: `kit add --list` (in the help table AND in the command's one-line help) took the
 * flag as the service NAME, so the documented command printed "Provisioning --list…" and then
 * "Unknown service: --list"; and `kit setup --activate-mise` named a flag no code reads at all.
 * Before the floor both were silent; after it they would have become rejections of kit's own
 * documented advice, which is worse. So the invariant is pinned.
 *
 * Scope is deliberately string literals in `src/**` plus the CI workflows — the text kit prints,
 * generates or runs. Comments are excluded: prose ABOUT a wrong invocation ("`kit check
 * --profile` used to pass") is correct writing, and the docs-claims rules already cover docs.
 */
describe("flag floor — kit never prints an invocation it would reject", () => {
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

  /** Contents of every string / template literal, with `${…}` holes removed. */
  function stringLiterals(text: string): string[] {
    const out: string[] = [];
    for (const re of [/"([^"\n]*)"/g, /'([^'\n]*)'/g, /`([^`]*)`/gs]) {
      for (const m of text.matchAll(re)) out.push(m[1].replace(/\$\{[^}]*\}/g, " "));
    }
    return out;
  }

  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!["node_modules", "dist", ".git"].includes(e.name)) sourceFiles(p, acc);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) acc.push(p);
    }
    return acc;
  }

  it("every `kit <verb> --flag` kit itself emits is accepted", () => {
    const files = sourceFiles(join(REPO_ROOT, "src"));
    for (const f of readdirSync(join(REPO_ROOT, ".github", "workflows"))) {
      if (f.endsWith(".yml")) files.push(join(REPO_ROOT, ".github", "workflows", f));
    }

    const rejected: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      const haystacks = file.endsWith(".ts") ? stringLiterals(stripComments(text)) : [text];
      for (const hay of haystacks) {
        for (const m of hay.matchAll(/\bkit\s+([a-z][a-z0-9-]*)((?:\s+--[a-z][a-z0-9-]*)+)/g)) {
          const verb = m[1];
          const allowed = flagsForCommand(verb);
          if (allowed === null) continue;
          const tokens = m[2].trim().split(/\s+/);
          const bad = unknownFlags(tokens, [...allowed, ...GLOBAL_FLAGS]);
          if (bad.length > 0) {
            rejected.push(`${file.slice(REPO_ROOT.length + 1)}: kit ${verb} ${bad.join(" ")}`);
          }
        }
      }
    }
    assert.deepEqual(
      rejected,
      [],
      `kit prints ${rejected.length} invocation(s) its own floor rejects:\n${rejected.join("\n")}`,
    );
  });

  it("kit add --list lists the adapters and exits 0", async () => {
    // The measured defect: argv[3] took `--list` as the service name.
    const r = await runCli(["add", "--list"]);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /Available services:/);
    assert.doesNotMatch(r.stdout, /Provisioning --list/);
    assert.doesNotMatch(r.stdout + r.stderr, /Unknown service/);
  });

  it("bare kit add still exits 1 — a forgotten argument is not a completed provision", async () => {
    const r = await runCli(["add"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /Available services:/);
  });
});
