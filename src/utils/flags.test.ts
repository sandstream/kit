import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasFlag,
  flagValue,
  flagInt,
  unknownFlags,
  GLOBAL_FLAGS,
  splitLeadingGlobalFlags,
} from "./flags.js";

describe("flag helpers", () => {
  describe("hasFlag", () => {
    it("detects a present flag", () => {
      assert.equal(hasFlag(["a", "--json", "b"], "--json"), true);
    });
    it("returns false when absent", () => {
      assert.equal(hasFlag(["a", "b"], "--json"), false);
    });
    it("matches any of several aliases", () => {
      assert.equal(hasFlag(["-y"], "--yes", "-y"), true);
      assert.equal(hasFlag(["--yes"], "--yes", "-y"), true);
      assert.equal(hasFlag(["--no"], "--yes", "-y"), false);
    });
  });

  describe("flagValue", () => {
    it("reads space-separated --flag value", () => {
      assert.equal(flagValue(["--service", "vercel"], "--service"), "vercel");
    });
    it("reads --flag=value form", () => {
      assert.equal(flagValue(["--service=vercel"], "--service"), "vercel");
    });
    it("returns undefined when absent", () => {
      assert.equal(flagValue(["--other", "x"], "--service"), undefined);
    });
    it("returns undefined when flag is the final token", () => {
      assert.equal(flagValue(["a", "--service"], "--service"), undefined);
    });
    it("inline form wins and preserves '=' in the value", () => {
      assert.equal(flagValue(["--kv=a=b"], "--kv"), "a=b");
    });
  });

  describe("flagInt", () => {
    it("parses an integer value", () => {
      assert.equal(flagInt(["--ttl-minutes", "30"], "--ttl-minutes", 5), 30);
    });
    it("falls back when absent", () => {
      assert.equal(flagInt([], "--ttl-minutes", 5), 5);
    });
    it("falls back when non-numeric", () => {
      assert.equal(flagInt(["--ttl-minutes", "soon"], "--ttl-minutes", 5), 5);
    });
  });
});

describe("unknownFlags", () => {
  it("returns nothing when every flag is allowed", () => {
    assert.deepEqual(
      unknownFlags(["kit", "check", "--json", "--strict"], ["--json", "--strict"]),
      [],
    );
  });

  it("reports a flag that is not allowed", () => {
    assert.deepEqual(unknownFlags(["kit", "check", "--category", "security"], ["--json"]), [
      "--category",
    ]);
  });

  it("compares the flag part of --flag=value", () => {
    assert.deepEqual(unknownFlags(["--category=security"], ["--json"]), ["--category"]);
    assert.deepEqual(unknownFlags(["--json=1"], ["--json"]), []);
  });

  it("ignores everything after a bare --", () => {
    assert.deepEqual(unknownFlags(["--json", "--", "--not-mine"], ["--json"]), []);
  });

  it("does not inspect short flags", () => {
    assert.deepEqual(unknownFlags(["-v", "-x"], []), []);
  });

  it("reports each unknown flag once", () => {
    assert.deepEqual(unknownFlags(["--nope", "--nope"], []), ["--nope"]);
  });

  it("ignores non-flag tokens including values that look like paths", () => {
    assert.deepEqual(unknownFlags(["compare", "a.json", "b.json"], []), []);
  });
});

describe("flagInt — boundaries and malformed input", () => {
  it("reads the --flag=value form as well as the space-separated one", () => {
    assert.equal(flagInt(["--ttl-minutes=30"], "--ttl-minutes", 5), 30);
  });

  it("returns 0 for an explicit 0 rather than treating it as absent", () => {
    // 0 is falsy: a `parsed || fallback` refactor would silently turn
    // `--retries 0` back into the default and retry when the caller said don't.
    assert.equal(flagInt(["--retries", "0"], "--retries", 3), 0);
  });

  it("falls back when the value is empty", () => {
    // `--ttl-minutes=` yields "" from flagValue, not undefined, so the
    // NaN guard is the only thing keeping this off the fallback path.
    assert.equal(flagInt(["--ttl-minutes="], "--ttl-minutes", 5), 5);
  });

  it("falls back when the flag is the last token with no value", () => {
    assert.equal(flagInt(["kit", "audit", "--ttl-minutes"], "--ttl-minutes", 5), 5);
  });

  it("falls back when the next token is another flag instead of a number", () => {
    // Guards against `--ttl-minutes --json` consuming "--json" as its value.
    assert.equal(flagInt(["--ttl-minutes", "--json"], "--ttl-minutes", 5), 5);
    assert.equal(flagInt(["--ttl-minutes", "--json"], "--json", 7), 7);
  });

  it("does not match a flag whose name merely starts with the requested one", () => {
    // A prefix match here would make `--ttl-minutes 30` answer a query for `--ttl`.
    assert.equal(flagInt(["--ttl-minutes", "30"], "--ttl", 5), 5);
    assert.equal(flagInt(["--ttl-minutes=30"], "--ttl", 5), 5);
  });

  it("accepts negative values without clamping them", () => {
    // Documented as-is: there is no lower bound, so callers using the result as a
    // count or TTL must range-check it themselves.
    assert.equal(flagInt(["--ttl-minutes", "-1"], "--ttl-minutes", 5), -1);
  });

  it("truncates rather than rejecting a decimal, and ignores trailing garbage", () => {
    // parseInt semantics: partial parses succeed. "2.9" and "30abc" are accepted
    // as 2 and 30 instead of falling back, which hides typo'd values.
    assert.equal(flagInt(["--ttl-minutes", "2.9"], "--ttl-minutes", 5), 2);
    assert.equal(flagInt(["--ttl-minutes", "30abc"], "--ttl-minutes", 5), 30);
  });

  it("reads exponent and hex spellings as their radix-10 prefix", () => {
    // radix 10 means "1e3" is 1 (not 1000) and "0x10" is 0 (not 16) — silently
    // wrong values rather than a fallback.
    assert.equal(flagInt(["--ttl-minutes", "1e3"], "--ttl-minutes", 5), 1);
    assert.equal(flagInt(["--ttl-minutes", "0x10"], "--ttl-minutes", 5), 0);
    // "Infinity" has no digit prefix at all, so it does fall back.
    assert.equal(flagInt(["--ttl-minutes", "Infinity"], "--ttl-minutes", 5), 5);
  });

  it("takes the first occurrence of a repeated space-separated flag", () => {
    assert.equal(flagInt(["--ttl-minutes", "1", "--ttl-minutes", "2"], "--ttl-minutes", 5), 1);
  });

  it("prefers an inline value even when a space-separated one comes first", () => {
    // flagValue scans for `name=` before consulting indexOf, so the inline form
    // wins on position-independent precedence.
    assert.equal(flagInt(["--ttl-minutes", "9", "--ttl-minutes=3"], "--ttl-minutes", 5), 3);
  });

  it("does not stop at a bare -- the way unknownFlags does", () => {
    // flagInt has no pass-through boundary: a value after `--` is still read.
    assert.equal(flagInt(["--", "--ttl-minutes", "30"], "--ttl-minutes", 5), 30);
  });
});

