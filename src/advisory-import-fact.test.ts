import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ingestStrict } from "./adapters/ingest.js";
import {
  buildImportIndex,
  importFactFor,
  importFactText,
  withImportFacts,
  type ImportFact,
  type ImportIndexLimits,
} from "./advisory-import-fact.js";
import { createCliContractFixture } from "./cli-contract.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmTemp(root);
});

/** Write a fixture project. Keys are posix paths; each becomes a file under the root. */
function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kit-import-fact-"));
  roots.push(root);
  write(root, files);
  return root;
}

/** express is direct and brings qs, which brings side-channel. left-pad is direct and not imported. */
const NPM_PROJECT: Record<string, string> = {
  "package.json": JSON.stringify({
    dependencies: { express: "^4.0.0", "left-pad": "^1.0.0" },
    devDependencies: { "@scope/tool": "^1.0.0" },
  }),
  "package-lock.json": JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: { express: "^4.0.0", "left-pad": "^1.0.0" },
        devDependencies: { "@scope/tool": "^1.0.0" },
      },
      "node_modules/express": { version: "4.0.0", dependencies: { qs: "^6.0.0" } },
      "node_modules/left-pad": { version: "1.0.0" },
      "node_modules/@scope/tool": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
      "node_modules/qs": { version: "6.0.0", dependencies: { "side-channel": "^1.0.0" } },
      "node_modules/side-channel": { version: "1.0.0" },
    },
  }),
  "src/app.ts": 'import express from "express";\nexport const app = express();\n',
};

async function fact(
  root: string,
  ecosystem: string | undefined,
  name: string,
  limits?: ImportIndexLimits,
): Promise<ImportFact> {
  return importFactFor(await buildImportIndex(root, limits), { name, ecosystem });
}

const BANNED = /not reachable|safe|unused/i;

