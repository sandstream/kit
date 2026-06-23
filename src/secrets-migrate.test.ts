import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidKeyName,
  commentOutInFile,
  writeSecretToBackend,
  planMigration,
} from "./secrets-migrate.js";

describe("isValidKeyName", () => {
  it("accepts env-var-shaped identifiers", () => {
    assert.equal(isValidKeyName("API_KEY"), true);
    assert.equal(isValidKeyName("STRIPE_SECRET_KEY"), true);
    assert.equal(isValidKeyName("_PRIVATE"), true);
    assert.equal(isValidKeyName("a"), true);
  });

  it("rejects argv-injection shapes", () => {
    assert.equal(isValidKeyName("-x"), false);
    assert.equal(isValidKeyName("--inject"), false);
    assert.equal(isValidKeyName(""), false);
    assert.equal(isValidKeyName("KEY WITH SPACE"), false);
    assert.equal(isValidKeyName("a=b"), false);
    assert.equal(isValidKeyName("$INJECT"), false);
    assert.equal(isValidKeyName(";rm -rf /"), false);
  });

  it("rejects names starting with a digit", () => {
    assert.equal(isValidKeyName("1KEY"), false);
  });

  it("rejects pathologically long names", () => {
    assert.equal(isValidKeyName("A".repeat(129)), false);
  });
});

describe("writeSecretToBackend - invalid keys", () => {
  it("refuses to call the sink CLI when key is invalid", async () => {
    const result = await writeSecretToBackend("1password", "--malicious-flag", "any-value");
    assert.equal(result.ok, false);
    assert.ok(result.detail.includes("invalid key name"));
  });
});

describe("commentOutInFile", () => {
  it("default mode 'blank' clears the value but keeps the key visible", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-migrate-"));
    const file = join(dir, ".env");
    writeFileSync(file, "STRIPE_SECRET_KEY=sk_test_X\nFOO_KEY=bar\n");
    const result = await commentOutInFile(file, ["STRIPE_SECRET_KEY"]);
    const after = readFileSync(file, "utf-8");
    assert.equal(result.changed, 1);
    // Plaintext gone; key name retained so devs see what's required.
    assert.ok(!after.includes("sk_test_X"));
    assert.ok(after.includes("STRIPE_SECRET_KEY="));
    assert.ok(after.includes("FOO_KEY=bar"));
  });

  it("'comment' mode preserves original line behind a comment marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-migrate-"));
    const file = join(dir, ".env");
    writeFileSync(file, "STRIPE_SECRET_KEY=sk_test_X\nFOO_KEY=bar\n");
    const result = await commentOutInFile(file, ["STRIPE_SECRET_KEY"], "comment");
    const after = readFileSync(file, "utf-8");
    assert.equal(result.changed, 1);
    assert.ok(after.includes("# migrated by kit"));
    assert.ok(after.includes("sk_test_X")); // still present (intentional, for rollback)
    assert.ok(after.includes("FOO_KEY=bar"));
  });

  it("'delete' mode drops the line entirely", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-migrate-"));
    const file = join(dir, ".env");
    writeFileSync(file, "STRIPE_SECRET_KEY=sk_test_X\nFOO_KEY=bar\n");
    const result = await commentOutInFile(file, ["STRIPE_SECRET_KEY"], "delete");
    const after = readFileSync(file, "utf-8");
    assert.equal(result.changed, 1);
    assert.ok(!after.includes("sk_test_X"));
    assert.ok(!after.includes("STRIPE_SECRET_KEY"));
    assert.ok(after.includes("FOO_KEY=bar"));
  });

  it("ignores invalid keys passed in by mistake", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-migrate-"));
    const file = join(dir, ".env");
    writeFileSync(file, "FOO=bar\n");
    const result = await commentOutInFile(file, ["-x", "--inject"]);
    assert.equal(result.changed, 0);
    assert.equal(readFileSync(file, "utf-8"), "FOO=bar\n");
  });

  it("returns 0 changed when file does not exist", async () => {
    const result = await commentOutInFile("/nonexistent/path/.env", ["KEY"]);
    assert.equal(result.changed, 0);
  });
});

describe("planMigration", () => {
  it("includes every env-var, not only secret-shaped values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-plan-"));
    writeFileSync(
      join(dir, ".env.production"),
      [
        "NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co",
        "RESEND_FROM_EMAIL=noreply@example.com",
        "STRIPE_SECRET_KEY=sk_te" + "st_AAAAAAAAAAAAAAAAAAAAAA",
        "# comment line",
        "",
      ].join("\n"),
    );
    const plan = await planMigration(dir);
    assert.equal(plan.keyValues.size, 3, "URL + email + secret all included");
    assert.ok(plan.keyValues.has("NEXT_PUBLIC_SUPABASE_URL"));
    assert.ok(plan.keyValues.has("RESEND_FROM_EMAIL"));
    assert.ok(plan.keyValues.has("STRIPE_SECRET_KEY"));
  });

  it("secretsOnly:true restores credential-pattern filter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-plan-"));
    writeFileSync(
      join(dir, ".env.production"),
      [
        "NEXT_PUBLIC_SUPABASE_URL=https://abc.supabase.co",
        "STRIPE_SECRET_KEY=sk_te" + "st_AAAAAAAAAAAAAAAAAAAAAA",
      ].join("\n"),
    );
    const plan = await planMigration(dir, { secretsOnly: true });
    assert.equal(plan.keyValues.size, 1, "only credential-shaped value");
    assert.ok(plan.keyValues.has("STRIPE_SECRET_KEY"));
    assert.ok(!plan.keyValues.has("NEXT_PUBLIC_SUPABASE_URL"));
  });

  it("strips simple quotes from values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-plan-"));
    writeFileSync(join(dir, ".env"), `URL="https://a.example.com"\nALT='single-quoted'\n`);
    const plan = await planMigration(dir);
    assert.equal(plan.keyValues.get("URL")?.value, "https://a.example.com");
    assert.equal(plan.keyValues.get("ALT")?.value, "single-quoted");
  });
});
