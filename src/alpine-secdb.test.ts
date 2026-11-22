import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSecdb } from "./alpine-secdb.js";

describe("parseSecdb", () => {
  it("reads advisory identifiers by source package and fixed version", () => {
    assert.deepEqual(
      parseSecdb({
        packages: [{ pkg: { name: "expat", secfixes: { "2.10.0-r0": ["CVE-2026-117610"] } } }],
      }),
      new Map([["expat", new Map([["2.10.0-r0", ["CVE-2026-117610"]]])]]),
    );
  });

  it("rejects a scalar fix value instead of discarding the advisory", () => {
    assert.throws(
      () =>
        parseSecdb({
          packages: [{ pkg: { name: "expat", secfixes: { "2.10.0-r0": "CVE-2026-117610" } } }],
        }),
      /secdb:/,
    );
  });

  it("accepts an empty package list", () => {
    assert.deepEqual(parseSecdb({ packages: [] }), new Map());
  });

  it("accepts an empty fix map", () => {
    assert.deepEqual(
      parseSecdb({ packages: [{ pkg: { name: "expat", secfixes: {} } }] }),
      new Map([["expat", new Map()]]),
    );
  });

  it("omits empty identifier arrays so they cannot create advisory findings", () => {
    assert.deepEqual(
      parseSecdb({
        packages: [
          { pkg: { name: "empty", secfixes: { "2.0-r0": [] } } },
          {
            pkg: {
              name: "expat",
              secfixes: { "99.0-r0": [], "2.10.0-r0": ["CVE-2026-117610"] },
            },
          },
        ],
      }),
      new Map([
        ["empty", new Map()],
        ["expat", new Map([["2.10.0-r0", ["CVE-2026-117610"]]])],
      ]),
    );
  });
});

describe("parseSecdb (part 2)", () => {
  it("validates version strings even when their identifier arrays are empty", () => {
    for (const version of ["", "bad\nversion", "bad\u007fversion"]) {
      assert.throws(
        () => parseSecdb({ packages: [{ pkg: { name: "expat", secfixes: { [version]: [] } } }] }),
        /secdb:/,
      );
    }
  });

  it("merges distinct versions from repeated package records", () => {
    assert.deepEqual(
      parseSecdb({
        packages: [
          { pkg: { name: "expat", secfixes: { "2.9.0-r0": ["CVE-2026-102633"] } } },
          { pkg: { name: "other", secfixes: { "2.9.0-r0": ["OTHER-1"] } } },
          { pkg: { name: "expat", secfixes: { "2.10.0-r0": ["CVE-2026-117610"] } } },
        ],
      }),
      new Map([
        [
          "expat",
          new Map([
            ["2.9.0-r0", ["CVE-2026-102633"]],
            ["2.10.0-r0", ["CVE-2026-117610"]],
          ]),
        ],
        ["other", new Map([["2.9.0-r0", ["OTHER-1"]]])],
      ]),
    );
  });

  it("unions identifiers within arrays and across repeated package versions", () => {
    assert.deepEqual(
      parseSecdb({
        packages: [
          {
            pkg: {
              name: "expat",
              secfixes: { "2.10.0-r0": ["CVE-2026-117610", "CVE-2026-117610", "GHSA-test"] },
            },
          },
          {
            pkg: {
              name: "expat",
              secfixes: { "2.10.0-r0": ["GHSA-test", "XSA-999", "XSA-999"] },
            },
          },
        ],
      }),
      new Map([["expat", new Map([["2.10.0-r0", ["CVE-2026-117610", "GHSA-test", "XSA-999"]]])]]),
    );
  });
});

