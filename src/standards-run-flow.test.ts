/**
 * Characterization of runStandardsGate (src/standards-run.ts) before it is split.
 * It pins which dimensions run for each category, how the language is chosen, how
 * the config and baseline reach the checkers, and how the summary is counted.
 * Every test must pass on the unsplit function and on the split one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStandardsGate, type StandardsRunResult } from "./standards-run.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const POSIX = process.platform !== "win32";

interface Fixture {
  repo: string;
  bin: string;
}

async function withPath<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = path;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

/** A TypeScript repo, a bin folder for fake tools, and an optional `.kit.toml`. */
function makeFixture(files: Record<string, string> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "kit-sgflow-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  const all: Record<string, string> = {
    "package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
    "index.ts": "export const x = 1;\n",
    ...files,
  };
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(join(repo, name, ".."), { recursive: true });
    writeFileSync(join(repo, name), text);
  }
  return { repo, bin };
}

function dropFixture(f: Fixture): void {
  rmTemp(join(f.repo, ".."));
}

/** Every tool is missing, so each tool gate is a setup gap. */
function runBare(f: Fixture, opts: { category?: string; enforce?: boolean } = {}) {
  return withPath("", () => runStandardsGate({ cwd: f.repo, ...opts }));
}

function writeFakeScc(f: Fixture, lines: number): void {
  const out = JSON.stringify([
    { Name: "TypeScript", Files: [{ Location: join(f.repo, "index.ts"), Lines: lines }] },
  ]);
  const script = join(f.bin, "scc");
  writeFileSync(script, `#!/bin/sh\necho '${out}'\n`);
  chmodSync(script, 0o755);
}

/** `which` must resolve, so the system folders stay on PATH next to the fake bin. */
function runWithFakeScc(f: Fixture, opts: { category?: string } = {}) {
  return withPath(`${f.bin}:/usr/bin:/bin`, () =>
    runStandardsGate({ cwd: f.repo, category: "general", ...opts }),
  );
}

const names = (r: StandardsRunResult): string[] => r.checks.map((c) => c.name);
const sizeCheck = (r: StandardsRunResult) => r.checks.find((c) => c.name === "file size (scc)");

describe("runStandardsGate — which dimensions run for each category", () => {
  const cases: Array<[string | undefined, string[]]> = [
    [
      undefined,
      [
        "complexity (lizard)",
        "duplication (jscpd)",
        "file size (scc)",
        "typescript: eslint",
        "typescript: tsc --noEmit",
      ],
    ],
    ["general", ["complexity (lizard)", "duplication (jscpd)", "file size (scc)"]],
    ["specific", ["typescript: eslint", "typescript: tsc --noEmit"]],
    ["typescript", ["typescript: eslint", "typescript: tsc --noEmit"]],
    ["python", ["python: ruff", "python: mypy"]],
    ["go", ["go: go vet", "go: gofmt -l"]],
    ["rust", ["rust: cargo clippy", "rust: cargo fmt --check"]],
    ["plugins", []],
    ["platform", []],
    ["nonsense", []],
  ];
  for (const [category, expected] of cases) {
    it(`category ${String(category)} runs ${expected.length} checks`, async () => {
      const f = makeFixture();
      try {
        const r = await runBare(f, { category });
        assert.deepEqual(names(r), expected);
        assert.equal(r.ok, true);
        assert.equal(r.summary.setupGaps, expected.length);
        assert.equal(r.summary.score, "0/0");
      } finally {
        dropFixture(f);
      }
    });
  }
});

