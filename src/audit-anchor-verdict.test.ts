import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { appendAuditEventDirect } from "./audit.js";
import {
  computeAnchorTip,
  lineSeals,
  lineHashes,
  anchorAuditLog,
  verifyAgainstAnchor,
  decideAnchorVerdict,
  hasAnyAnchoredLogs,
  resolveExternalAnchor,
  commandExternalAnchor,
  type AnchorVerifyResult,
  type AnchorRecord,
} from "./audit-anchor.js";

// The verdict and compatibility tests use real hash-chained logs without auto-anchoring.
async function buildChain(cwd: string, n: number): Promise<string> {
  for (let i = 0; i < n; i++) {
    const ok = await appendAuditEventDirect(
      { operation: `op-${i}`, environment: "dev", success: true },
      { cwd },
    );
    assert.equal(ok, true);
  }
  return readFileSync(join(cwd, ".kit-audit.jsonl"), "utf-8");
}

const mk = (over: Partial<AnchorVerifyResult>): AnchorVerifyResult => ({
  status: "anchored-ok",
  entries: 3,
  expected: 3,
  ...over,
});

describe("audit anchor - missing and unsealed verdicts", () => {
  it("ATTACK: no-anchor + machine has anchored logs => FAIL (path-repoint)", () => {
    const v = decideAnchorVerdict({
      result: mk({ status: "no-anchor" }),
      strict: false,
      machineHasAnchors: true,
    });
    assert.equal(v.ok, false);
    assert.equal(v.level, "error");
  });

  it("no-anchor + no strict + no anchored logs => warn (backward compat)", () => {
    const v = decideAnchorVerdict({
      result: mk({ status: "no-anchor" }),
      strict: false,
      machineHasAnchors: false,
    });
    assert.equal(v.ok, true);
    assert.equal(v.level, "warn");
  });

  it("ATTACK: forged unsealed tail => FAIL under strict", () => {
    const v = decideAnchorVerdict({
      result: mk({ status: "anchored-ok", entries: 5, expected: 3, newSinceAnchor: 2 }),
      strict: true,
      machineHasAnchors: true,
    });
    assert.equal(v.ok, false);
    assert.equal(v.level, "error");
    assert.match(v.message, /UNSEALED|UNAUTHENTICATED/);
  });

  it("unsealed tail without strict => surfaced loudly as warn (exit 0)", () => {
    const v = decideAnchorVerdict({
      result: mk({ status: "anchored-ok", entries: 5, expected: 3, newSinceAnchor: 2 }),
      strict: false,
      machineHasAnchors: false,
    });
    assert.equal(v.ok, true);
    assert.equal(v.level, "warn");
    assert.match(v.message, /UNSEALED|UNAUTHENTICATED/);
  });
});

describe("audit anchor - anchored verdicts", () => {
  it("anchored-ok with no tail => ok", () => {
    const v = decideAnchorVerdict({
      result: mk({ newSinceAnchor: 0 }),
      strict: true,
      machineHasAnchors: true,
    });
    assert.equal(v.ok, true);
    assert.equal(v.level, "ok");
  });

  it("anchor-key-changed: warn by default, FAIL under strict (distinct from tamper)", () => {
    const warn = decideAnchorVerdict({
      result: mk({ status: "anchor-key-changed", reason: "rotated" }),
      strict: false,
      machineHasAnchors: true,
    });
    assert.equal(warn.ok, true);
    assert.equal(warn.level, "warn");
    const strict = decideAnchorVerdict({
      result: mk({ status: "anchor-key-changed", reason: "rotated" }),
      strict: true,
      machineHasAnchors: true,
    });
    assert.equal(strict.ok, false);
  });

  it("tip-mismatch / truncated / unparseable always FAIL", () => {
    for (const status of ["tip-mismatch", "truncated", "unparseable"] as const) {
      const v = decideAnchorVerdict({
        result: mk({ status, reason: status }),
        strict: false,
        machineHasAnchors: false,
      });
      assert.equal(v.ok, false, status);
      assert.equal(v.level, "error", status);
    }
  });
});

