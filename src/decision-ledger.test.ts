/**
 * The ledger's SHAPE rules, tested without touching a filesystem.
 *
 * Everything here is about form, never content. A decision with a bad reason parses exactly like a
 * decision with a good one — scoring the reasoning is model work, and the moment kit does it the
 * auditor separation the ledger exists to create is gone. So the tests below only ever assert on
 * "is this an entry kit can read, and does it carry the four facts", and one test pins that a
 * transparently thin decision still passes.
 *
 * The one place this parser deliberately differs from `.kit-triage.jsonl`'s reader: a torn line is
 * a PROBLEM here, not a skipped line. The triage log is evidence that something happened, so a
 * damaged append loses one record; this ledger is the review surface itself, so a line nobody can
 * read is a hole in it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseLedger,
  newEntry,
  serialiseEntry,
  summarise,
  MIN_CONFIDENCE,
  MAX_CONFIDENCE,
  readLedger,
  appendEntry,
} from "./decision-ledger.js";

const VALID = {
  id: "a1b2c3",
  at: "2026-08-24T09:00:00.000Z",
  decision: "Store the ledger as JSONL under .kit/, not as a table in the audit log",
  confidence: 0.6,
  assumed: "the ledger is per-run and disposable, so it does not need the audit log's chain",
  would_have_asked: "should a ledger survive across runs, or be rebuilt each time?",
};

const line = (o: Record<string, unknown>): string => JSON.stringify(o);

describe("parseLedger", () => {
  it("reads a well-formed entry", () => {
    const { entries, problems } = parseLedger(line(VALID));
    assert.equal(problems.length, 0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].decision, VALID.decision);
    assert.equal(entries[0].confidence, 0.6);
  });

  it("ignores blank lines and trailing newlines", () => {
    const { entries, problems } = parseLedger(`\n${line(VALID)}\n\n`);
    assert.equal(problems.length, 0);
    assert.equal(entries.length, 1);
  });

  it("names the missing field and the line it is missing from", () => {
    const { id: _id, ...noId } = VALID;
    const missing = { ...noId, id: "b2c3d4" } as Record<string, unknown>;
    delete missing.would_have_asked;
    const { entries, problems } = parseLedger(`${line(VALID)}\n${line(missing)}`);
    assert.equal(entries.length, 1, "the readable entry is still returned");
    assert.equal(problems.length, 1);
    assert.equal(problems[0].line, 2);
    assert.match(problems[0].message, /would_have_asked/);
  });

  it("reports a torn line rather than silently dropping it", () => {
    const { entries, problems } = parseLedger(`${line(VALID)}\n{"decision": "unterminated`);
    assert.equal(entries.length, 1);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].line, 2);
    assert.match(problems[0].message, /not valid JSON/i);
  });

  it("rejects a confidence outside 0..1", () => {
    const { problems } = parseLedger(line({ ...VALID, confidence: 60 }));
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /confidence/);
    assert.match(problems[0].message, new RegExp(`${MIN_CONFIDENCE}.*${MAX_CONFIDENCE}`));
  });

  it("rejects a confidence that is a string, however numeric it looks", () => {
    const { problems } = parseLedger(line({ ...VALID, confidence: "0.6" }));
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /confidence/);
  });

  it("rejects an empty required field — a present-but-blank fact is not a fact", () => {
    const { problems } = parseLedger(line({ ...VALID, assumed: "   " }));
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /assumed/);
  });

  it("rejects a timestamp that does not parse", () => {
    const { problems } = parseLedger(line({ ...VALID, at: "last tuesday" }));
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /at/);
  });

  it("reports a duplicate id — two entries that cannot be told apart are one hole", () => {
    const { entries, problems } = parseLedger(
      `${line(VALID)}\n${line({ ...VALID, decision: "a different call" })}`,
    );
    assert.equal(entries.length, 2, "both are still readable");
    assert.equal(problems.length, 1);
    assert.equal(problems[0].line, 2);
    assert.match(problems[0].message, /duplicate id/i);
  });

  it("accepts a thin decision — kit gates the shape, never the content", () => {
    const thin = {
      ...VALID,
      decision: "did it the usual way",
      assumed: "nothing",
      would_have_asked: "nothing",
      confidence: 0.1,
    };
    const { entries, problems } = parseLedger(line(thin));
    assert.equal(problems.length, 0);
    assert.equal(entries.length, 1);
  });

  it("accepts an optional reviewed flag and defaults it to false", () => {
    const { entries } = parseLedger(
      `${line(VALID)}\n${line({ ...VALID, id: "z9", reviewed: true })}`,
    );
    assert.equal(entries[0].reviewed, false);
    assert.equal(entries[1].reviewed, true);
  });

  it("rejects a reviewed flag that is not a boolean", () => {
    const { problems } = parseLedger(line({ ...VALID, reviewed: "yes" }));
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /reviewed/);
  });

  it("reports a line that is JSON but not an object", () => {
    const { problems } = parseLedger(`["a decision"]`);
    assert.equal(problems.length, 1);
    assert.match(problems[0].message, /object/i);
  });
});

describe("newEntry", () => {
  it("round-trips through the parser it will be verified by", () => {
    const entry = newEntry(
      {
        decision: VALID.decision,
        confidence: 0.5,
        assumed: VALID.assumed,
        wouldHaveAsked: VALID.would_have_asked,
      },
      new Date("2026-08-24T09:00:00.000Z"),
      () => "deadbe",
    );
    const { entries, problems } = parseLedger(serialiseEntry(entry));
    assert.equal(problems.length, 0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, "deadbe");
    assert.equal(entries[0].at, "2026-08-24T09:00:00.000Z");
    assert.equal(entries[0].reviewed, false);
  });

  it("serialises to exactly one line, so an append can never merge two entries", () => {
    const entry = newEntry(
      {
        decision: "a decision\nwith an embedded newline",
        confidence: 0.5,
        assumed: "multi\nline",
        wouldHaveAsked: "also\nmulti",
      },
      new Date("2026-08-24T09:00:00.000Z"),
      () => "deadbe",
    );
    const serialised = serialiseEntry(entry);
    assert.equal(serialised.split("\n").filter((l) => l.trim()).length, 1);
    assert.equal(parseLedger(serialised).problems.length, 0);
  });
});

describe("summarise", () => {
  it("counts entries and unreviewed ones", () => {
    const { entries } = parseLedger(
      [
        line(VALID),
        line({ ...VALID, id: "b2", reviewed: true }),
        line({ ...VALID, id: "c3", at: "2026-08-24T11:00:00.000Z" }),
      ].join("\n"),
    );
    const s = summarise(entries);
    assert.equal(s.total, 3);
    assert.equal(s.unreviewed, 2);
    assert.equal(s.newest, "2026-08-24T11:00:00.000Z");
  });

  it("has no newest entry when the ledger is empty", () => {
    const s = summarise([]);
    assert.equal(s.total, 0);
    assert.equal(s.newest, null);
  });
});

describe("parseLedger line accounting", () => {
  it("counts the non-blank lines it considered, so a report can say '2 of 3'", () => {
    const { lines } = parseLedger(`${line(VALID)}\n\n{torn\n${line({ ...VALID, id: "c3" })}`);
    assert.equal(lines, 3);
  });
});

describe("readLedger / appendEntry", () => {
  it("returns null when no ledger exists — absent is not empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ledger-io-"));
    try {
      assert.equal(await readLedger(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends through the parser that verifies it, creating .kit/ on the first decision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ledger-io-"));
    try {
      const first = newEntry(
        {
          decision: "a",
          confidence: 0.4,
          assumed: "b",
          wouldHaveAsked: "c",
        },
        new Date("2026-08-24T09:00:00.000Z"),
        () => "one",
      );
      const second = newEntry(
        {
          decision: "d",
          confidence: 0.9,
          assumed: "e",
          wouldHaveAsked: "f",
        },
        new Date("2026-08-24T10:00:00.000Z"),
        () => "two",
      );
      await appendEntry(dir, first);
      await appendEntry(dir, second);
      const read = await readLedger(dir);
      assert.ok(read);
      assert.equal(read.problems.length, 0);
      assert.deepEqual(
        read.entries.map((e) => e.id),
        ["one", "two"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