describe("GLOBAL_FLAGS", () => {
  /**
   * The ORACLE is docs/COMMANDS.md's "Global flags" table, not a second copy of
   * the list: `kit check --read-only` shipped broken precisely because the only
   * thing asserting the allowlist was the allowlist. If a global is documented,
   * a command allowlist must accept it.
   */
  function documentedGlobals(): string[] {
    const root = resolve(import.meta.dirname, "..", "..");
    const doc = readFileSync(resolve(root, "docs", "COMMANDS.md"), "utf-8");
    const start = doc.indexOf("## Global flags");
    assert.ok(start >= 0, "docs/COMMANDS.md no longer has a '## Global flags' section");
    const section = doc.slice(start, doc.indexOf("\n## ", start + 1));
    const flags = new Set<string>();
    for (const m of section.matchAll(/`(--[a-z][a-z0-9-]*)`/g)) flags.add(m[1]);
    return [...flags];
  }

  it("the oracle itself finds something (a regex that matches nothing reads as full coverage)", () => {
    const found = documentedGlobals();
    assert.ok(found.length >= 4, `the docs scan found only ${found.length} global flags`);
    assert.ok(found.includes("--read-only"), "expected the scan to see --read-only");
  });

  it("every flag documented as global is in GLOBAL_FLAGS", () => {
    const allowed = new Set<string>(GLOBAL_FLAGS);
    const missing = documentedGlobals().filter((f) => !allowed.has(f));
    assert.deepEqual(missing, [], `documented as global but rejectable by a command: ${missing}`);
  });

  it("includes --env, which config.ts honors globally off raw argv", () => {
    // resolveActiveEnvironment() reads `--env=<name>` from process.argv for every
    // command, so a command allowlist that omits it rejects a working flag.
    assert.ok((GLOBAL_FLAGS as readonly string[]).includes("--env"));
  });
});

describe("splitLeadingGlobalFlags", () => {
  it("moves a leading global off the front so the command word is positional 0", () => {
    const { leading, rest } = splitLeadingGlobalFlags(["--read-only", "check"]);
    assert.deepEqual(leading, ["--read-only"]);
    assert.deepEqual(rest, ["check"]);
  });

  it("preserves subcommand positions (the reason raw argv indices break)", () => {
    const { rest } = splitLeadingGlobalFlags(["--read-only", "check", "verify-attestation"]);
    // commands/check.ts reads process.argv[3] === "verify-attestation"
    assert.equal(rest[1], "verify-attestation");
  });

  it("takes several leading globals, including --env=<name>", () => {
    const { leading, rest } = splitLeadingGlobalFlags([
      "--non-interactive",
      "--env=prod",
      "secrets",
    ]);
    assert.deepEqual(leading, ["--non-interactive", "--env=prod"]);
    assert.deepEqual(rest, ["secrets"]);
  });

  it("stops at the command word — a global AFTER it is the command's to see", () => {
    const { leading, rest } = splitLeadingGlobalFlags(["check", "--read-only"]);
    assert.deepEqual(leading, []);
    assert.deepEqual(rest, ["check", "--read-only"]);
  });

  it("leaves --version / --help alone: as token 0 they ARE the command", () => {
    assert.deepEqual(splitLeadingGlobalFlags(["--version"]).rest, ["--version"]);
    assert.deepEqual(splitLeadingGlobalFlags(["--help"]).rest, ["--help"]);
  });

  it("does not eat a command-specific flag it has never heard of", () => {
    const { leading, rest } = splitLeadingGlobalFlags(["--nope", "check"]);
    assert.deepEqual(leading, []);
    assert.deepEqual(rest, ["--nope", "check"]);
  });
});
