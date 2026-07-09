import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseProfile,
  loadProfile,
  saveProfile,
  canonicalProfileBytes,
  profileFingerprint,
  InvalidProfileError,
  PROFILE_FILE,
  PROFILE_SCHEMA_VERSION,
  type KitProfile,
} from "./schema.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kit-profile-"));
}

const MINIMAL = `version = 1\n`;

const FULL = `
version = 1
name = "acme-api"

[[skills]]
name = "api-test"
source = "github:acme/skills#api-test"
version = "1.4.0"

[[mcp]]
name = "postgres"
source = "npx @acme/mcp-postgres"

[[workflows]]
name = "release"

[vault]
store = "1password"
keys = { DATABASE_URL = "vault" }

[gates]
baseline = ".kit-baseline.json"
standards = true
security = true

[scope]
egress = ["api.acme.com"]
fs = ["."]
secrets = ["DATABASE_URL"]
`;

describe("parseProfile", () => {
  it("parses a minimal version-1 profile", () => {
    const p = parseProfile(MINIMAL);
    assert.equal(p.version, 1);
    assert.equal(typeof p.generated, "string"); // defaulted when absent
  });

  it("parses a full profile with every section", () => {
    const p = parseProfile(FULL);
    assert.equal(p.name, "acme-api");
    assert.equal(p.skills?.[0]?.name, "api-test");
    assert.equal(p.skills?.[0]?.version, "1.4.0");
    assert.equal(p.mcp?.[0]?.source, "npx @acme/mcp-postgres");
    assert.equal(p.workflows?.[0]?.name, "release");
    assert.equal(p.vault?.store, "1password");
    assert.equal(p.vault?.keys?.DATABASE_URL, "vault");
    assert.equal(p.gates?.standards, true);
    assert.deepEqual(p.scope?.egress, ["api.acme.com"]);
  });

  it("throws InvalidProfileError on unparseable TOML", () => {
    assert.throws(() => parseProfile("version = = 1"), InvalidProfileError);
  });

  it("throws when version is missing (can't be safely interpreted)", () => {
    assert.throws(() => parseProfile(`name = "x"\n`), InvalidProfileError);
  });

  it("refuses a schema version newer than this kit understands", () => {
    assert.throws(
      () => parseProfile(`version = ${PROFILE_SCHEMA_VERSION + 1}\n`),
      /newer than this kit understands/,
    );
  });

  it("rejects unknown top-level keys (strict — catches typos)", () => {
    assert.throws(() => parseProfile(`version = 1\nskils = []\n`), InvalidProfileError);
  });

  it("rejects a component without a name", () => {
    assert.throws(
      () => parseProfile(`version = 1\n[[skills]]\nsource = "x"\n`),
      InvalidProfileError,
    );
  });
});

describe("loadProfile", () => {
  it("returns null when no profile is declared (honest skip, not empty profile)", async () => {
    const dir = tmp();
    try {
      assert.equal(await loadProfile(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads a declared profile", async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, PROFILE_FILE), FULL);
      const p = await loadProfile(dir);
      assert.equal(p?.name, "acme-api");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws (fail-closed) on a malformed profile that exists", async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, PROFILE_FILE), "not = = toml");
      await assert.rejects(loadProfile(dir), InvalidProfileError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("saveProfile", () => {
  it("round-trips through disk and refreshes the generated stamp", async () => {
    const dir = tmp();
    try {
      const p: KitProfile = {
        version: 1,
        generated: new Date(0).toISOString(),
        name: "rt",
        skills: [{ name: "a", version: "1.0.0" }],
      };
      await saveProfile(p, dir);
      assert.notEqual(p.generated, new Date(0).toISOString()); // stamped on save
      const loaded = await loadProfile(dir);
      assert.equal(loaded?.name, "rt");
      assert.equal(loaded?.skills?.[0]?.name, "a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("canonicalProfileBytes", () => {
  it("excludes the volatile generated stamp", () => {
    const a: KitProfile = { version: 1, generated: "2020-01-01T00:00:00.000Z", name: "x" };
    const b: KitProfile = { version: 1, generated: "2026-07-09T00:00:00.000Z", name: "x" };
    assert.equal(canonicalProfileBytes(a), canonicalProfileBytes(b));
  });

  it("is stable under key/section reordering (parse two orderings → same bytes)", () => {
    const one = parseProfile(
      `version = 1\nname = "x"\n[gates]\nstandards = true\nsecurity = false\n`,
    );
    const two = parseProfile(
      `name = "x"\nversion = 1\n[gates]\nsecurity = false\nstandards = true\n`,
    );
    assert.equal(canonicalProfileBytes(one), canonicalProfileBytes(two));
  });

  it("moves when a real declaration changes", () => {
    const base = parseProfile(FULL);
    const changed = parseProfile(FULL.replace("1.4.0", "1.5.0"));
    assert.notEqual(canonicalProfileBytes(base), canonicalProfileBytes(changed));
  });
});

describe("profileFingerprint", () => {
  it("is a sha256: short hash, stable for the same content", () => {
    const p = parseProfile(FULL);
    const fp = profileFingerprint(p);
    assert.match(fp, /^sha256:[0-9a-f]{16}$/);
    assert.equal(fp, profileFingerprint(parseProfile(FULL)));
  });

  it("changes when content changes but not when only generated changes", () => {
    const p = parseProfile(FULL);
    const sameContent = parseProfile(FULL);
    sameContent.generated = "2099-01-01T00:00:00.000Z";
    assert.equal(profileFingerprint(p), profileFingerprint(sameContent));
    const changed = parseProfile(FULL.replace("acme-api", "acme-web"));
    assert.notEqual(profileFingerprint(p), profileFingerprint(changed));
  });
});
