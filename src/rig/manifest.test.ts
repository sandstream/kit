import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  DEFAULT_TOLERANCE,
  inputId,
  loadManifest,
  parseManifest,
  referencedFiles,
  relPath,
  RigManifestError,
} from "./manifest.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

const SHA = "a".repeat(40);

const MANIFEST = `
[input]
repo = "acme/webapp"
commit = "${SHA}"
prompt = "prompts/review.md"

[[defect]]
id = "d1"
file = "src/auth.ts"
line_start = 40
line_end = 42
kind = "missing-check"
split = "tune"
patch = "defects/d1.diff"

[[defect]]
id = "d2"
file = "src/db.ts"
line_start = 7
line_end = 7
kind = "sql-injection"
split = "holdout"
patch = "defects/d2.diff"

[[control]]
id = "c1"
patch = "controls/c1.diff"
`;

const FILES = {
  "prompts/review.md": "Review this diff.\n",
  "defects/d1.diff": "--- a\n+++ b\n",
  "defects/d2.diff": "--- c\n+++ d\n",
  "controls/c1.diff": "--- e\n+++ f\n",
};

function refuses(text: string, pattern: RegExp): void {
  assert.throws(
    () => parseManifest(text),
    (e: unknown) => {
      assert.ok(e instanceof RigManifestError);
      assert.match((e as Error).message, pattern);
      return true;
    },
  );
}

describe("parseManifest", () => {
  it("parses input, defects and controls, defaulting tolerance to 3", () => {
    const m = parseManifest(MANIFEST);
    assert.equal(m.input.tolerance, DEFAULT_TOLERANCE);
    assert.deepEqual(
      m.defects.map((d) => [d.id, d.split]),
      [
        ["d1", "tune"],
        ["d2", "holdout"],
      ],
    );
    assert.equal(m.controls[0].patch, "controls/c1.diff");
  });

  it("refuses a defect without a split, or with an unknown one", () => {
    refuses(MANIFEST.replace('split = "tune"\n', ""), /#1: "split" is required/);
    refuses(
      MANIFEST.replace('split = "tune"', 'split = "train"'),
      /"split" must be "tune" or "holdout"/,
    );
  });

  it("refuses unknown keys at every level", () => {
    refuses("extra = 1\n" + MANIFEST, /rig\.toml: unknown key\(s\) extra/);
    refuses(MANIFEST + "\nextra = 1\n", /\[\[control\]\] #1: unknown key\(s\) extra/);
    refuses(
      MANIFEST.replace('prompt = "prompts/review.md"', 'prompt = "p.md"\nmodel = "x"'),
      /\[input\]: unknown key\(s\) model/,
    );
    refuses(
      MANIFEST.replace('kind = "missing-check"', 'kind = "x"\nseverity = "high"'),
      /#1: unknown key\(s\) severity/,
    );
  });

  it("refuses a short or upper-case commit, bad lines and duplicate ids", () => {
    refuses(MANIFEST.replace(SHA, "abc123"), /full 40- or 64-character/);
    refuses(MANIFEST.replace(SHA, "A".repeat(40)), /full 40- or 64-character/);
    refuses(
      MANIFEST.replace("line_end = 42", "line_end = 39"),
      /"line_end" is before "line_start"/,
    );
    refuses(
      MANIFEST.replace("line_start = 7", "line_start = 0"),
      /"line_start" must be a positive integer/,
    );
    refuses(MANIFEST.replace('id = "c1"', 'id = "d1"'), /duplicate id "d1"/);
  });

  it("refuses paths that escape or are absolute, and normalises backslashes", () => {
    refuses(MANIFEST.replace("defects/d1.diff", "../outside.diff"), /must not contain \.\./);
    refuses(MANIFEST.replace("prompts/review.md", "/etc/passwd"), /must be relative/);
    refuses(MANIFEST.replace("prompts/review.md", "C:/x.md"), /must be relative/);
    assert.equal(relPath("src\\auth.ts", "f"), "src/auth.ts");
    assert.equal(relPath("./src/auth.ts", "f"), "src/auth.ts");
  });

  it("refuses invalid TOML and a manifest with no defects", () => {
    refuses("[input", /not valid TOML/);
    refuses(MANIFEST.split("[[defect]]")[0], /declares no \[\[defect\]\]/);
  });
});

describe("inputId", () => {
  it("is stable across key order and line endings, and changes with any byte that matters", () => {
    const m = parseManifest(MANIFEST);
    const id = inputId(m, FILES);
    assert.match(id, /^[0-9a-f]{64}$/);
    const reordered = parseManifest(
      MANIFEST.replace(
        'repo = "acme/webapp"\ncommit',
        `commit = "${SHA}"\nrepo = "acme/webapp"\nx`,
      ).replace(`x = "${SHA}"\n`, ""),
    );
    assert.equal(inputId(reordered, FILES), id);
    const crlf = Object.fromEntries(
      Object.entries(FILES).map(([k, v]) => [k, v.replace(/\n/g, "\r\n")]),
    );
    assert.equal(inputId(m, crlf), id);
    assert.notEqual(inputId(m, { ...FILES, "prompts/review.md": "Review harder.\n" }), id);
    assert.notEqual(
      inputId(parseManifest(MANIFEST.replace('split = "holdout"', 'split = "tune"')), FILES),
      id,
    );
  });

  it("refuses when a referenced file is missing", () => {
    const m = parseManifest(MANIFEST);
    const { ["controls/c1.diff"]: _omit, ...partial } = FILES;
    assert.throws(() => inputId(m, partial), /"controls\/c1\.diff" was not supplied/);
  });

  it("canonicalJson sorts keys at every level", () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: [2, { z: 0, y: 1 }], c: "x" } }),
      '{"a":{"c":"x","d":[2,{"y":1,"z":0}]},"b":1}',
    );
  });
});