describe("runStandardsGate — language choice", () => {
  it("detects python from the repo when the category is specific", async () => {
    const f = makeFixture({ "pyproject.toml": '[project]\nname = "x"\n' });
    try {
      const r = await runBare(f, { category: "specific" });
      assert.ok(names(r).every((n) => n.startsWith("python:") || n.startsWith("typescript:")));
      assert.ok(names(r).length > 0);
    } finally {
      dropFixture(f);
    }
  });

  it("an explicit language beats the detected one", async () => {
    const f = makeFixture();
    try {
      const r = await runBare(f, { category: "go" });
      assert.ok(names(r).every((n) => n.startsWith("go:")));
    } finally {
      dropFixture(f);
    }
  });

  it("a language without a gate gives a skip check for category specific only", async () => {
    const f = makeFixture({ "mix.exs": "defmodule X do\nend\n" });
    try {
      rmSync(join(f.repo, "package.json"));
      const specific = await runBare(f, { category: "specific" });
      const skip = specific.checks.find((c) => c.dimension === "specific");
      assert.equal(skip?.status, "skip");
      assert.match(skip?.name ?? "", /^specific \(/);
      assert.match(skip?.detail ?? "", /no per-language standards gate for/);
      const all = await runBare(f);
      assert.equal(
        all.checks.some((c) => c.dimension === "specific"),
        false,
      );
      assert.equal(specific.summary.setupGaps, 0);
      assert.equal(specific.summary.ran, 0);
    } finally {
      dropFixture(f);
    }
  });
});

describe("runStandardsGate — enforce", () => {
  it("the option turns every setup gap into a failure", async () => {
    const f = makeFixture();
    try {
      const r = await runBare(f, { category: "general", enforce: true });
      assert.equal(r.ok, false);
      assert.equal(r.summary.failed, 3);
      assert.ok(r.checks.every((c) => c.status === "fail"));
    } finally {
      dropFixture(f);
    }
  });

  it("[standards] enforce = true in .kit.toml has the same effect", async () => {
    const f = makeFixture({ ".kit.toml": "[standards]\nenforce = true\n" });
    try {
      const r = await runBare(f, { category: "general" });
      assert.equal(r.ok, false);
      assert.equal(r.summary.failed, 3);
    } finally {
      dropFixture(f);
    }
  });

  it("an enforce option of false does not override the config", async () => {
    const f = makeFixture({ ".kit.toml": "[standards]\nenforce = true\n" });
    try {
      const r = await runBare(f, { category: "general", enforce: false });
      assert.equal(r.ok, false);
    } finally {
      dropFixture(f);
    }
  });
});

describe("runStandardsGate — thresholds reach the checkers", { skip: !POSIX }, () => {
  it("the default file-size limit is 600 lines", async () => {
    const f = makeFixture();
    try {
      writeFakeScc(f, 50);
      const size = sizeCheck(await runWithFakeScc(f));
      assert.equal(size?.status, "pass");
      assert.match(size?.detail ?? "", /no file over 600 lines/);
    } finally {
      dropFixture(f);
    }
  });

  it("[standards.general] max_file_lines changes the limit", async () => {
    const f = makeFixture({ ".kit.toml": "[standards.general]\nmax_file_lines = 5\n" });
    try {
      writeFakeScc(f, 50);
      const r = await runWithFakeScc(f);
      const size = sizeCheck(r);
      assert.equal(size?.status, "warn");
      assert.match(size?.detail ?? "", /1 file\(s\) over 5 lines/);
      assert.deepEqual(size?.files, ["index.ts (50 lines)"]);
      assert.equal(r.summary.ran, 1);
      assert.equal(r.summary.findings, 1);
      assert.equal(r.summary.passed, 0);
      assert.equal(r.summary.score, "0/1");
      assert.equal(r.summary.setupGaps, 2);
      assert.equal(r.ok, true);
    } finally {
      dropFixture(f);
    }
  });

  it("an invalid .kit.toml falls back to the default limits", async () => {
    const f = makeFixture({ ".kit.toml": '[standards.general]\nmax_file_lines = "five"\n' });
    try {
      writeFakeScc(f, 50);
      const size = sizeCheck(await runWithFakeScc(f));
      assert.match(size?.detail ?? "", /no file over 600 lines/);
    } finally {
      dropFixture(f);
    }
  });
});

describe("runStandardsGate — the baseline reaches the checkers", { skip: !POSIX }, () => {
  it("a baseline entry freezes the file at its size and growth is a fresh finding", async () => {
    const baseline = {
      version: 1,
      generated: "2026-11-12T00:00:00.000Z",
      categories: {
        standards: { size: ["index.ts"], size_metrics: ["index.ts|lines=50"] },
      },
    };
    const f = makeFixture({
      ".kit.toml": "[standards.general]\nmax_file_lines = 5\n",
      ".kit-baseline.json": JSON.stringify(baseline),
    });
    try {
      writeFakeScc(f, 50);
      const frozen = sizeCheck(await runWithFakeScc(f));
      assert.equal(frozen?.status, "warn");
      assert.match(frozen?.detail ?? "", /1 pre-existing finding\(s\) \(baseline-frozen\)/);
      writeFakeScc(f, 51);
      const grown = sizeCheck(await runWithFakeScc(f));
      assert.match(grown?.detail ?? "", /1 file\(s\) over 5 lines/);
    } finally {
      dropFixture(f);
    }
  });

  it("a malformed baseline is ignored and reported", async () => {
    const f = makeFixture({ ".kit-baseline.json": "{ not json" });
    try {
      writeFakeScc(f, 50);
      const r = await runWithFakeScc(f);
      assert.equal(typeof r.baselineIgnored, "string");
      assert.ok((r.baselineIgnored ?? "").length > 0);
    } finally {
      dropFixture(f);
    }
  });

  it("a missing baseline is not reported as ignored", async () => {
    const f = makeFixture();
    try {
      const r = await runBare(f, { category: "general" });
      assert.equal(r.baselineIgnored, null);
    } finally {
      dropFixture(f);
    }
  });
});

const PLUGIN = [
  "[standard]",
  'id = "no-x"',
  'title = "No x"',
  'applies_to = ["typescript"]',
  'severity = "warn"',
  "match = 'export const x'",
  "",
].join("\n");

describe("runStandardsGate — plugins and platform", () => {
  it("runs a declarative plugin from the default folder", async () => {
    const f = makeFixture({ ".kit/standards.d/no-x.toml": PLUGIN });
    try {
      const r = await runBare(f, { category: "plugins" });
      const plugin = r.checks.find((c) => c.name === "plugin: no-x");
      assert.equal(plugin?.dimension, "plugin");
      assert.equal(plugin?.status, "warn");
      assert.equal(r.summary.findings, 1);
    } finally {
      dropFixture(f);
    }
  });

  it("reads plugin folders from [standards.plugins] dirs", async () => {
    const f = makeFixture({
      "rules/no-x.toml": PLUGIN,
      ".kit.toml": '[standards.plugins]\ndirs = ["rules"]\n',
    });
    try {
      const r = await runBare(f, { category: "plugins" });
      assert.ok(names(r).includes("plugin: no-x"));
    } finally {
      dropFixture(f);
    }
  });

  it("an empty dirs list falls back to the default folder", async () => {
    const f = makeFixture({
      ".kit/standards.d/no-x.toml": PLUGIN,
      ".kit.toml": "[standards.plugins]\ndirs = []\n",
    });
    try {
      const r = await runBare(f, { category: "plugins" });
      assert.ok(names(r).includes("plugin: no-x"));
    } finally {
      dropFixture(f);
    }
  });

  it("plugins run in the full gate and not in a general-only run", async () => {
    const f = makeFixture({ ".kit/standards.d/no-x.toml": PLUGIN });
    try {
      assert.ok(names(await runBare(f)).includes("plugin: no-x"));
      assert.equal(
        names(await runBare(f, { category: "general" })).includes("plugin: no-x"),
        false,
      );
    } finally {
      dropFixture(f);
    }
  });
});
