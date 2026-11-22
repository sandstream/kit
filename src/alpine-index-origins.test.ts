import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeApkIndexOrigins, parseApkIndexOrigins } from "./alpine-index-origins.js";

describe("parseApkIndexOrigins", () => {
  it("projects a complete record to its known source package", () => {
    assert.deepEqual(
      parseApkIndexOrigins("P:libexpat\nV:2.10.0-r0\no:expat\n\n"),
      new Map([["libexpat", "expat"]]),
    );
  });

  it("rejects a record without a version instead of projecting partial data", () => {
    assert.throws(() => parseApkIndexOrigins("P:libexpat\no:expat\n\n"), /APKINDEX:/);
  });

  it("accepts empty and LF-only indexes", () => {
    for (const text of ["", "\n", "\n\n\n"]) {
      assert.deepEqual(parseApkIndexOrigins(text), new Map());
    }
  });

  it("accepts a final complete record with one LF or blank separators", () => {
    for (const text of ["P:a\nV:1\no:src\n", "\n\nP:a\nV:1\no:src\n\n\n"]) {
      assert.deepEqual(parseApkIndexOrigins(text), new Map([["a", "src"]]));
    }
  });

  it("rejects a nonempty index without final LF", () => {
    for (const text of ["P:a\nV:1\no:src", "P:a\nV:1\no:src\n\nP:b\nV:2\no:other"]) {
      assert.throws(() => parseApkIndexOrigins(text), /APKINDEX:/);
    }
  });

  it("represents missing and empty origins explicitly without assuming self-origin", () => {
    for (const text of ["P:a\nV:1\n", "P:a\nV:1\no:\n"]) {
      assert.deepEqual(parseApkIndexOrigins(text), new Map([["a", ""]]));
    }
  });

  it("validates the origin projection without requiring full APK installability", () => {
    assert.deepEqual(
      parseApkIndexOrigins("o:Source_Name+1.2-3\nV:opaque-version\nP:Binary_Name+1.2-3\n"),
      new Map([["Binary_Name+1.2-3", "Source_Name+1.2-3"]]),
    );
  });
});

describe("parseApkIndexOrigins (part 2)", () => {
  it("allows additive metadata, empty descriptions, repeated extras, and colons in values", () => {
    assert.deepEqual(
      parseApkIndexOrigins(
        "P:a\nT:\nV:1\nx:one\nx:two\n9:future\nU:https://example.test/\no:src\n",
      ),
      new Map([["a", "src"]]),
    );
  });

  for (const [label, record] of [
    ["missing P", "V:1\no:src\n"],
    ["empty P", "P:\nV:1\no:src\n"],
    ["empty V", "P:a\nV:\no:src\n"],
    ["metadata only", "T:description\n"],
    ["missing separator", "P:a\nV:1\no:src\nP:b\nV:2\no:other\n"],
    ["bare text", "garbage\nP:a\nV:1\no:src\n"],
    ["short line", "P:a\nV:1\no:src\nx\n"],
    ["long key", "P:a\nV:1\no:src\nXX:value\n"],
    ["missing key", "P:a\nV:1\no:src\n:value\n"],
    ["missing colon", "P:a\nV:1\no:src\nX value\n"],
    ["space separator", "P:a\nV:1\no:src\n \n"],
    ["CRLF", "P:a\r\nV:1\r\no:src\r\n"],
  ]) {
    it(`rejects ${label} without returning an earlier valid record`, () => {
      const valid = "P:good\nV:1\no:source\n\n";
      for (const text of [record, valid + record, record + "\n" + valid]) {
        assert.throws(() => parseApkIndexOrigins(text), /APKINDEX:/);
      }
    });
  }

  for (const field of ["P", "V", "o"]) {
    it(`rejects repeated ${field} fields even when values match`, () => {
      const value = field === "P" ? "a" : field === "V" ? "1" : "src";
      for (const duplicate of [value, "other", ""]) {
        assert.throws(
          () => parseApkIndexOrigins(`P:a\nV:1\no:src\n${field}:${duplicate}\n`),
          /APKINDEX:/,
        );
      }
    });
  }

  for (const field of ["P", "o"]) {
    it(`requires Alpine package-name syntax in ${field}`, () => {
      for (const value of [" a", "a ", "a b", "-a", ".a", "_a", "+a", "a/b", "a:b", "\u00e5"]) {
        const text = field === "P" ? `P:${value}\nV:1\no:src\n` : `P:a\nV:1\no:${value}\n`;
        assert.throws(() => parseApkIndexOrigins(text), /APKINDEX:/, value);
      }
    });
  }
});

