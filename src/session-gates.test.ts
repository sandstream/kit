import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInstallResult } from "./agent-config.js";
import { ensureSessionGates, type SessionGatesDeps } from "./session-gates.js";

function fixture(kitToml: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-session-gates-"));
  if (kitToml) writeFileSync(join(dir, ".kit.toml"), "[tools]\n");
  return dir;
}

function deps(over: Partial<SessionGatesDeps> & { wiredAfter?: boolean } = {}) {
  let installed = 0;
  let wired = false;
  const ok = (file: string): HookInstallResult => ({ file, action: "created" });
  const d: SessionGatesDeps = {
    root: (cwd) => cwd,
    readOnly: () => false,
    wired: () => wired,
    installBash: async () => {
      installed++;
      return ok("settings.local.json");
    },
    installEnv: async () => {
      installed++;
      wired = over.wiredAfter ?? true;
      return ok("settings.local.json");
    },
    ...over,
  };
  return { d, installed: () => installed };
}

describe("kit hooks gates (session-start gate wiring)", () => {
  it("wires both gates in a kit-managed checkout that has none, and says so", async (t) => {
    const dir = fixture(true);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { d, installed } = deps();
    const r = await ensureSessionGates(dir, d);
    assert.equal(r.outcome, "installed");
    assert.equal(installed(), 2);
    assert.match(r.line ?? "", /apply to this session/);
  });

  it("installs nothing outside a kit-managed checkout", async (t) => {
    const dir = fixture(false);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { d, installed } = deps();
    assert.deepEqual(await ensureSessionGates(dir, d), { outcome: "not-kit-managed" });
    assert.equal(installed(), 0);
  });

  it("installs nothing when the gates are already wired, or in read-only mode", async (t) => {
    const dir = fixture(true);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const wiredAlready = deps({ wired: () => true });
    assert.equal((await ensureSessionGates(dir, wiredAlready.d)).outcome, "already-gated");
    const readOnly = deps({ readOnly: () => true });
    assert.equal((await ensureSessionGates(dir, readOnly.d)).outcome, "read-only");
    assert.equal(wiredAlready.installed() + readOnly.installed(), 0);
  });

  it("reports a failed or ineffective install with the fix, never throwing", async (t) => {
    const dir = fixture(true);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const failing = deps({
      installBash: async () => ({ file: "x", action: "failed", detail: "disk full" }),
    });
    const r1 = await ensureSessionGates(dir, failing.d);
    assert.equal(r1.outcome, "failed");
    assert.match(r1.line ?? "", /disk full.*kit agent-config/);
    const ineffective = deps({ wiredAfter: false });
    const r2 = await ensureSessionGates(dir, ineffective.d);
    assert.equal(r2.outcome, "failed");
    assert.match(r2.line ?? "", /not wired here/);
  });
});