describe("audit anchor - hasAnyAnchoredLogs", () => {
  it("is false on a fresh dir and true after anchoring", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-anchor-has-"));
    const dir = mkdtempSync(join(tmpdir(), "kit-anchor-hash-"));
    try {
      assert.equal(await hasAnyAnchoredLogs(dir), false);
      const content = await buildChain(cwd, 2);
      await anchorAuditLog(join(cwd, ".kit-audit.jsonl"), content, dir);
      assert.equal(await hasAnyAnchoredLogs(dir), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const withCmd = async <T>(cmd: string | undefined, fn: () => T | Promise<T>): Promise<T> => {
  const prev = process.env.KIT_EXTERNAL_ANCHOR_CMD;
  if (cmd === undefined) delete process.env.KIT_EXTERNAL_ANCHOR_CMD;
  else process.env.KIT_EXTERNAL_ANCHOR_CMD = cmd;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.KIT_EXTERNAL_ANCHOR_CMD;
    else process.env.KIT_EXTERNAL_ANCHOR_CMD = prev;
  }
};

describe("audit anchor - external command transport", () => {
  it("resolveExternalAnchor: null without env, command-anchor with it", async () => {
    await withCmd(undefined, () => assert.equal(resolveExternalAnchor(), null));
    await withCmd("true", () => assert.ok(resolveExternalAnchor() !== null));
  });

  it("commandExternalAnchor parses a JSON receipt and passes the tip via env", async () => {
    // The command echoes a receipt that embeds the tip it received → proves wiring.
    const a = commandExternalAnchor(
      `"${process.execPath}" -e "process.stdout.write(JSON.stringify({token:'tok-'+process.env.KIT_ANCHOR_TIP,authority:'test-tsa'}))"`,
    );
    const r = await a.anchor({ tip: "deadbeef", count: 3, logPath: "/x" });
    assert.equal(r.token, "tok-deadbeef");
    assert.equal(r.authority, "test-tsa");
    assert.ok(r.timestamp); // defaulted when absent
  });

  it("is FAIL-CLOSED: non-zero exit / non-JSON / missing token all throw", async () => {
    await assert.rejects(
      commandExternalAnchor("exit 7").anchor({ tip: "a", count: 1, logPath: "/x" }),
      /failed/,
    );
    await assert.rejects(
      commandExternalAnchor("echo not-json").anchor({ tip: "a", count: 1, logPath: "/x" }),
      /valid JSON receipt/,
    );
    await assert.rejects(
      commandExternalAnchor("echo {}").anchor({ tip: "a", count: 1, logPath: "/x" }),
      /token/,
    );
  });
});

describe("audit anchor - external receipt policy", () => {
  it("anchorAuditLog --external stores the receipt; requested-but-unconfigured throws", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-ext-log-"));
    const dir = mkdtempSync(join(tmpdir(), "kit-ext-home-"));
    try {
      const content = await buildChain(cwd, 2);
      const logPath = join(cwd, ".kit-audit.jsonl");
      // configured → receipt stored on the record
      await withCmd(
        `"${process.execPath}" -e "process.stdout.write(JSON.stringify({token:'abc',authority:'acme-tsa'}))"`,
        async () => {
          const rec = await anchorAuditLog(logPath, content, dir, { external: true });
          assert.equal(rec.external?.token, "abc");
          assert.equal(rec.external?.authority, "acme-tsa");
        },
      );
      // requested but no command configured → fail-closed throw
      await withCmd(undefined, async () => {
        await assert.rejects(
          anchorAuditLog(logPath, content, dir, { external: true }),
          /none configured/,
        );
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("decideAnchorVerdict --require-external fails an HMAC-only seal, passes one with a receipt", () => {
    const base: AnchorVerifyResult = {
      status: "anchored-ok",
      entries: 2,
      expected: 2,
      newSinceAnchor: 0,
    };
    const noExt = decideAnchorVerdict({
      result: base,
      strict: false,
      machineHasAnchors: true,
      requireExternal: true,
    });
    assert.equal(noExt.ok, false);
    assert.match(noExt.message, /external anchor REQUIRED/);

    const withExt = decideAnchorVerdict({
      result: {
        ...base,
        externalReceipt: { token: "t", authority: "tsa", timestamp: "2026-01-01" },
      },
      strict: false,
      machineHasAnchors: true,
      requireExternal: true,
    });
    assert.equal(withExt.ok, true);
    assert.match(withExt.message, /external anchor \(tsa\)/);
  });
});

// `lineHashes` is the v1/v2 (hash-only) extractor. The live seal path uses
// `lineSeals`/v3, so nothing in production calls this any more — but legacy v1/v2
// anchor records on disk are still recomputed through `computeAnchorTip` over
// hash-only input, so its extraction rules (what it accepts, what it rejects, and
// the ORDER it returns) remain security-relevant. These cases pin them.
const h = (s: string) => createHash("sha256").update(s).digest("hex");
const entry = (op: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    operation: op,
    environment: "dev",
    success: true,
    prev: "0".repeat(64),
    hash: h(op),
    ...extra,
  });

describe("audit anchor - lineHashes extraction", () => {
  it("returns every entry's hash in file order", () => {
    const content = [entry("op-0"), entry("op-1"), entry("op-2")].join("\n") + "\n";
    // Order is load-bearing: computeAnchorTip folds the list sequentially, so a
    // reordered extraction would produce a different tip for an untouched log.
    assert.deepEqual(lineHashes(content), [h("op-0"), h("op-1"), h("op-2")]);
  });

  it("ignores blank lines, whitespace-only lines and CRLF line endings", () => {
    const crlf = [entry("op-0"), entry("op-1")].join("\r\n") + "\r\n";
    // \r is JSON whitespace, so a CRLF-written log must not read as unparseable.
    assert.deepEqual(lineHashes(crlf), [h("op-0"), h("op-1")]);
    const gappy = `${entry("op-0")}\n\n   \n\t\n${entry("op-1")}`;
    // Also tolerates a missing trailing newline on the last entry.
    assert.deepEqual(lineHashes(gappy), [h("op-0"), h("op-1")]);
  });

  it("returns an empty array - not null - for empty or whitespace-only content", () => {
    // [] and null mean opposite things to callers: null is "unanchorable, refuse"
    // (anchorAuditLog throws), [] is "zero entries, anchorable". A fresh/emptied
    // log must land on [] so it can be sealed at count 0.
    assert.deepEqual(lineHashes(""), []);
    assert.deepEqual(lineHashes("\n"), []);
    assert.deepEqual(lineHashes("\n   \n\t\n"), []);
  });

  it("returns null when any line is unparseable JSON, including the last", () => {
    // Fail-closed: one corrupt line invalidates the whole extraction rather than
    // yielding a short list that would silently anchor a partial log.
    assert.equal(lineHashes(`{oops\n${entry("op-1")}\n`), null);
    assert.equal(lineHashes(`${entry("op-0")}\n{oops\n`), null);
    assert.equal(lineHashes(`${entry("op-0")}\n${entry("op-1")}\ntrailing garbage\n`), null);
  });

  it("returns null when a line has no hash or a non-string hash", () => {
    assert.equal(lineHashes(JSON.stringify({ operation: "x" }) + "\n"), null);
    assert.equal(lineHashes(`{"hash":1}\n`), null);
    assert.equal(lineHashes(`{"hash":null}\n`), null);
    assert.equal(lineHashes(`{"hash":true}\n`), null);
    assert.equal(lineHashes(`{"hash":["aa"]}\n`), null);
    // A valid-JSON line that is not an object also has no string hash -> null.
    assert.equal(lineHashes("123\n"), null);
    assert.equal(lineHashes(`"aa"\n`), null);
    assert.equal(lineHashes(`[{"hash":"aa"}]\n`), null);
    // Rejection is all-or-nothing: one bad line kills an otherwise good log.
    assert.equal(lineHashes(`${entry("op-0")}\n{"hash":1}\n`), null);
  });
});

describe("audit anchor - legacy lineHashes verification", () => {
  it("does not validate the hash VALUE - only that it is a string", () => {
    // This helper is a shape extractor, not a chain checker: an empty or non-hex
    // hash passes through here and is caught later by the keyless chain check.
    // Worth pinning because a caller must not treat a non-null return as "valid".
    assert.deepEqual(lineHashes(`{"hash":""}\n`), [""]);
    assert.deepEqual(lineHashes(`{"hash":"not hex"}\n`), ["not hex"]);
  });

  it("preserves duplicate hashes so the count matches the line count", () => {
    const dup = entry("same");
    // The anchor stores `count` alongside the tip; de-duplicating here would let a
    // replayed/duplicated entry shrink the count and defeat the truncation check.
    assert.deepEqual(lineHashes(`${dup}\n${dup}\n${dup}\n`), [h("same"), h("same"), h("same")]);
  });

  it("returns null (fail closed) on a bare `null` JSON line rather than throwing", () => {
    // This case USED to throw: `JSON.parse("null")` succeeds inside the try, and
    // `obj.hash` was read outside it, so a log line containing exactly `null` escaped
    // as a TypeError instead of the fail-closed null every other malformed line gets.
    // `lineSeals` shared the flaw and IS the live extractor `verifyAgainstAnchor`
    // calls — a crash is not a verdict. Both guard the parse result now.
    assert.equal(lineHashes("null\n"), null);
    assert.equal(lineHashes(`${entry("op-0")}\nnull\n`), null);
    assert.equal(lineSeals("null\n"), null);
    assert.equal(lineSeals(`${entry("op-0")}\nnull\n`), null);
  });

  it("agrees with lineSeals, so a legacy v1 anchor still recomputes to anchored-ok", () => {
    const key = Buffer.alloc(32, 5);
    const content = [entry("op-0", { kid: "k1", sig: "S1" }), entry("op-1")].join("\n") + "\n";
    const hashes = lineHashes(content);
    assert.ok(hashes, "the synthetic log must be parseable"); // also narrows away null
    // verifyAgainstAnchor recomputes a v<=3 record via lineSeals(...).map(s => s.hash);
    // if the two extractors ever diverge, every legacy anchor on disk turns into a
    // spurious tip-mismatch (a false tamper alarm).
    assert.deepEqual(
      hashes,
      lineSeals(content)?.map((s) => s.hash),
    );
    const legacy: AnchorRecord = {
      tip: computeAnchorTip(key, hashes),
      count: hashes.length,
      algo: "hmac-sha256",
      updatedAt: "2026-01-01T00:00:00.000Z",
      // no version / no keyFingerprint => v1 record, hash-only fold
    };
    assert.equal(verifyAgainstAnchor(content, legacy, key).status, "anchored-ok");
    // ...and a v1 tip built from hashes must NOT be accepted for a v3 record:
    // the v3 fold binds kid/sig, so the same bytes yield a different tip.
    assert.equal(
      verifyAgainstAnchor(content, { ...legacy, version: 3 }, key).status,
      "tip-mismatch",
    );
  });
});
