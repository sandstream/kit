import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { loadPublicTables } from "./anon-public-tables.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const strip = (t: string) => t.toLowerCase().replace(/^public\./, "");

async function load(kitToml: string | null) {
  const root = mkdtempSync(join(tmpdir(), "kit-anon-public-"));
  try {
    if (kitToml !== null) writeFileSync(join(root, ".kit.toml"), kitToml);
    return await loadPublicTables(root, strip);
  } finally {
    rmTemp(root);
  }
}

it("reads declared tables with their reasons and normalizes the names", async () => {
  const r = await load('[anon_access.public]\n"public.Markets" = "  country list  "\n');
  assert.deepEqual([...r.reasons], [["markets", "country list"]]);
  assert.deepEqual(r.noReason, []);
});

it("keeps an entry with an empty reason out of the reasons and reports it", async () => {
  const r = await load('[anon_access.public]\nmarkets = " "\nteams = "team names"\n');
  assert.deepEqual([...r.reasons.keys()], ["teams"]);
  assert.deepEqual(r.noReason, ["markets"]);
});

it("returns an empty declaration without a .kit.toml or without the section", async () => {
  for (const toml of [null, "[scan]\nguarddog = false\n"]) {
    const r = await load(toml);
    assert.equal(r.reasons.size, 0);
    assert.deepEqual(r.noReason, []);
  }
});
