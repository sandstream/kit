/**
 * The aggregation behind `kit usage`, and specifically its failure modes.
 *
 * The property that matters here is that **unknown is never zero**. A store without token columns,
 * a repo without a saved run, a log with no `cwd` — each must read as "not known", never as a
 * clean zero or an old date. Every false-green in kit's own history (#500, #503, #517) was a
 * missing value rendered as a good one, so the fixtures below are all shaped around absence.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import {
  standardsFromRuns,
  keysFromConfigAndRun,
  coverageFromRuns,
  floorFromLogs,
  triageFromLog,
  machineFromAnchor,
  memoryFromDb,
} from "./usage-report.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "kit-usage-test-"));
}

describe("coverageFromRuns", () => {
  it("counts every dimension in the run, and keeps the reason a check could not run", () => {
    const dir = scratch();
    try {
      mkdirSync(join(dir, ".kit", "runs"), { recursive: true });
      // Two runs: only the newest may be read, and both dimensions must be counted.
      writeFileSync(
        join(dir, ".kit", "runs", "check-1000.json"),
        JSON.stringify({ checks: [{ name: "old", status: "fail", category: "x" }] }),
      );
      writeFileSync(
        join(dir, ".kit", "runs", "check-2000.json"),
        JSON.stringify({
          checks: [
            { name: "a", status: "pass", category: "sec" },
            { name: "b", status: "warn", category: "sec" },
            { name: "c", status: "skip", category: "sec", detail: "no requirements.txt" },
          ],
          // A dimension this code has never heard of still counts — the point of walking every
          // array rather than naming the groups.
          somethingNew: [{ name: "d", status: "skip", detail: "cloud-only, excluded by design" }],
          ok: true,
        }),
      );

      const cv = coverageFromRuns(dir);
      assert.equal(cv.enumerated, 4, "the newest run only, but all of its dimensions");
      assert.equal(cv.pass, 1);
      assert.equal(cv.warn, 1);
      assert.equal(cv.fail, 0, "the older run's failure must not leak in");
      assert.deepEqual(
        cv.couldNotRun.map((r) => r.reason),
        ["no requirements.txt", "cloud-only, excluded by design"],
        "a skip carries its reason or it is indistinguishable from a pass",
      );
      assert.equal(cv.at, new Date(2000).toISOString());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports nothing rather than zero when no run has been saved", () => {
    const dir = scratch();
    try {
      const cv = coverageFromRuns(dir);
      assert.equal(cv.enumerated, 0);
      assert.equal(cv.at, null, "no run means no timestamp — not the epoch");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("floorFromLogs", () => {
  it("says so when the log cannot tell operator activity from test activity", () => {
    const dir = scratch();
    try {
      writeFileSync(
        join(dir, ".kit-audit.jsonl"),
        [
          JSON.stringify({ operation: "policy-check", success: false }),
          JSON.stringify({ operation: "policy-check", success: false }),
          JSON.stringify({ operation: "elevation-check", success: false }),
          JSON.stringify({ operation: "policy-check", success: true }),
          "{ not json",
        ].join("\n"),
      );
      const fl = floorFromLogs(dir);
      assert.equal(fl.events, 4, "an unparseable line is dropped, not counted");
      assert.equal(fl.refusals, 3);
      assert.deepEqual(fl.byOperation[0], ["policy-check", 2]);
      assert.equal(fl.actorUnknown, true, "no entry carries a cwd");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not claim the actor is unknown once any entry carries one", () => {
    const dir = scratch();
    try {
      writeFileSync(
        join(dir, ".kit-audit.jsonl"),
        [
          JSON.stringify({ operation: "policy-check", success: false }),
          JSON.stringify({ operation: "policy-check", success: false, cwd: "/repo" }),
        ].join("\n"),
      );
      assert.equal(floorFromLogs(dir).actorUnknown, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an empty repo is not an unknown actor — there is simply nothing to attribute", () => {
    const dir = scratch();
    try {
      const fl = floorFromLogs(dir);
      assert.equal(fl.events, 0);
      assert.equal(fl.actorUnknown, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("triageFromLog and machineFromAnchor", () => {
  it("counts triage runs per ecosystem and keeps the latest target", () => {
    const dir = scratch();
    try {
      writeFileSync(
        join(dir, ".kit-triage.jsonl"),
        [
          JSON.stringify({ type: "npm", target: "left-pad" }),
          JSON.stringify({ type: "npm", target: "zod" }),
          JSON.stringify({ type: "pip", target: "requests" }),
        ].join("\n"),
      );
      const t = triageFromLog(dir);
      assert.equal(t.runs, 3);
      assert.deepEqual(t.byType[0], ["npm", 2]);
      assert.equal(t.latest?.target, "requests");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("separates the repos the anchor knows from the ones still on disk", () => {
    const dir = scratch();
    const home = scratch();
    try {
      const gone = join(dir, "vanished", ".kit-audit.jsonl");
      const here = join(dir, ".kit-audit.jsonl");
      writeFileSync(here, "{}\n");
      mkdirSync(join(home, ".kit"), { recursive: true });
      writeFileSync(
        join(home, ".kit", "audit-anchor.json"),
        // The real record is a flat map of log path -> tip; `version` is the kind of metadata key
        // that must never be mistaken for a repo.
        JSON.stringify({ [here]: { tip: "a" }, [gone]: { tip: "b" }, version: 2 }),
      );
      const m = machineFromAnchor(dir, home);
      assert.equal(m.sealedRepos, 2, "the anchor is the index of everything ever sealed");
      assert.equal(
        m.liveRepos,
        1,
        "a log that no longer exists is attrition, and must show as such",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("memoryFromDb", () => {
  const require_ = createRequire(import.meta.url);

  it("reads the store read-only and reports tokens as unknown when the rows carry none", () => {
    let sqlite: typeof import("node:sqlite");
    try {
      sqlite = require_("node:sqlite") as typeof import("node:sqlite");
    } catch {
      // A runtime without node:sqlite is a legitimate skip — but it must be a skip with a reason,
      // never a silent pass.
      return void assert.ok(true, "node:sqlite unavailable on this runtime");
    }
    const dir = scratch();
    const dbPath = join(dir, "memory.db");
    const prev = process.env.KIT_MEMORY_DB;
    try {
      const db = new sqlite.DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE sessions (session_id TEXT PRIMARY KEY, harness TEXT, project TEXT);
        CREATE TABLE messages (
          uuid TEXT PRIMARY KEY, session_id TEXT, timestamp TEXT,
          output_tokens INTEGER, cache_read_input_tokens INTEGER
        );
        INSERT INTO sessions VALUES ('s1','claude-code','/home/me/Development-alpha');
        INSERT INTO sessions VALUES ('s2','codex','/home/me/Development-beta');
        INSERT INTO messages VALUES ('m1','s1',datetime('now'),100,9000);
        INSERT INTO messages VALUES ('m2','s1',datetime('now'),50,1000);
        INSERT INTO messages VALUES ('m3','s2',datetime('now'),NULL,NULL);
        INSERT INTO messages VALUES ('m4','s1',datetime('now','-30 days'),999,999);
      `);
      db.close();

      process.env.KIT_MEMORY_DB = dbPath;
      const m = memoryFromDb(7);
      assert.equal(m.path, dbPath);
      assert.ok(m.bytes > 0, "the size on disk is the ownership claim — it must be real");
      assert.equal(m.messages, 4, "totals cover the whole store, not just the window");
      assert.equal(m.sessions, 2);
      assert.equal(m.outputTokens, 150, "the 30-day-old message is outside the 7-day window");
      assert.equal(m.cacheReadTokens, 10_000);
      assert.deepEqual(
        m.projects.map((p) => [p.project.split("Development-")[1], p.messages]),
        [
          ["alpha", 2],
          ["beta", 1],
        ],
        "biggest project first, and only messages inside the window",
      );
      assert.deepEqual(m.harnesses.map(([h]) => h).sort(), ["claude-code", "codex"]);
    } finally {
      if (prev === undefined) delete process.env.KIT_MEMORY_DB;
      else process.env.KIT_MEMORY_DB = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns unknown, not zero, when the file is not a usable store", () => {
    const dir = scratch();
    const bogus = join(dir, "memory.db");
    const prev = process.env.KIT_MEMORY_DB;
    try {
      writeFileSync(bogus, "this is not a database");
      process.env.KIT_MEMORY_DB = bogus;
      const m = memoryFromDb();
      assert.equal(m.path, bogus, "the path is still reported — the operator can go look");
      assert.equal(m.messages, 0);
      assert.equal(m.outputTokens, null, "no rows read means unknown tokens, not zero tokens");
      assert.deepEqual(m.projects, []);
    } finally {
      if (prev === undefined) delete process.env.KIT_MEMORY_DB;
      else process.env.KIT_MEMORY_DB = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Standards coverage, and the one distinction anyone showing this to a client will be asked about:
 * a control kit MAPS to a check is a claim; a control whose check actually ran and passed is
 * evidence. Reporting only the first is how a coverage map becomes marketing.
 */