describe("parseSecdb (part 3)", () => {
  it("keeps fixes when duplicate records contain empty maps or identifier arrays", () => {
    const records = [
      { pkg: { name: "expat", secfixes: { "2.10.0-r0": ["CVE-2026-117610"] } } },
      { pkg: { name: "expat", secfixes: {} } },
      { pkg: { name: "expat", secfixes: { "2.10.0-r0": [], "99.0-r0": [] } } },
    ];
    for (const packages of [records, [...records].reverse()]) {
      assert.deepEqual(
        parseSecdb({ packages }),
        new Map([["expat", new Map([["2.10.0-r0", ["CVE-2026-117610"]]])]]),
      );
    }
  });

  it("preserves advisory families and combined identifiers without format restrictions", () => {
    assert.deepEqual(
      parseSecdb({
        packages: [
          {
            pkg: {
              name: "source-package",
              secfixes: {
                "0": ["GHSA-xxxx-yyyy-zzzz"],
                "1.2.3": [
                  "CVE-2026-12345 XSA-999",
                  "VENDOR: advisory 42",
                  "\u00e5\u00e4\u00f6",
                  " A B ",
                ],
              },
            },
          },
        ],
      }),
      new Map([
        [
          "source-package",
          new Map([
            ["0", ["GHSA-xxxx-yyyy-zzzz"]],
            [
              "1.2.3",
              ["CVE-2026-12345 XSA-999", "VENDOR: advisory 42", "\u00e5\u00e4\u00f6", " A B "],
            ],
          ]),
        ],
      ]),
    );
  });
});

describe("parseSecdb (part 4)", () => {
  it("allows additive fields and does not require unused producer metadata", () => {
    assert.deepEqual(
      parseSecdb({
        futureRoot: { values: [null, 42] },
        packages: [
          {
            futureRow: true,
            pkg: {
              name: "expat",
              futurePackage: ["extension"],
              secfixes: { "2.10.0-r0": ["CVE-2026-117610"] },
            },
          },
        ],
      }),
      new Map([["expat", new Map([["2.10.0-r0", ["CVE-2026-117610"]]])]]),
    );
  });

  it("treats prototype property names as ordinary package and version keys", () => {
    const json: unknown = JSON.parse(
      '{"packages":[{"pkg":{"name":"__proto__","secfixes":{"__proto__":["ID-1"],"constructor":["ID-2"]}}}]}',
    );
    assert.deepEqual(
      parseSecdb(json),
      new Map([
        [
          "__proto__",
          new Map([
            ["__proto__", ["ID-1"]],
            ["constructor", ["ID-2"]],
          ]),
        ],
      ]),
    );
  });

  for (const field of ["name", "version", "identifier"]) {
    const feed = (value: string) => ({
      packages: [
        {
          pkg: {
            name: field === "name" ? value : "expat",
            secfixes: {
              [field === "version" ? value : "2.10.0-r0"]: [
                field === "identifier" ? value : "CVE-2026-117610",
              ],
            },
          },
        },
      ],
    });

    it(`rejects an empty ${field}`, () => {
      assert.throws(() => parseSecdb(feed("")), /secdb:/);
    });

    it(`rejects every ASCII control character in a ${field}`, () => {
      const codes = [...Array.from({ length: 32 }, (_, code) => code), 127];
      for (const code of codes) {
        assert.throws(
          () => parseSecdb(feed(`before${String.fromCharCode(code)}after`)),
          /secdb:/,
          `ASCII control character ${code}`,
        );
      }
    });

    it(`rejects every C1 control character in a ${field}, like CSI (U+009B)`, () => {
      for (let code = 0x80; code <= 0x9f; code++) {
        assert.throws(
          () => parseSecdb(feed(`before${String.fromCharCode(code)}after`)),
          /secdb:/,
          `C1 control character ${code}`,
        );
      }
    });
  }
});

const nonObjects: [string, unknown][] = [
  ["missing", undefined],
  ["null", null],
  ["array", []],
  ["string", "data"],
  ["number", 42],
  ["boolean", false],
];

function assertRejectedRecord(record: unknown): void {
  const valid = {
    pkg: { name: "expat", secfixes: { "2.10.0-r0": ["CVE-2026-117610"] } },
  };
  for (const packages of [[record], [valid, record], [record, valid]]) {
    assert.throws(() => parseSecdb({ packages }), /secdb:/);
  }
}

