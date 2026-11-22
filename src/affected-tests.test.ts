import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "./post-pull-audit.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const SCRIPT = join(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  "scripts",
  "affected-tests.mjs",
);

interface Selection {
  mode: "all" | "selected";
  reason: string;
  tests: string[];
  changed: string[];
  total: number;
}

let repo: string;

/** The fixture's sources name each other through this, so this file's own text holds no import of them. */
const from = (name: string) => `from "./${name}.js";\n`;
const lazy = (name: string) => `export const load = () => import("./${name}.js");\n`;
const uses = (name: string) => `import { x } ${from(name)}export const y = x;\n`;
const testOf = (name: string) => `import { y } ${from(name)}void y;\n`;

const FIXTURE: Record<string, string> = {
  "package.json": "{}\n",
  "docs/GUIDE.md": "# guide\n",
  "docs/OTHER.md": "# other\n",
  ".github/workflows/ci.yml": "name: CI\n",
  "src/leaf.ts": "export const y = 1;\n",
  "src/leaf.test.ts": testOf("leaf"),
  "src/lazy.ts": "export const x = 1;\n",
  "src/loader.ts": lazy("lazy"),
  "src/loader.test.ts": `import { load } ${from("loader")}void load;\n`,
  "src/hub.ts": "export const x = 1;\n",
  "src/a.ts": uses("hub"),
  "src/b.ts": uses("hub"),
  "src/c.ts": uses("hub"),
  "src/a.test.ts": testOf("a"),
  "src/shape.ts": "export interface Shape { n: number }\n",
  "src/typed.ts": `import type { Shape } ${from("shape")}export const y: Shape = { n: 1 };\n`,
  "src/typed.test.ts": testOf("typed"),
  "src/helper.test-support.ts": "export const y = 1;\n",
  "src/program.ts": "console.log(1);\n",
  "src/e2e.test.ts": `import { spawnSync } from "node:child_process";\nspawnSync(process.execPath, [join(here, "program.js")]);\n`,
  "src/guide.test.ts": `import { readFileSync } from "node:fs";\nreadFileSync(join(root, "docs", "GUIDE.md"), "utf8");\n`,
  "packages/plug/package.json": '{ "name": "plug" }\n',
  "packages/plug/src/index.ts": "export const y = 1;\n",
  "packages/plug/src/index.test.ts": testOf("index"),
};

function write(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

function run(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, "--root", repo, ...args], { encoding: "utf8" });
}

function selectFor(files: string, ...args: string[]): Selection {
  const r = run("--json", "--files", files, ...args);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as Selection;
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "kit-affected-tests-"));
  write(FIXTURE);
});

after(() => rmTemp(repo));

describe("affected tests: selection from the import graph", () => {
  it("selects a leaf file's own test, plus the test that starts the built program", () => {
    const r = selectFor("src/leaf.ts");
    assert.equal(r.mode, "selected");
    assert.deepEqual(r.tests, ["dist/e2e.test.js", "dist/leaf.test.js"]);
    assert.equal(r.total, 7);
    assert.deepEqual(r.changed, ["src/leaf.ts"]);
  });

  it("follows a dynamic import to the importer's test", () => {
    assert.ok(selectFor("src/lazy.ts").tests.includes("dist/loader.test.js"));
  });

  it("does not follow a type-only import, which the compiler erases", () => {
    assert.deepEqual(selectFor("src/shape.ts").tests, ["dist/e2e.test.js"]);
  });

  it("selects a changed test itself, without the tests that start the program", () => {
    assert.deepEqual(selectFor("src/a.test.ts").tests, ["dist/a.test.js"]);
  });

  it("maps a workspace package's test to that package's dist", () => {
    const r = selectFor("packages/plug/src/index.ts");
    assert.ok(r.tests.includes("packages/plug/dist/index.test.js"), r.tests.join());
  });

  it("accepts the file list on stdin and Windows separators", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--root", repo, "--json", "--stdin"], {
      encoding: "utf8",
      input: "src\\leaf.ts\n",
    });
    assert.ok((JSON.parse(r.stdout) as Selection).tests.includes("dist/leaf.test.js"));
  });
});