describe("npm: the four outcomes", () => {
  it("imported: names the files that import the package", async () => {
    const got = await fact(project(NPM_PROJECT), "npm", "express");
    assert.deepEqual(got, { status: "imported", files: ["src/app.ts"], fileCount: 1 });
    assert.equal(importFactText(got), "imported by project source: src/app.ts");
  });

  it("imported: lists five files and counts the rest", async () => {
    const files: Record<string, string> = { ...NPM_PROJECT };
    for (const n of [1, 2, 3, 4, 5, 6, 7]) files[`src/m${n}.ts`] = 'import "express";\n';
    const got = await fact(project(files), "npm", "express");
    assert.equal(got.status, "imported");
    assert.equal(
      importFactText(got),
      "imported by project source: src/app.ts, src/m1.ts, src/m2.ts, src/m3.ts, src/m4.ts (+3 more)",
    );
  });

  it("transitive-only: names the direct dependencies that bring it in", async () => {
    const got = await fact(project(NPM_PROJECT), "npm", "side-channel");
    assert.deepEqual(got, { status: "transitive-only", via: ["@scope/tool", "express"] });
    assert.equal(
      importFactText(got),
      "not imported by project source; in the lockfile as a dependency of @scope/tool (+1 more)",
    );
    assert.equal(
      importFactText({ status: "transitive-only", via: ["express"] }),
      "not imported by project source; in the lockfile as a dependency of express",
    );
  });

  it("not-found-in-source: a direct dependency that no file imports", async () => {
    const got = await fact(project(NPM_PROJECT), "npm", "left-pad");
    assert.deepEqual(got, { status: "not-found-in-source" });
    assert.equal(
      importFactText(got),
      "not imported by anything kit read (dynamic or generated imports are not seen)",
    );
  });

  it("unknown: every reason kit cannot answer is said, and none is a negative claim", async () => {
    const cases: [Record<string, string>, string | undefined, string, RegExp][] = [
      [NPM_PROJECT, "Go", "left-pad", /^ecosystem Go not supported/],
      [NPM_PROJECT, undefined, "left-pad", /^the report names no ecosystem$/],
      [NPM_PROJECT, "npm", "absent-package", /not in this project's package-lock\.json/],
      [NPM_PROJECT, "npm", "bad name\u001b[31m", /not a plain name/],
      [{ "package.json": NPM_PROJECT["package.json"] }, "npm", "left-pad", /^no source files$/],
      [{ "src/a.ts": "export {};\n" }, "npm", "qs", /^no package\.json or package-lock\.json/],
      [
        { "package.json": "{}", "src/a.ts": "export {};\n" },
        "npm",
        "qs",
        /^no package-lock\.json \(yarn and pnpm lockfiles are not read\)$/,
      ],
      [
        { "package.json": "{}", "package-lock.json": "{ not json", "src/a.ts": "export {};\n" },
        "npm",
        "qs",
        /^unreadable lockfile$/,
      ],
      [
        {
          "package.json": "{}",
          "package-lock.json": JSON.stringify({ lockfileVersion: 1, dependencies: { qs: {} } }),
          "src/a.ts": "export {};\n",
        },
        "npm",
        "qs",
        /lockfile version 1/,
      ],
    ];
    for (const [files, ecosystem, name, reason] of cases) {
      const got = await fact(project(files), ecosystem, name);
      assert.equal(got.status, "unknown", `${name}: ${JSON.stringify(got)}`);
      assert.match(got.status === "unknown" ? got.reason : "", reason);
      assert.match(importFactText(got), /^import use not checked: /);
    }
  });
});

describe("npm: import forms", () => {
  const forms: [string, string, string][] = [
    ["subpath", "widget", 'import fp from "widget/fp";'],
    ["scoped", "@scope/pkg", 'import { a } from "@scope/pkg";'],
    ["scoped subpath", "@scope/pkg", "import { a } from '@scope/pkg/deep/x.js';"],
    ["side effect", "polyfill", 'import "polyfill";'],
    ["re-export", "shared", 'export * from "shared";'],
    ["named re-export", "shared", 'export { a as b } from "shared/sub";'],
    ["require", "legacy", 'const x = require("legacy");'],
    ["dynamic import", "lazy", 'const m = await import("lazy");'],
    ["dynamic subpath", "lazy", "void import('lazy/chunk');"],
    ["multi-line import", "wide", 'import {\n  a,\n  b,\n} from "wide";'],
    ["type import", "typed", 'import type { T } from "typed";'],
  ];
  for (const [label, name, line] of forms) {
    it(`${label}: ${line.replace(/\n/g, " ")}`, async () => {
      const got = await fact(project({ "src/a.ts": `${line}\n` }), "npm", name);
      assert.deepEqual(got, { status: "imported", files: ["src/a.ts"], fileCount: 1 });
    });
  }

  it("reads every Node source extension", async () => {
    const files: Record<string, string> = {};
    const names = ["a.js", "b.mjs", "c.cjs", "d.ts", "e.tsx", "f.jsx", "g.mts", "h.cts"];
    for (const file of names) files[file] = 'import "everywhere";\n';
    files["notes.md"] = 'import "everywhere";\n';
    const got = await fact(project(files), "npm", "everywhere");
    assert.deepEqual(got, { status: "imported", files: names.slice(0, 5), fileCount: 8 });
  });

  it("a relative path, a built-in and a look-alike name are not the package", async () => {
    const root = project({
      ...NPM_PROJECT,
      "src/b.ts": 'import "./left-pad";\nimport "node:fs";\nimport "left-pad-extra";\n',
    });
    assert.equal((await fact(root, "npm", "left-pad")).status, "not-found-in-source");
  });

  it("stated limit: a package named in prose is not an import, a commented-out import is", async () => {
    const prose = project({
      ...NPM_PROJECT,
      "src/b.ts": "// left-pad pads strings, we should use left-pad here\nexport {};\n",
    });
    assert.equal((await fact(prose, "npm", "left-pad")).status, "not-found-in-source");
    // The scan is text-level: it does not know a comment from code, so this counts as an import.
    const commented = project({
      ...NPM_PROJECT,
      "src/b.ts": '// import pad from "left-pad";\nexport {};\n',
    });
    assert.deepEqual(await fact(commented, "npm", "left-pad"), {
      status: "imported",
      files: ["src/b.ts"],
      fileCount: 1,
    });
  });

  it("does not read node_modules, build output, vendor, hidden or virtualenv directories", async () => {
    const line = 'import "left-pad";\n';
    const root = project({
      ...NPM_PROJECT,
      "node_modules/x/index.js": line,
      "dist/a.js": line,
      "build/a.js": line,
      "vendor/a.js": line,
      ".git/hooks/a.js": line,
      ".cache/a.js": line,
      "tools/env/pyvenv.cfg": "home = /usr\n",
      "tools/env/lib/a.js": line,
    });
    assert.equal((await fact(root, "npm", "left-pad")).status, "not-found-in-source");
  });
});

describe("PyPI", () => {
  const PY: Record<string, string> = {
    "requirements.txt": "requests==2.0\nPyYAML>=6\nBeautifulSoup4\npython-magic\n",
    "app/main.py":
      "import os, requests as r\nfrom yaml.loader import SafeLoader\n    import google.cloud.storage\n",
    "app/other.py": "from . import main\nfrom .pkg import thing\n# beautifulsoup4 is listed\n",
  };

  it("matches import, from-import and a dotted module", async () => {
    const root = project(PY);
    for (const name of ["requests", "Requests", "google"]) {
      assert.deepEqual(await fact(root, "PyPI", name), {
        status: "imported",
        files: ["app/main.py"],
        fileCount: 1,
      });
    }
  });

  it("uses the labelled list for a known name mismatch", async () => {
    const root = project(PY);
    assert.equal((await fact(root, "PyPI", "PyYAML")).status, "imported");
    assert.equal((await fact(root, "PyPI", "pyyaml")).status, "imported");
    // bs4 is the known import name and no file imports it: this one may be stated.
    assert.deepEqual(await fact(root, "PyPI", "beautifulsoup4"), {
      status: "not-found-in-source",
    });
    assert.equal(
      importFactText(await fact(root, "PyPI", "Pillow")),
      "import use not checked: the package is not in a requirements file or pyproject.toml",
    );
  });

  it("never claims not-found when the import name may differ", async () => {
    const got = await fact(project(PY), "PyPI", "python-magic");
    assert.equal(
      importFactText(got),
      "import use not checked: a PyPI name and its import name can differ, and no file imports `python_magic`",
    );
  });

  it("says so when there is no Python source", async () => {
    const got = await fact(project(NPM_PROJECT), "PyPI", "requests");
    assert.deepEqual(got, { status: "unknown", reason: "no source files" });
  });
});

describe("bounds", () => {
  it("too many files is unknown, even for a package an early file imports", async () => {
    const files: Record<string, string> = { ...NPM_PROJECT };
    for (const n of [1, 2, 3]) files[`src/z${n}.ts`] = "export {};\n";
    const root = project(files);
    for (const name of ["express", "left-pad", "side-channel"]) {
      const got = await fact(root, "npm", name, { maxFiles: 3 });
      assert.deepEqual(got, {
        status: "unknown",
        reason: "too many files (more than 3 source files)",
      });
    }
    assert.equal((await fact(root, "npm", "express", { maxFiles: 4 })).status, "imported");
  });

  it("a file over the byte bound is unknown, not a partial answer", async () => {
    const root = project({ ...NPM_PROJECT, "src/big.ts": `// ${"x".repeat(400)}\n` });
    for (const name of ["express", "left-pad"]) {
      const got = await fact(root, "npm", name, { maxFileBytes: 200 });
      assert.equal(got.status, "unknown");
      assert.match(importFactText(got), /could not be read or is over 200 bytes$/);
    }
  });
});

describe("wording", () => {
  it("never says a package is not reachable, safe or unused", async () => {
    const root = project(NPM_PROJECT);
    const texts = [
      importFactText({ status: "transitive-only", via: [] }),
      importFactText({ status: "unknown", reason: "x" }),
    ];
    for (const name of ["express", "left-pad", "side-channel", "absent"]) {
      texts.push(importFactText(await fact(root, "npm", name)));
    }
    texts.push(importFactText(await fact(root, "Maven", "a:b")));
    for (const text of texts) assert.doesNotMatch(text, BANNED, text);
    assert.equal(
      texts[0],
      "not imported by project source; in the lockfile as a dependency of other packages",
    );
  });
});

const vuln = (id: string, summary: string, severity?: string) => ({
  id,
  summary,
  database_specific: severity ? { severity } : {},
});

const REPORT = {
  results: [
    {
      packages: [
        {
          package: { name: "left-pad", version: "1.0.0", ecosystem: "npm" },
          vulnerabilities: [vuln("GHSA-aaaa-aaaa-aaaa", "low one", "LOW")],
        },
        {
          package: { name: "side-channel", version: "1.0.0", ecosystem: "npm" },
          vulnerabilities: [
            vuln("GHSA-bbbb-bbbb-bbbb", "critical one", "CRITICAL"),
            vuln("GHSA-cccc-cccc-cccc", "second on the same package", "MODERATE"),
          ],
        },
        {
          package: { name: "express", version: "4.0.0", ecosystem: "npm" },
          vulnerabilities: [vuln("GHSA-dddd-dddd-dddd", "no label one")],
        },
        {
          package: { name: "serde", version: "1.0.0", ecosystem: "crates.io" },
          vulnerabilities: [vuln("RUSTSEC-0000-0001", "other ecosystem", "HIGH")],
        },
      ],
    },
  ],
};

const TRANSITIVE_TEXT =
  "not imported by project source; in the lockfile as a dependency of @scope/tool (+1 more)";

function withoutFact(findings: object[]): string {
  return JSON.stringify(
    findings.map((finding) => {
      const copy: Record<string, unknown> = { ...finding };
      delete copy.importFact;
      return copy;
    }),
  );
}

describe("withImportFacts", () => {
  it("adds one field, keeps order and every other field, and skips findings with no package", async () => {
    const outcome = ingestStrict("osv", JSON.stringify(REPORT));
    assert.ok(outcome.ok);
    const plain = { name: "sarif row", severity: "high" };
    const input: object[] = [...outcome.findings, plain];
    const before = JSON.stringify(input);
    const out = await withImportFacts(project(NPM_PROJECT), input);
    assert.equal(JSON.stringify(input), before);
    assert.equal(out[out.length - 1], plain);
    assert.deepEqual(
      out.map((f) => f.importFact?.status),
      [
        "not-found-in-source",
        "transitive-only",
        "transitive-only",
        "imported",
        "unknown",
        undefined,
      ],
    );
    assert.equal(withoutFact(out), before);
    for (const f of out) {
      if (f.importFact) assert.equal(f.importFact.text, importFactText(f.importFact));
    }
  });
});

const FACT_LINE =
  /^ +(?:imported by project source: |not imported by project source; |not imported by anything kit read |import use not checked: ).*\n/gm;

describe("kit ingest osv: the fact rides beside the finding", () => {
  function run(files: Record<string, string>, args: string[], report: unknown = REPORT): string {
    const fixture = createCliContractFixture();
    roots.push(fixture.root);
    write(fixture.cwd, { ...files, "report.json": JSON.stringify(report) });
    const result = fixture.run(["ingest", "osv", "report.json", ...args]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  const findingsOf = (stdout: string) =>
    (JSON.parse(stdout) as { count: number; findings: Record<string, unknown>[] }).findings;

  it("keeps import facts and marks partial coverage when an OSV result is unreadable", () => {
    const stdout = run(NPM_PROJECT, ["--json"], {
      results: [...REPORT.results, { packages: null }],
    });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.coverage, "partial");
    assert.equal(parsed.reportGap, "malformed");
    assert.equal(parsed.count, 5);
    assert.equal(parsed.findings[3].importFact.text, "imported by project source: src/app.ts");
  });

  it("JSON: findings carry importFact, and without it they are byte-identical to the parser's", () => {
    const outcome = ingestStrict("osv", JSON.stringify(REPORT));
    assert.ok(outcome.ok);
    const findings = findingsOf(run(NPM_PROJECT, ["--json"]));
    assert.deepEqual(
      findings.map((f) => (f.importFact as { text?: string } | undefined)?.text),
      [
        "not imported by anything kit read (dynamic or generated imports are not seen)",
        TRANSITIVE_TEXT,
        TRANSITIVE_TEXT,
        "imported by project source: src/app.ts",
        "import use not checked: ecosystem crates.io not supported (npm and PyPI are read)",
      ],
    );
    assert.deepEqual(findings[1].importFact, {
      status: "transitive-only",
      via: ["@scope/tool", "express"],
      text: TRANSITIVE_TEXT,
    });
    // Severity, status, name, detail and order: exactly what the parser gave, in report order.
    assert.equal(withoutFact(findings), JSON.stringify(outcome.findings));
    assert.deepEqual(
      findings.map((f) => f.severity),
      ["low", "critical", "medium", "high", "high"],
    );
  });

  it("the same report gives the same severities and order whatever the project holds", () => {
    const full = run(NPM_PROJECT, ["--json"]);
    const empty = run({}, ["--json"]);
    assert.notEqual(full, empty);
    assert.equal(withoutFact(findingsOf(full)), withoutFact(findingsOf(empty)));
  });

  it("text: one extra line per finding, and every other byte is unchanged", () => {
    const full = run(NPM_PROJECT, []);
    const empty = run({}, []);
    assert.equal((full.match(FACT_LINE) ?? []).length, 5);
    assert.equal((empty.match(FACT_LINE) ?? []).length, 5);
    assert.equal(full.replace(FACT_LINE, ""), empty.replace(FACT_LINE, ""));
    const rows = full
      .split("\n")
      .filter((line) => /^ {2}[A-Z]+ /.test(line))
      .map((line) => line.trim().split(/\s+/)[0]);
    assert.deepEqual(rows, ["CRITICAL", "HIGH", "HIGH", "MEDIUM", "LOW"]);
    assert.match(full, /critical one\n +not imported by project source; in the lockfile as/);
    assert.doesNotMatch(full, /not reachable|\bsafe\b|unused/i);
  });

  it("a finding with no package (SARIF) gets no fact", () => {
    const fixture = createCliContractFixture();
    roots.push(fixture.root);
    const sarif = {
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "t" } }, results: [{ ruleId: "r", level: "error" }] }],
    };
    write(fixture.cwd, { ...NPM_PROJECT, "report.sarif": JSON.stringify(sarif) });
    const result = fixture.run(["ingest", "sarif", "report.sarif", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /importFact/);
  });
});
