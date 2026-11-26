/**
 * `kit tools pin` / `--accept`: re-trust is explicit and audited, and a pin is never written
 * without its audit row (kit-research#232).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { readPin } from "../vendor-cli-pin.js";
import { pinOne } from "./tools-pin.js";
import { makeFixture, opStub, POSIX_ONLY, type Fixture } from "../vendor-cli-pin.test-support.js";

describe("kit tools pin", { skip: POSIX_ONLY }, () => {
  let f: Fixture;
  beforeEach(() => (f = makeFixture()));
  afterEach(() => f.done());

  it("records realpath, sha256 and version in .kit/cli-lock.json", async () => {
    assert.equal((await pinOne("op", false, f.deps, f.io)).result, "pinned");
    const lock = JSON.parse(readFileSync(join(f.proj, ".kit", "cli-lock.json"), "utf8"));
    const id = Object.values(lock.identity.op)[0] as { sha256: string; version: string };
    assert.match(id.sha256, /^[0-9a-f]{64}$/);
    assert.equal(id.version, "2.30.0");
    assert.equal(f.audits[0]!.operation, "vendor-cli-pin");
  });

  it("a symlinked op (Homebrew-style) is pinned by its realpath target", async () => {
    const cellar = join(f.root, "Cellar", "op", "2.30.0", "bin");
    f.writeOp(cellar, opStub("2.30.0"));
    const link = join(f.root, "linkbin");
    mkdirSync(link);
    symlinkSync(join(cellar, "op"), join(link, "op"));
    f.deps.env = { PATH: link };
    const o = await pinOne("op", false, f.deps, f.io);
    assert.ok(o.identity!.path.endsWith(join("Cellar", "op", "2.30.0", "bin", "op")));
  });

  it("plain pin refuses a change; --accept re-trusts it and writes an audit row", async () => {
    await pinOne("op", false, f.deps, f.io);
    f.writeOp(f.bin, opStub("2.31.0"));
    const refused = await pinOne("op", false, f.deps, f.io);
    assert.equal(refused.result, "refused");
    assert.match(refused.detail, /kit tools pin --accept op/);
    assert.equal((await pinOne("op", true, f.deps, f.io)).result, "accepted");
    const last = f.audits.at(-1)!;
    assert.equal(last.operation, "vendor-cli-pin-accept");
    const meta = last.metadata as { previous: { version: string }; accepted: { version: string } };
    assert.equal(meta.previous.version, "2.30.0");
    assert.equal(meta.accepted.version, "2.31.0");
    assert.equal((await readPin("op", f.deps))!.version, "2.31.0");
  });

  it("no pin is written when the audit row cannot be", async () => {
    f.io.audit = async () => false;
    assert.equal((await pinOne("op", false, f.deps, f.io)).result, "error");
    assert.equal(await readPin("op", f.deps), null);
  });

  it("the real audit log gets the pin and accept rows", async () => {
    const { appendAuditEventDirect } = await import("../audit.js");
    f.io.audit = (e) => appendAuditEventDirect(e, { cwd: f.proj });
    await pinOne("op", false, f.deps, f.io);
    f.writeOp(f.bin, opStub("2.31.0"));
    await pinOne("op", true, f.deps, f.io);
    const lines = readFileSync(join(f.proj, ".kit-audit.jsonl"), "utf8").trim().split("\n");
    const ops = lines.map((l) => JSON.parse(l).operation);
    assert.deepEqual(ops.slice(-2), ["vendor-cli-pin", "vendor-cli-pin-accept"]);
  });
});