describe("affected tests: run everything when the selection cannot be trusted", () => {
  it("runs everything for a file with more transitive importers than the limit", () => {
    const r = selectFor("src/hub.ts", "--max-importers", "3");
    assert.equal(r.mode, "all");
    assert.match(r.reason, /src\/hub\.ts: 4 transitive importers, over 3/);
    assert.equal(r.tests.length, r.total);
    assert.equal(selectFor("src/hub.ts", "--max-importers", "4").mode, "selected");
  });

  for (const file of [
    "package.json",
    ".github/workflows/ci.yml",
    "src/helper.test-support.ts",
    "scripts/build.mjs",
    "skills/triage/SKILL.md",
    "src/gone.ts",
  ]) {
    it(`runs everything when ${file} changes`, () => {
      const r = selectFor(`src/leaf.ts,${file}`);
      assert.equal(r.mode, "all");
      assert.ok(r.reason.startsWith(`${file}: `), r.reason);
    });
  }

  it("runs everything for an empty diff and for a selection over the cap", () => {
    assert.match(selectFor("").reason, /empty/);
    const r = selectFor("src/leaf.ts,src/lazy.ts", "--max-tests", "1");
    assert.equal(r.mode, "all");
    assert.match(r.reason, /2 tests selected, over 1/);
  });

  it("runs everything, exit 0, when there is no merge base to diff against", () => {
    const r = run("--json", "--base", "no-such-ref");
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout) as Selection;
    assert.equal(parsed.mode, "all");
    assert.match(parsed.reason, /no merge base with no-such-ref/);
  });
});

describe("affected tests: documents", () => {
  it("selects only the test that reads a changed document", () => {
    const r = selectFor("docs/GUIDE.md");
    assert.equal(r.mode, "selected");
    assert.deepEqual(r.tests, ["dist/guide.test.js"]);
  });

  it("selects nothing, and not everything, for a document no test reads", () => {
    const r = selectFor("CHANGELOG.md");
    assert.equal(r.mode, "selected");
    assert.deepEqual(r.tests, []);
  });
});

describe("affected tests: the diff of a branch", () => {
  it("reads the changed files from merge-base...HEAD and writes the summary table", () => {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "commit.gpgsign", "false");
    const commit = (message: string) => {
      git(repo, "add", "-A");
      git(
        repo,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "-m",
        message,
      );
    };
    commit("base");
    git(repo, "checkout", "-q", "-b", "topic");
    write({ "src/leaf.ts": "export const y = 2;\n" });
    commit("change the leaf");
    const summary = join(repo, "summary.md");
    const r = run("--json", "--base", "main", "--summary", summary);
    const parsed = JSON.parse(r.stdout) as Selection;
    assert.deepEqual(parsed.changed, ["src/leaf.ts"]);
    assert.deepEqual(parsed.tests, ["dist/e2e.test.js", "dist/leaf.test.js"]);
    assert.match(readFileSync(summary, "utf8"), /\| selected \| 2 \| 7 \|/);
  });
});

describe("affected tests: comparing a selection with a full run", () => {
  const failure = (n: number, file: string) =>
    `not ok ${n} - a suite\n  ---\n  type: 'suite'\n  location: '/work/repo/${file}:3:1'\n  failureType: 'subtestsFailed'\n  ...\n`;
  const tap = `TAP version 13\nok 1 - fine\n  ---\n  type: 'test'\n  ...\n${failure(2, "dist/leaf.test.js")}${failure(3, "dist/far/away.test.js")}1..3\n`;

  function compare(selection: Partial<Selection>) {
    const dir = mkdtempSync(join(tmpdir(), "kit-affected-compare-"));
    try {
      writeFileSync(join(dir, "selection.json"), JSON.stringify(selection));
      writeFileSync(join(dir, "run.tap"), tap);
      const args = ["--compare", join(dir, "selection.json"), join(dir, "run.tap")];
      const r = spawnSync(process.execPath, [SCRIPT, ...args, "--summary", join(dir, "s.md")], {
        encoding: "utf8",
      });
      return { ...r, summary: readFileSync(join(dir, "s.md"), "utf8") };
    } finally {
      rmTemp(dir);
    }
  }

  it("reports a miss loudly and still exits 0", () => {
    const r = compare({ mode: "selected", reason: "1 of 7", tests: ["dist/leaf.test.js"] });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /would have caught: \/work\/repo\/dist\/leaf\.test\.js/);
    assert.match(r.stdout, /WOULD HAVE MISSED: \/work\/repo\/dist\/far\/away\.test\.js/);
    assert.match(r.summary, /SELECTION WOULD HAVE MISSED 1 FAILING TEST FILE/);
  });

  it("misses nothing when the mode was to run everything", () => {
    const r = compare({ mode: "all", reason: "package.json", tests: [] });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /MISSED/);
    assert.match(r.stdout, /All 2 failing test file\(s\) were in the selection/);
  });

  it("exits 0 when the report is missing", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--compare", "nope.json", "nope.tap"], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /affected-tests failed/);
  });
});
