import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readActiveEnv,
  writeActiveEnv,
  getActiveEnv,
  prodReadAllowed,
  looksLikeProdKey,
} from "./env-switch.js";

describe("writeActiveEnv / readActiveEnv", () => {
  it("round-trips an env marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-env-"));
    try {
      const written = await writeActiveEnv("staging", dir, "tester");
      assert.equal(written.env, "staging");
      assert.equal(written.switchedBy, "tester");
      const read = await readActiveEnv(dir);
      assert.ok(read);
      assert.equal(read!.env, "staging");
      assert.ok(existsSync(join(dir, ".kit", "active-env.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no marker exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-env-"));
    try {
      assert.equal(await readActiveEnv(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write the marker in read-only mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-env-"));
    process.env.KIT_READ_ONLY = "1";
    try {
      const state = await writeActiveEnv("prod", dir, "tester");
      assert.equal(state.env, "prod"); // returns the would-be state
      assert.equal(existsSync(join(dir, ".kit", "active-env.json")), false); // but never wrote
      assert.equal(await readActiveEnv(dir), null); // disk marker unchanged
    } finally {
      delete process.env.KIT_READ_ONLY;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores invalid env values in the marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-env-"));
    try {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(join(dir, ".kit"), { recursive: true });
      writeFileSync(join(dir, ".kit", "active-env.json"), JSON.stringify({ env: "bogus" }));
      assert.equal(await readActiveEnv(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("getActiveEnv", () => {
  it("defaults to dev when no marker present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-env-"));
    try {
      assert.equal(await getActiveEnv(dir), "dev");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("prodReadAllowed", () => {
  it("returns false when active env is not prod", () => {
    assert.equal(prodReadAllowed("dev"), false);
    assert.equal(prodReadAllowed("staging"), false);
  });

  it("requires KIT_PROD_OK=1 in prod env by default", () => {
    const prev = process.env.KIT_PROD_OK;
    try {
      delete process.env.KIT_PROD_OK;
      assert.equal(prodReadAllowed("prod"), false);
      process.env.KIT_PROD_OK = "1";
      assert.equal(prodReadAllowed("prod"), true);
    } finally {
      if (prev !== undefined) process.env.KIT_PROD_OK = prev;
      else delete process.env.KIT_PROD_OK;
    }
  });

  it("honors explicitOk regardless of env var", () => {
    const prev = process.env.KIT_PROD_OK;
    try {
      delete process.env.KIT_PROD_OK;
      assert.equal(prodReadAllowed("prod", { explicitOk: true }), true);
    } finally {
      if (prev !== undefined) process.env.KIT_PROD_OK = prev;
    }
  });
});

describe("looksLikeProdKey", () => {
  it("matches obvious prod markers", () => {
    assert.equal(looksLikeProdKey("op://Prod/Project/STRIPE"), true);
    assert.equal(looksLikeProdKey("vault/data/production/key"), true);
    assert.equal(looksLikeProdKey("stripe-live-key"), true);
    assert.equal(looksLikeProdKey("PRD_DB_PASS"), true);
  });

  it("doesn't false-positive on innocent strings", () => {
    assert.equal(looksLikeProdKey("op://Dev/Project/STRIPE"), false);
    assert.equal(looksLikeProdKey("approved"), false); // 'prod' not at word boundary
    assert.equal(looksLikeProdKey(undefined), false);
    assert.equal(looksLikeProdKey(""), false);
  });
});
