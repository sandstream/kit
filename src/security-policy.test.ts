import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initAllowlist,
  checkAllowlist,
  addToAllowlist,
  readAllowlist,
  checkSecretPolicy,
  type Allowlist,
} from "./security-policy.js";

function makeProject(deps: Record<string, string>, dev: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-policy-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "t", dependencies: deps, devDependencies: dev }, null, 2),
  );
  return dir;
}

describe("initAllowlist", () => {
  it("seeds the allowlist from package.json", async () => {
    const dir = makeProject({ next: "^15.0.0", stripe: "14.0.0" }, { vitest: "^1.0.0" });
    const list = await initAllowlist(dir);
    assert.equal(list.packages.length, 3);
    const next = list.packages.find((p) => p.name === "next");
    assert.equal(next?.range, "^15.0.0");
    assert.equal(next?.reason, "runtime");
    const vitest = list.packages.find((p) => p.name === "vitest");
    assert.equal(vitest?.reason, "dev");
    assert.ok(existsSync(join(dir, ".kit-allowlist.json")));
  });

  it("writes well-formed JSON we can re-read", async () => {
    const dir = makeProject({ react: "^19.0.0" });
    await initAllowlist(dir);
    const round = await readAllowlist(dir);
    assert.ok(round);
    assert.equal(round.packages[0].name, "react");
  });
});

describe("checkAllowlist", () => {
  it("passes when every dep is listed", async () => {
    const dir = makeProject({ next: "^15.0.0" });
    await initAllowlist(dir);
    const { violations } = await checkAllowlist(dir);
    assert.equal(violations.length, 0);
  });

  it("flags runtime deps not on the allowlist", async () => {
    const dir = makeProject({ next: "^15.0.0" });
    await initAllowlist(dir);
    // Add a new dependency directly to package.json without updating the allowlist.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        { name: "t", dependencies: { next: "^15.0.0", "evil-pkg": "1.0.0" } },
        null,
        2,
      ),
    );
    const { violations } = await checkAllowlist(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].name, "evil-pkg");
    assert.equal(violations[0].reason, "not-on-allowlist");
  });

  it("does NOT flag dev deps when enforce_dev=false (default)", async () => {
    const dir = makeProject({ next: "^15.0.0" }, { rogue: "1.0.0" });
    await initAllowlist(dir);
    // remove rogue from allowlist to simulate the unlisted case
    const list = await readAllowlist(dir);
    list!.packages = list!.packages.filter((p) => p.name !== "rogue");
    writeFileSync(
      join(dir, ".kit-allowlist.json"),
      JSON.stringify(list, null, 2),
    );
    const { violations } = await checkAllowlist(dir);
    assert.equal(violations.length, 0);
  });

  it("blocks wildcard ranges when allow_wildcards=false", async () => {
    const dir = makeProject({ "anything-goes": "*" });
    await initAllowlist(dir);
    const { violations } = await checkAllowlist(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].reason, "wildcard-blocked");
  });

  it("returns no violations when allowlist is absent", async () => {
    const dir = makeProject({ next: "^15.0.0" });
    const { list, violations } = await checkAllowlist(dir);
    assert.equal(list, null);
    assert.equal(violations.length, 0);
  });
});

describe("checkSecretPolicy", () => {
  const baseList: Allowlist = {
    policy: { enforce_runtime: true, enforce_dev: false, allow_wildcards: false },
    packages: [],
  };

  it("returns no violations when enforce_secrets=false and there are no entries", () => {
    const violations = checkSecretPolicy(baseList, ["STRIPE_SECRET_KEY"]);
    assert.equal(violations.length, 0);
  });

  it("flags missing entries when enforce_secrets=true", () => {
    const list: Allowlist = {
      ...baseList,
      policy: { ...baseList.policy, enforce_secrets: true },
    };
    const violations = checkSecretPolicy(list, ["STRIPE_SECRET_KEY"]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].reason, "no-policy-entry");
  });

  it("requires spend_cap for paid services", () => {
    const list: Allowlist = {
      ...baseList,
      secrets: { STRIPE_SECRET_KEY: { scope: "read" } },
    };
    const violations = checkSecretPolicy(list, ["STRIPE_SECRET_KEY"]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].reason, "no-spend-cap");
  });

  it("accepts default_spend_cap as fallback", () => {
    const list: Allowlist = {
      ...baseList,
      policy: { ...baseList.policy, default_spend_cap_usd: 100 },
      secrets: { STRIPE_SECRET_KEY: { scope: "read" } },
    };
    const violations = checkSecretPolicy(list, ["STRIPE_SECRET_KEY"]);
    assert.equal(violations.length, 0);
  });

  it("requires a scope or require_restricted", () => {
    const list: Allowlist = {
      ...baseList,
      secrets: { OPENAI_API_KEY: { spend_cap_usd: 50 } },
    };
    const violations = checkSecretPolicy(list, ["OPENAI_API_KEY"]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].reason, "no-scope");
  });

  it("require_restricted satisfies the scope requirement", () => {
    const list: Allowlist = {
      ...baseList,
      secrets: { STRIPE_SECRET_KEY: { spend_cap_usd: 50, require_restricted: true } },
    };
    const violations = checkSecretPolicy(list, ["STRIPE_SECRET_KEY"]);
    assert.equal(violations.length, 0);
  });

  it("rejects TTL longer than 32d (768h)", () => {
    const list: Allowlist = {
      ...baseList,
      secrets: {
        STRIPE_SECRET_KEY: { spend_cap_usd: 50, scope: "read", max_ttl_hours: 1000 },
      },
    };
    const violations = checkSecretPolicy(list, ["STRIPE_SECRET_KEY"]);
    assert.ok(violations.some((v) => v.reason === "ttl-too-long"));
  });
});

describe("addToAllowlist", () => {
  it("adds a package present in package.json", async () => {
    const dir = makeProject({ next: "^15.0.0" });
    await initAllowlist(dir);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        { name: "t", dependencies: { next: "^15.0.0", "@supabase/supabase-js": "2.0.0" } },
        null,
        2,
      ),
    );
    const result = await addToAllowlist("@supabase/supabase-js", dir);
    assert.equal(result.added, true);
    assert.equal(result.entry?.range, "2.0.0");
    const list = await readAllowlist(dir);
    assert.ok(list?.packages.find((p) => p.name === "@supabase/supabase-js"));
  });

  it("is a no-op when the package is already on the allowlist", async () => {
    const dir = makeProject({ next: "^15.0.0" });
    await initAllowlist(dir);
    const result = await addToAllowlist("next", dir);
    assert.equal(result.added, false);
    assert.equal(result.entry?.name, "next");
  });
});