describe("[input] extra", () => {
  const WITH_EXTRA = MANIFEST.replace(
    'prompt = "prompts/review.md"\n',
    'prompt = "prompts/review.md"\nextra = ["excerpts/d1.txt", "./hints.json", "excerpts/d1.txt"]\n',
  );
  const EXTRA_FILES = { ...FILES, "excerpts/d1.txt": "  40  if (token) {\n", "hints.json": "{}\n" };

  it("keeps the id every manifest without extra already had", () => {
    // Pinned from the build before `extra` existed: adding the key must not move an old corpus.
    assert.equal(
      inputId(parseManifest(MANIFEST), FILES),
      "1ce024b82beedc0d70e7a111cb33e6f0878ef17696fb2a57cd32029f97c830f0",
    );
    assert.equal("extra" in parseManifest(MANIFEST).input, false);
  });

  it("normalises, de-duplicates and sorts extra, and hashes every extra file", () => {
    const m = parseManifest(WITH_EXTRA);
    assert.deepEqual(m.input.extra, ["excerpts/d1.txt", "hints.json"]);
    assert.ok(referencedFiles(m).includes("hints.json"));
    const id = inputId(m, EXTRA_FILES);
    assert.notEqual(id, inputId(parseManifest(MANIFEST), FILES));
    assert.notEqual(inputId(m, { ...EXTRA_FILES, "hints.json": '{"d1":"40"}\n' }), id);
    assert.throws(() => inputId(m, FILES), /"excerpts\/d1\.txt" was not supplied/);
  });
});

describe("[input] extra refusals", () => {
  it("refuses a non-array, an empty path, an absolute path or one that climbs out", () => {
    const set = (v: string): string =>
      MANIFEST.replace(
        'prompt = "prompts/review.md"\n',
        `prompt = "prompts/review.md"\nextra = ${v}\n`,
      );
    refuses(set('"hints.json"'), /"extra" must be an array/);
    refuses(set('[""]'), /"extra" must be an array/);
    refuses(set("[1]"), /"extra" must be an array/);
    refuses(set('["/etc/passwd"]'), /extra: "\/etc\/passwd" must be relative/);
    refuses(set('["../x.txt"]'), /extra: "\.\.\/x\.txt" must not contain \.\./);
  });
});

describe("loadManifest", () => {
  it("reads the manifest and its referenced files from disk and computes the same id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-rig-"));
    try {
      writeFileSync(join(dir, "rig.toml"), MANIFEST);
      for (const [rel, body] of Object.entries(FILES)) {
        mkdirSync(join(dir, ...rel.split("/").slice(0, -1)), { recursive: true });
        writeFileSync(join(dir, ...rel.split("/")), body);
      }
      const loaded = await loadManifest(join(dir, "rig.toml"));
      assert.equal(loaded.inputId, inputId(parseManifest(MANIFEST), FILES));
      assert.deepEqual(Object.keys(loaded.files).sort(), referencedFiles(loaded.manifest));
    } finally {
      rmTemp(dir);
    }
  });

  it("refuses when a referenced file cannot be read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-rig-missing-"));
    try {
      writeFileSync(join(dir, "rig.toml"), MANIFEST);
      await assert.rejects(loadManifest(join(dir, "rig.toml")), /could not be read/);
    } finally {
      rmTemp(dir);
    }
  });
});
