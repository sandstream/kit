import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UPSTREAM_CATALOG_DATA } from "./upstream-catalog-data.js";
import {
  mergeUpstreamCatalog,
  parseUpstreamTable,
  validateUpstreamCatalog,
} from "./upstream-catalog.js";

describe("built-in upstream catalog", () => {
  it("passes its own schema check", () => {
    const catalog = validateUpstreamCatalog(UPSTREAM_CATALOG_DATA);
    assert.ok(catalog.length >= 3);
  });

  it("maps convex, stripe and workos to npm and GitHub sources", () => {
    const byId = new Map(validateUpstreamCatalog(UPSTREAM_CATALOG_DATA).map((e) => [e.id, e]));
    assert.ok(byId.get("convex")?.npm.includes("convex"));
    assert.ok(byId.get("stripe")?.github.includes("stripe/stripe-node"));
    assert.ok(byId.get("workos")?.npm.includes("@workos-inc/node"));
  });
});

describe("validateUpstreamCatalog", () => {
  const ok = { id: "a", label: "A", npm: ["a"], github: ["o/r"], kitServices: [] };

  it("rejects a duplicate id", () => {
    assert.throws(() => validateUpstreamCatalog([ok, ok]), /duplicate.*"a"/i);
  });

  it("rejects an entry with no release source", () => {
    assert.throws(
      () => validateUpstreamCatalog([{ ...ok, npm: [], github: [] }]),
      /needs at least one npm package or GitHub repo/,
    );
  });

  it("rejects a GitHub repo that is not owner/name", () => {
    assert.throws(
      () => validateUpstreamCatalog([{ ...ok, github: ["https://github.com/o/r"] }]),
      /owner\/name/,
    );
  });

  it("rejects an unknown key so a typo cannot pass silently", () => {
    assert.throws(
      () => validateUpstreamCatalog([{ ...ok, gitub: ["o/r"] }]),
      /unknown key "gitub"/,
    );
  });

  it("rejects a non-array catalog", () => {
    assert.throws(() => validateUpstreamCatalog({}), /must be an array/);
  });
});

describe("parseUpstreamTable", () => {
  it("returns nothing when [upstream] is absent", () => {
    assert.deepEqual(parseUpstreamTable(undefined), []);
  });

  it("reads add and override rows", () => {
    const rows = parseUpstreamTable({
      convex: { npm: ["convex", "@convex-dev/eslint-plugin"] },
      acme: { label: "Acme", npm: ["acme-sdk"], github: ["acme/acme-js"] },
      stripe: { disabled: true },
    });
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.find((r) => r.id === "stripe"),
      { id: "stripe", disabled: true },
    );
  });

  it("rejects a row that is not a table", () => {
    assert.throws(
      () => parseUpstreamTable({ convex: "latest" }),
      /\[upstream\.convex\] must be a table/,
    );
  });

  it("rejects an unknown key", () => {
    assert.throws(() => parseUpstreamTable({ convex: { pin: "1.0.0" } }), /unknown key "pin"/);
  });

  it("rejects a bad GitHub repo", () => {
    assert.throws(() => parseUpstreamTable({ x: { github: ["nope"] } }), /owner\/name/);
  });

  it("rejects a new service that has no source", () => {
    assert.throws(
      () => mergeUpstreamCatalog([], parseUpstreamTable({ x: { label: "X" } })),
      /needs at least one npm package or GitHub repo/,
    );
  });
});

describe("mergeUpstreamCatalog", () => {
  const base = validateUpstreamCatalog([
    {
      id: "convex",
      label: "Convex",
      npm: ["convex"],
      github: ["convex/convex-js"],
      kitServices: [],
    },
    {
      id: "stripe",
      label: "Stripe",
      npm: ["stripe"],
      github: ["stripe/stripe-node"],
      kitServices: [],
    },
  ]);

  it("replaces the listed sources of an existing entry", () => {
    const merged = mergeUpstreamCatalog(
      base,
      parseUpstreamTable({ convex: { npm: ["convex", "x"] } }),
    );
    const convex = merged.find((e) => e.id === "convex");
    assert.deepEqual(convex?.npm, ["convex", "x"]);
    assert.deepEqual(convex?.github, ["convex/convex-js"]);
  });

  it("adds a new service", () => {
    const merged = mergeUpstreamCatalog(base, parseUpstreamTable({ acme: { npm: ["acme-sdk"] } }));
    assert.equal(merged.find((e) => e.id === "acme")?.label, "acme");
  });

  it("drops a disabled service", () => {
    const merged = mergeUpstreamCatalog(base, parseUpstreamTable({ stripe: { disabled: true } }));
    assert.deepEqual(
      merged.map((e) => e.id),
      ["convex"],
    );
  });

  it("does not mutate the built-in catalog", () => {
    const before = JSON.stringify(base);
    mergeUpstreamCatalog(
      base,
      parseUpstreamTable({ convex: { npm: ["z"] }, stripe: { disabled: true } }),
    );
    assert.equal(JSON.stringify(base), before);
  });
});

describe("control characters in an untrusted [upstream] table", () => {
  const ESC = String.fromCharCode(27);

  it("rejects them in a label, a package name and a service key", () => {
    assert.throws(
      () => parseUpstreamTable({ acme: { label: `A${ESC}[2J`, npm: ["a"] } }),
      /control characters/,
    );
    assert.throws(
      () => parseUpstreamTable({ acme: { npm: [`a${ESC}[2J`] } }),
      /control characters/,
    );
    assert.throws(
      () => parseUpstreamTable({ acme: { kitServices: [`a${ESC}`] } }),
      /control characters/,
    );
  });

  it("keeps the raw key out of the error message", () => {
    try {
      parseUpstreamTable({ [`bad${ESC}[2Jkey`]: { npm: ["a"] } });
      assert.fail("must reject");
    } catch (err) {
      assert.ok(!(err as Error).message.includes(ESC));
    }
  });

  it("rejects them in the built-in catalog shape too", () => {
    const row = { id: "a", label: `A${ESC}`, npm: ["a"], github: [], kitServices: [] };
    assert.throws(() => validateUpstreamCatalog([row]), /control characters/);
  });
});