describe("standardsFromRuns", () => {
  function runWith(security: unknown[]): string {
    const dir = scratch();
    mkdirSync(join(dir, ".kit", "runs"), { recursive: true });
    writeFileSync(join(dir, ".kit", "runs", "check-9000.json"), JSON.stringify({ security }));
    return dir;
  }

  it("scores every registered standard against the saved run's security rows", () => {
    const dir = runWith([
      { category: "dependency", name: "npm audit", status: "pass", detail: "" },
      { category: "secrets", name: "secrets scan", status: "pass", detail: "" },
    ]);
    try {
      const st = standardsFromRuns(dir);
      assert.ok(st.standards.length >= 8, `expected the whole registry: ${st.standards.length}`);
      assert.equal(st.at, new Date(9000).toISOString());
      for (const s2 of st.standards) {
        assert.ok(s2.verified <= s2.auto, `${s2.key}: verified must not exceed mapped`);
        assert.equal(
          s2.total,
          s2.auto + s2.gap + s2.manual + s2.na,
          `${s2.key}: buckets must add up`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("claims nothing when no run has been saved", () => {
    const dir = scratch();
    try {
      const st = standardsFromRuns(dir);
      assert.deepEqual(st.standards, []);
      assert.equal(
        st.at,
        null,
        "no run means no date — a coverage map with no evidence is a claim",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The keys tab answers "are my keys exposed" — and must answer it without ever handling a key.
 * Every unknown is reported as unknown: a repo with no saved run has UNKNOWN resolution, not zero
 * resolved, because "0 resolved" and "not measured" would look identical while meaning opposite
 * things.
 */
describe("keysFromConfigAndRun", () => {
  it("counts declared keys by source, reads names only", () => {
    const dir = scratch();
    try {
      writeFileSync(
        join(dir, ".kit.toml"),
        [
          "[secrets.keys]",
          'STRIPE_SECRET_KEY = { source = "1password" }',
          'DATABASE_URL = { source = "1password" }',
          'PORT = { source = "env" }',
        ].join("\n"),
      );
      const k = keysFromConfigAndRun(dir);
      assert.equal(k.declared, 3);
      assert.deepEqual(k.bySource, [
        ["1password", 2],
        ["env", 1],
      ]);
      assert.equal(k.available, null, "no run — resolution is unknown, not zero");
      assert.equal(k.history, null);
      assert.equal(k.envIgnored, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads resolution and history out of the saved run", () => {
    const dir = scratch();
    try {
      writeFileSync(join(dir, ".kit.toml"), '[secrets.keys]\nA = { source = "env" }\n');
      mkdirSync(join(dir, ".kit", "runs"), { recursive: true });
      writeFileSync(
        join(dir, ".kit", "runs", "check-9000.json"),
        JSON.stringify({
          secrets: [
            { name: "A", available: true },
            { name: "B", available: false },
          ],
          security: [
            {
              category: "secrets",
              name: "secrets scan",
              status: "warn",
              detail:
                "4 unverified secret-shaped string(s) in git history (0 verified-live) — review: 27 example credential(s) (fixtures), no rotation needed; 2 accepted historical finding(s) via .kit-secretsignore",
            },
            { category: "exposure", name: "gitignore coverage", status: "pass", detail: "" },
          ],
        }),
      );
      const k = keysFromConfigAndRun(dir);
      assert.equal(k.available, 1);
      assert.deepEqual(k.missing, ["B"]);
      assert.deepEqual(k.history, {
        verifiedLive: 0,
        unverified: 4,
        examples: 27,
        accepted: 2,
      });
      assert.equal(k.envIgnored, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports history as unknown when the row's wording does not parse", () => {
    // The counts live only in the row's prose. A wording change must yield null, never a wrong
    // number that someone then acts on.
    const dir = scratch();
    try {
      mkdirSync(join(dir, ".kit", "runs"), { recursive: true });
      writeFileSync(
        join(dir, ".kit", "runs", "check-9000.json"),
        JSON.stringify({
          security: [{ name: "secrets scan", status: "pass", detail: "all good, nothing to see" }],
        }),
      );
      assert.equal(keysFromConfigAndRun(dir).history, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