describe("parseApkIndexOrigins (part 3)", () => {
  it("rejects control characters in scalar and additive metadata fields", () => {
    const codes = [
      ...Array.from({ length: 32 }, (_, code) => code).filter((code) => code !== 10),
      ...Array.from({ length: 33 }, (_, code) => code + 127),
    ];
    for (const code of codes) {
      for (const field of ["P", "V", "o", "T", "x"]) {
        const lines = ["P:a", "V:1", "o:src", "T:description", "x:extension"];
        const text = lines
          .map((line) => (line.startsWith(`${field}:`) ? line + String.fromCharCode(code) : line))
          .join("\n");
        assert.throws(() => parseApkIndexOrigins(text + "\n"), /APKINDEX:/, `${field}: ${code}`);
      }
    }
  });

  it("merges versions with the same known origin and keeps other package names separate", () => {
    assert.deepEqual(
      parseApkIndexOrigins("P:a\nV:1\no:src\n\nP:b\nV:1\no:other\n\nP:a\nV:2\no:src\n"),
      new Map([
        ["a", "src"],
        ["b", "other"],
      ]),
    );
  });

  it("keeps different known origins unresolved in either order", () => {
    for (const records of [
      ["P:a\nV:1\no:src\n", "P:a\nV:2\no:other\n"],
      ["P:a\nV:2\no:other\n", "P:a\nV:1\no:src\n"],
    ]) {
      assert.deepEqual(parseApkIndexOrigins(records.join("\n")), new Map([["a", ""]]));
    }
  });

  it("keeps any missing or empty origin unresolved beside known records", () => {
    const known = "P:a\nV:1\no:src\n";
    for (const unknown of ["P:a\nV:2\n", "P:a\nV:2\no:\n"]) {
      for (const records of [
        [unknown, known],
        [known, unknown],
        [unknown, known, unknown],
      ]) {
        assert.deepEqual(parseApkIndexOrigins(records.join("\n")), new Map([["a", ""]]));
      }
    }
  });

  it("keeps conflicting origins unresolved even when an unknown record occurs first", () => {
    const unknown = "P:a\nV:0\n";
    const first = "P:a\nV:1\no:src\n";
    const second = "P:a\nV:2\no:other\n";
    for (const records of [
      [unknown, first, second],
      [unknown, second, first],
      [first, unknown, second],
      [second, unknown, first],
      [first, second, unknown],
      [second, first, unknown],
    ]) {
      assert.deepEqual(parseApkIndexOrigins(records.join("\n")), new Map([["a", ""]]));
    }
  });
});

describe("mergeApkIndexOrigins", () => {
  it("accepts no repositories or empty repositories", () => {
    assert.deepEqual(mergeApkIndexOrigins([]), new Map());
    assert.deepEqual(mergeApkIndexOrigins([new Map(), new Map()]), new Map());
  });

  it("merges repository packages and shared known origins without changing inputs", () => {
    const main = new Map([
      ["a", "src"],
      ["b", "other"],
    ]);
    const community = new Map([
      ["a", "src"],
      ["c", "community"],
    ]);
    assert.deepEqual(
      mergeApkIndexOrigins([main, community]),
      new Map([
        ["a", "src"],
        ["b", "other"],
        ["c", "community"],
      ]),
    );
    assert.deepEqual(
      [...main],
      [
        ["a", "src"],
        ["b", "other"],
      ],
    );
    assert.deepEqual(
      [...community],
      [
        ["a", "src"],
        ["c", "community"],
      ],
    );
  });

  it("keeps unknown origins unresolved across more than two repositories", () => {
    const known = new Map([["a", "src"]]);
    const unknown = new Map([["a", ""]]);
    for (const indexes of [
      [unknown, known, known],
      [known, unknown, known],
      [known, known, unknown],
      [unknown, new Map(), unknown, known],
    ]) {
      assert.deepEqual(mergeApkIndexOrigins(indexes), new Map([["a", ""]]));
    }
  });
});

describe("mergeApkIndexOrigins (part 2)", () => {
  it("keeps conflicting repository origins unresolved in either order", () => {
    const first = new Map([["a", "src"]]);
    const second = new Map([["a", "other"]]);
    for (const indexes of [
      [first, second],
      [second, first],
    ]) {
      assert.deepEqual(mergeApkIndexOrigins(indexes), new Map([["a", ""]]));
    }
  });

  it("keeps conflicts unresolved regardless of where an unknown repository occurs", () => {
    const unknown = new Map([["a", ""]]);
    const first = new Map([["a", "src"]]);
    const second = new Map([["a", "other"]]);
    for (const indexes of [
      [unknown, first, second],
      [unknown, second, first],
      [first, unknown, second],
      [second, unknown, first],
      [first, second, unknown],
      [second, first, unknown],
    ]) {
      assert.deepEqual(mergeApkIndexOrigins(indexes), new Map([["a", ""]]));
    }
  });

  it("keeps a projected unknown unresolved beside another known origin", () => {
    const mixed = parseApkIndexOrigins("P:a\nV:1\n\nP:a\nV:2\no:src\n");
    const known = parseApkIndexOrigins("P:a\nV:3\no:other\n");
    for (const indexes of [
      [mixed, known],
      [known, mixed],
    ]) {
      assert.deepEqual(mergeApkIndexOrigins(indexes), new Map([["a", ""]]));
    }
  });

  it("keeps two already projected unknown origins unresolved", () => {
    const first = parseApkIndexOrigins("P:a\nV:1\no:src\n\nP:a\nV:2\no:\n");
    const second = parseApkIndexOrigins("P:a\nV:1\n\nP:a\nV:2\no:other\n");
    assert.deepEqual(mergeApkIndexOrigins([first, second]), new Map([["a", ""]]));
  });

  it("keeps unknown origins unresolved across successive merges", () => {
    const partial = mergeApkIndexOrigins([new Map([["a", ""]]), new Map([["a", "src"]])]);
    for (const indexes of [
      [partial, new Map([["a", "other"]])],
      [new Map([["a", "other"]]), partial],
    ]) {
      assert.deepEqual(mergeApkIndexOrigins(indexes), new Map([["a", ""]]));
    }
  });

  it("keeps unknown projections unresolved beside matching known records", () => {
    const mixed = parseApkIndexOrigins("P:a\nV:1\n\nP:a\nV:2\no:src\n");
    const known = parseApkIndexOrigins("P:a\nV:3\no:src\n");
    const unknown = parseApkIndexOrigins("P:a\nV:4\no:\n");
    const merged = mergeApkIndexOrigins([mixed, known, unknown]);
    assert.deepEqual(merged, new Map([["a", ""]]));
    assert.deepEqual(mergeApkIndexOrigins([merged, known]), new Map([["a", ""]]));
  });
});
