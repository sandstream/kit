import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { it } from "node:test";
import { fixture } from "../memory/pal-cli.test-support.js";
import type { PalView } from "../memory/pal-revisions.js";

import { CLAUDE, rejectedJson } from "./memory-pal-claims.test-support.js";

it("CLI claim requires explicit session context before creating memory", async (t) => {
  const { cli, dbPath } = await fixture(t, "claims-device", {
    CLAUDE_SESSION_ID: "not-authoritative",
    CODEX_THREAD_ID: "not-authoritative",
  });
  const result = await rejectedJson(cli("claim", "missing", "--json"), 2);
  assert.equal(result.ok, false);
  assert.match(result.error!, /--harness.*--session.*--expect/);
  assert.equal(existsSync(dbPath), false);
});

it("CLI renewal rotates the receipt and never retries a stale claim operation", async (t) => {
  const { cli } = await fixture(t, "claims-device");
  await cli("add", "Keep receipt review owned");
  const [{ id }] = JSON.parse(await cli("list", "--json"));
  const before: PalView = JSON.parse(await cli("show", id, "--json"));
  const claimed = JSON.parse(
    await cli("claim", id, ...CLAUDE, "--expect", before.frontier, "--json"),
  );
  const renewed = JSON.parse(
    await cli("renew", id, ...CLAUDE, "--expect", claimed.view.frontier, "--json"),
  );
  assert.equal(renewed.status, "applied");
  assert.notEqual(renewed.view.frontier, claimed.view.frontier);
  assert.deepEqual(
    renewed.view.heads[0].state.claim_owner,
    claimed.view.heads[0].state.claim_owner,
  );
  for (const action of ["renew", "takeover", "claim"]) {
    const stale = await rejectedJson(
      cli(action, id, ...CLAUDE, "--expect", claimed.view.frontier, "--json"),
    );
    assert.equal(stale.status, "stale");
    assert.deepEqual(stale.view, renewed.view);
  }
  assert.equal(
    (await rejectedJson(cli("release", id, ...CLAUDE, "--expect", claimed.view.frontier, "--json")))
      .status,
    "stale",
  );
  assert.deepEqual(JSON.parse(await cli("show", id, "--json")), renewed.view);
  assert.equal(
    JSON.parse(await cli("release", id, ...CLAUDE, "--expect", renewed.view.frontier, "--json"))
      .status,
    "applied",
  );
  const released: PalView = JSON.parse(await cli("show", id, "--json"));
  assert.equal(released.heads[0].state.status, "open");
  assert.equal(released.heads[0].state.claim_owner, null);
});