describe("parseSecdb schema", () => {
  for (const [label, value] of nonObjects) {
    it(`rejects a ${label} root`, () => {
      assert.throws(() => parseSecdb(value), /secdb:/);
    });

    it(`rejects a ${label} package row even beside a valid row`, () => {
      assertRejectedRecord(value);
    });

    it(`rejects a ${label} pkg even beside a valid row`, () => {
      assertRejectedRecord({ pkg: value });
    });

    it(`rejects ${label} secfixes even in a duplicate package record`, () => {
      assertRejectedRecord({ pkg: { name: "expat", secfixes: value } });
    });
  }

  for (const [label, value] of [
    ["missing", undefined],
    ["null", null],
    ["object", {}],
    ["string", "data"],
    ["number", 42],
    ["boolean", false],
  ] satisfies [string, unknown][]) {
    it(`rejects a ${label} packages list`, () => {
      assert.throws(() => parseSecdb({ packages: value }), /secdb:/);
    });

    it(`rejects a ${label} fix value even in a duplicate package record`, () => {
      assertRejectedRecord({ pkg: { name: "expat", secfixes: { "2.10.0-r0": value } } });
    });
  }

  for (const [label, value] of [
    ["missing", undefined],
    ["null", null],
    ["array", []],
    ["object", {}],
    ["number", 42],
    ["boolean", false],
  ] satisfies [string, unknown][]) {
    it(`rejects a ${label} name even when secfixes is empty`, () => {
      assertRejectedRecord({ pkg: { name: value, secfixes: {} } });
    });

    it(`rejects a ${label} identifier without filtering the array`, () => {
      for (const ids of [[value], ["CVE-2026-117610", value], [value, "CVE-2026-117610"]]) {
        assertRejectedRecord({ pkg: { name: "expat", secfixes: { "2.10.0-r0": ids } } });
      }
    });
  }
});

describe("parseSecdb schema (part 2)", () => {
  it("rejects records that omit required properties", () => {
    assert.throws(() => parseSecdb({}), /secdb:/);
    for (const record of [{}, { pkg: {} }, { pkg: { name: "expat" } }, { pkg: { secfixes: {} } }]) {
      assertRejectedRecord(record);
    }
  });

  it("rejects malformed versions before or after a valid version", () => {
    for (const secfixes of [
      { "2.9.0-r0": ["CVE-2026-102633"], "2.10.0-r0": null },
      { "2.10.0-r0": null, "2.9.0-r0": ["CVE-2026-102633"] },
    ]) {
      assertRejectedRecord({ pkg: { name: "expat", secfixes } });
    }
  });

  it("rejects invalid strings in duplicate records instead of returning earlier fixes", () => {
    for (const value of ["", "bad\ntext", "bad\u007ftext"]) {
      assertRejectedRecord({ pkg: { name: value, secfixes: {} } });
      assertRejectedRecord({ pkg: { name: "expat", secfixes: { [value]: [] } } });
      assertRejectedRecord({ pkg: { name: "expat", secfixes: { "2.10.0-r0": [value] } } });
    }
  });

  it("rejects arrays with object properties at object locations", () => {
    const pkg = { name: "expat", secfixes: {} };
    assert.throws(() => parseSecdb(Object.assign([], { packages: [] })), /secdb:/);
    assertRejectedRecord(Object.assign([], { pkg }));
    assertRejectedRecord({ pkg: Object.assign([], pkg) });
    assertRejectedRecord({ pkg: { name: "expat", secfixes: Object.assign([], { "2.0": [] }) } });
  });

  it("rejects sparse arrays instead of skipping missing records or identifiers", () => {
    assert.throws(() => parseSecdb({ packages: new Array(1) }), /secdb:/);
    assertRejectedRecord({ pkg: { name: "expat", secfixes: { "2.10.0-r0": new Array(1) } } });
  });
});
