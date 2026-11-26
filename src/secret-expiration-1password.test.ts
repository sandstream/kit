import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  checkSecretExpiration,
  get1PasswordExpiration,
  parse1PasswordExpiry,
} from "./secret-expiration.js";
import type { GovernanceConfig, SecretsConfig } from "./config.js";

// The shape `op item get --format json` emits: no top-level expiry, dates are
// `fields[]` entries of type DATE (https://www.1password.dev/cli/item-fields).
function item(fields: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    id: "abc",
    title: "stripe-api",
    category: "API_CREDENTIAL",
    vault: { id: "v", name: "Dev" },
    fields: [
      { id: "credential", type: "CONCEALED", label: "credential", value: "sk_test_h.example" },
      ...fields,
    ],
  });
}

describe("parse1PasswordExpiry: the real op item shape", () => {
  it("reads a DATE field labelled expires (YYYY-MM-DD)", () => {
    const json = item([{ id: "expires", type: "DATE", label: "expires", value: "2020-01-01" }]);
    assert.equal(parse1PasswordExpiry(json), "2020-01-01T00:00:00.000Z");
  });

  it("reads a DATE value given as unix epoch seconds", () => {
    for (const value of ["1577836800", 1577836800]) {
      const json = item([{ id: "x1", type: "DATE", label: "Expiry date", value }]);
      assert.equal(parse1PasswordExpiry(json), "2020-01-01T00:00:00.000Z");
    }
  });

  it("ignores seconds outside the JavaScript date range", () => {
    for (const value of [9_000_000_000_000, "9000000000000", Number.MAX_VALUE, "9".repeat(400)]) {
      const json = item([{ id: "expires", type: "DATE", label: "expires", value }]);
      assert.equal(parse1PasswordExpiry(json), null);
    }
  });

  it("matches expiry, expiration and valid until by label or id", () => {
    for (const label of ["expiry", "Expiration", "Valid until", "valid_until"]) {
      const json = item([{ id: "f", type: "DATE", label, value: "2031-05-06" }]);
      assert.equal(parse1PasswordExpiry(json), "2031-05-06T00:00:00.000Z", label);
    }
    const byId = item([{ id: "expires", type: "DATE", label: "When", value: "2031-05-06" }]);
    assert.equal(parse1PasswordExpiry(byId), "2031-05-06T00:00:00.000Z");
  });

  it("picks the earliest when several expiry DATE fields are present", () => {
    const json = item([
      { id: "a", type: "DATE", label: "expires", value: "2033-01-01" },
      { id: "b", type: "DATE", label: "valid until", value: "2031-01-01" },
    ]);
    assert.equal(parse1PasswordExpiry(json), "2031-01-01T00:00:00.000Z");
  });

  it("ignores DATE fields that do not name an expiry, and non-DATE expiry fields", () => {
    const json = item([
      { id: "created", type: "DATE", label: "issued on", value: "2020-01-01" },
      { id: "expires", type: "STRING", label: "expires", value: "2020-01-01" },
    ]);
    assert.equal(parse1PasswordExpiry(json), null);
  });

  it("treats empty, epoch-0 and unparseable values as no date", () => {
    for (const value of ["", "0", "soon", undefined]) {
      const json = item([{ id: "expires", type: "DATE", label: "expires", value }]);
      assert.equal(parse1PasswordExpiry(json), null, String(value));
    }
  });

  it("does not read a top-level expires key (1Password emits none)", () => {
    assert.equal(parse1PasswordExpiry(JSON.stringify({ expires: "2020-01-01" })), null);
    assert.equal(parse1PasswordExpiry("not json"), null);
  });
});

// End to end through a fake `op` on PATH. execFile("op") without a shell
// cannot run a script shim on Windows, so this half is POSIX only; the parser
// above carries the same shape on every platform.
describe(
  "checkSecretExpiration with a 1Password item (fake op)",
  {
    skip:
      process.platform === "win32"
        ? "a shebang op stub cannot be exec'd without a shell on Windows"
        : false,
  },
  () => {
    let dir = "";
    let savedPath: string | undefined;
    const governance: GovernanceConfig = {
      enabled: true,
      secrets: { check_expiration: true, warn_days_before_expiry: 30 },
    };
    const secrets: SecretsConfig = {
      store: "1password",
      keys: { STRIPE_SECRET_KEY: { source: "1password", ref: "op://Dev/stripe-api/credential" } },
    } as SecretsConfig;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), "kit-op-expiry-"));
      const out = join(dir, "item.json");
      writeFileSync(
        out,
        item([{ id: "expires", type: "DATE", label: "expires", value: "2020-01-01" }]),
      );
      const log = join(dir, "argv.log");
      writeFileSync(
        join(dir, "op"),
        `#!${process.execPath}\n` +
          `const fs = require("node:fs");\n` +
          `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
          `process.stdout.write(fs.readFileSync(${JSON.stringify(out)}, "utf8"));\n`,
        { mode: 0o755 },
      );
      savedPath = process.env.PATH;
      process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
      delete process.env.STRIPE_SECRET_KEY_EXPIRES_AT;
    });

    after(() => {
      process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
    });

    it("get1PasswordExpiration returns the DATE field's expiry", async () => {
      assert.equal(
        await get1PasswordExpiration("op://Dev/stripe-api/credential"),
        "2020-01-01T00:00:00.000Z",
      );
      const argv = readFileSync(join(dir, "argv.log"), "utf8").trim().split("\n").pop();
      assert.deepEqual(JSON.parse(argv ?? "[]"), [
        "item",
        "get",
        "stripe-api",
        "--vault",
        "Dev",
        "--format",
        "json",
      ]);
    });

    it("flags the key as expired", async () => {
      const result = await checkSecretExpiration(governance, ["STRIPE_SECRET_KEY"], secrets);
      assert.equal(result.length, 1);
      assert.equal(result[0]?.key, "STRIPE_SECRET_KEY");
      assert.equal(result[0]?.expired, true);
    });
  },
);
