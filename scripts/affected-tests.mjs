#!/usr/bin/env node
// Which compiled tests does a change affect? Shadow mode only: CI still runs every test, and this
// script reports what a selection would have run and whether it would have missed a failure.
//
//   node scripts/affected-tests.mjs [--base <ref>] [--worktree] [--json] [--summary <file>]
//   node scripts/affected-tests.mjs --files a.ts,b.md     (or --stdin, one path per line)
//   node scripts/affected-tests.mjs --compare <selection.json> <report.tap> [--summary <file>]
//   node scripts/affected-tests.mjs --stats
//
// --base           the ref to diff against (default origin/main); the diff is merge-base...HEAD.
// --worktree       also count uncommitted and untracked files, as scripts/prepush.mjs does.
// --root           the repository to read (default: this script's repository).
// --max-importers  a changed source file imported, directly or not, by more files runs everything (40).
// --max-tests      a selection larger than this runs everything (200).
//
// The answer is `{ mode: "all" | "selected", reason, tests, changed, total }`. Mode "all" means the
// selection cannot be trusted for this change and every test must run. Neither form of the command
// exits non-zero for a reason of its own: an error becomes mode "all" with the error as the reason.
import { existsSync, readdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { testsForChanged } from "./prepush-lib.mjs";

const DEFAULTS = { maxImporters: 40, maxTests: 200 };

/** A repository path with forward slashes, whatever the platform wrote. */
const norm = (p) => p.split("\\").join("/").replace(/^\.\//, "");

/** `src/…` for the root package, `packages/<name>/src/…` for a workspace package; otherwise null. */
function sourceRoot(file) {
  const m = /^((?:packages\/[^/]+\/)?)src\//.exec(file);
  return m ? m[1] : null;
}

const isTest = (file) => file.endsWith(".test.ts");
const isSupport = (file) => file.endsWith(".test-support.ts");

/** The compiled path `scripts/test.mjs` runs for a test source. */
function compiledTest(file) {
  const prefix = sourceRoot(file);
  return `${prefix}dist/${file.slice(prefix.length + "src/".length, -".ts".length)}.js`;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Every TypeScript source of the root package and the workspace packages, with its text. */
function readSources(root) {
  const dirs = [join(root, "src")];
  const names = new Map(); // workspace package name -> its entry source
  const packages = join(root, "packages");
  if (existsSync(packages)) {
    for (const pkg of readdirSync(packages, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = join(packages, pkg.name, "src");
      if (!existsSync(src)) continue;
      dirs.push(src);
      try {
        const name = JSON.parse(
          readFileSync(join(packages, pkg.name, "package.json"), "utf8"),
        ).name;
        if (name) names.set(name, `packages/${pkg.name}/src/index.ts`);
      } catch {
        // A package without a readable manifest is still walked; only its name is unknown.
      }
    }
  }
  const text = new Map();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const abs of walk(dir, [])) {
      text.set(relative(root, abs).split(sep).join("/"), readFileSync(abs, "utf8"));
    }
  }
  return { text, names };
}

// `import … from "x"`, `export … from "x"`, `import "x"`, `import("x")`, `require("x")`. Text level:
// an import in a comment or a fixture string counts too, which only ever adds a test.
const SPECIFIER = /\b(?:from|import|require)\s*\(?\s*(?:\/\*.*?\*\/\s*)?(["'`])([^"'`\n]+)\1/g;
// Erased by the compiler, so they cannot change what a test does; the build still checks them.
const TYPE_ONLY =
  /^[ \t]*(?:import|export)\s+type\s[^;]*?\bfrom\s*["'][^"'\n]+["'];?|\btypeof\s+import\s*\(\s*["'][^"'\n]+["']\s*\)/gm;
// Any other quoted relative path to a compiled module: `new URL("./worker.js", import.meta.url)`.
const MODULE_LITERAL = /(["'`])(\.{1,2}\/[\w@./-]+\.m?js)\1/g;
// A compiled module named by path in a test: `join(here, "cli.js")`, `"dist/cli.js"`, `"./cli.js"`.
const BUILT_LITERAL = /(["'`])((?:\.{1,2}\/|dist\/)?[\w@./-]+\.m?js)\1/g;
// import(`./commands/${name}.js`): every module under the fixed prefix.
const TEMPLATE_IMPORT = /\bimport\s*\(\s*`(\.{1,2}\/[^`$]*)\$\{/g;

function candidates(path) {
  const out = [path];
  if (path.endsWith(".js")) out.push(`${path.slice(0, -3)}.ts`);
  else if (path.endsWith(".mjs")) out.push(`${path.slice(0, -4)}.mts`);
  else out.push(`${path}.ts`, `${path}/index.ts`);
  return out;
}

/** The source files `file` names, by any of the forms above. */
function importsOf(file, source, known, names) {
  const out = new Set();
  const dir = posix.dirname(file);
  const text = source.replace(TYPE_ONLY, "");
  const add = (path) => {
    for (const c of candidates(posix.normalize(path))) {
      if (c !== file && known.has(c)) out.add(c);
    }
  };
  for (const m of text.matchAll(SPECIFIER)) {
    const spec = m[2];
    if (spec.startsWith(".")) add(posix.join(dir, spec));
    else if (names.has(spec)) add(names.get(spec));
  }
  // In a test or a helper such a path is a program to start, not an import: see `namesBuiltModule`.
  if (!isTest(file) && !isSupport(file)) {
    for (const m of text.matchAll(MODULE_LITERAL)) add(posix.join(dir, m[2]));
  }
  for (const m of text.matchAll(TEMPLATE_IMPORT)) {
    const prefix = posix.normalize(posix.join(dir, m[1]));
    for (const k of known) if (k !== file && k.startsWith(prefix)) out.add(k);
  }
  return out;
}

// A test that starts the built program depends on all of it, whatever it imports.
const STARTS_PROCESS = /\b(?:spawn|spawnSync|execFile|execFileSync|fork|exec|execSync)\s*\(/;
const NAMES_CLI = /(["'`/])cli\.js\b/;
// Reading the compiled output is the same dependency without a process.
const READS_BUILD = /(["'`])dist(?:\/[^"'`\n]*)?\1/;

/** Does this text name a compiled module of the repository by a path, outside an import? */
function namesBuiltModule(file, source, known) {
  const text = source.replace(SPECIFIER, "");
  if (NAMES_CLI.test(text)) return true;
  const dir = posix.dirname(file);
  const base = `${sourceRoot(file)}src`;
  for (const m of text.matchAll(BUILT_LITERAL)) {
    const spec = m[2].startsWith("dist/") ? m[2].slice("dist/".length) : m[2];
    const module = spec.replace(/\.m?js$/, ".ts");
    if (known.has(posix.normalize(posix.join(dir, module)))) return true;
    if (known.has(posix.normalize(posix.join(base, module)))) return true;
  }
  return false;
}
// A test that reads source files by path (a discipline scan, a wiring check) depends on them too.
const READS_SOURCE = /(["'`])(?:src|packages)(?:\/[^"'`\n]*)?\1/;
const READS_FILES = /\b(?:readFileSync|readdirSync|readFile|readdir|existsSync|statSync)\s*\(/;
// A test that walks the tree for Markdown reads every document.
const WALKS_MARKDOWN = /(["'`])\.(?:md|markdown)\1/;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does this test read files and name the document, its file name, or a directory that holds it? */
function namesDocument(text, doc) {
  if (!READS_FILES.test(text)) return false;
  if (text.includes(doc)) return true;
  const parts = doc.split("/");
  const quoted = [parts.at(-1)];
  for (let i = 1; i < parts.length; i++) quoted.push(parts.slice(0, i).join("/"));
  return quoted.some((q) => new RegExp(`["'\`/]${escapeRegExp(q)}/?["'\`]`).test(text));
}

/**
 * The import graph of a repository, and what each test needs beyond its imports.
 * `importers` is the reverse graph; `kinds` marks the tests that the graph cannot place.
 */
function buildGraph(root) {
  const { text, names } = readSources(root);
  const known = new Set(text.keys());
  const imports = new Map();
  const importers = new Map([...known].map((f) => [f, new Set()]));
  for (const [file, body] of text) {
    const out = importsOf(file, body, known, names);
    imports.set(file, out);
    for (const dep of out) importers.get(dep).add(file);
  }
  const tests = [...known].filter(isTest).sort();
  // A helper can start the CLI or read the tree on a test's behalf, so a test is read together
  // with every *.test-support.ts it reaches.
  const reading = new Map();
  for (const test of tests) {
    let body = text.get(test);
    for (const dep of closure([test], imports)) if (isSupport(dep)) body += `\n${text.get(dep)}`;
    reading.set(test, body);
  }
  const kinds = new Map();
  for (const [test, body] of reading) {
    const kind = new Set();
    const touches = STARTS_PROCESS.test(body) || (READS_FILES.test(body) && READS_BUILD.test(body));
    if (touches && namesBuiltModule(test, body, known)) kind.add("cli-e2e");
    if (READS_FILES.test(body) && READS_SOURCE.test(body)) kind.add("reads-source");
    if (READS_FILES.test(body) && WALKS_MARKDOWN.test(body)) kind.add("walks-markdown");
    kinds.set(test, kind);
  }
  return { known, imports, importers, tests, reading, kinds };
}

/** Everything reachable from `start` along `edges`, not counting `start` itself. */
function closure(start, edges) {
  const seen = new Set(start);
  const queue = [...start];
  while (queue.length > 0) {
    for (const next of edges.get(queue.pop()) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  for (const s of start) seen.delete(s);
  return seen;
}

/** What a changed path is: a test, a source file, a document, or a reason to run everything. */
function classify(file) {
  if (file.startsWith(".github/")) return { all: "a workflow or repository setting" };
  if (file.startsWith("skills/")) return { all: "a shipped skill" };
  if (sourceRoot(file) !== null && file.endsWith(".ts")) {
    if (isSupport(file)) return { all: "a shared test helper" };
    if (file.endsWith(".d.ts")) return { all: "a declaration file" };
    return isTest(file) ? { test: true } : { source: true };
  }
  if (/\.(?:md|markdown)$/.test(file)) return { doc: true };
  return { all: "not a source file or a document" };
}

/** The tests one changed path reaches, or `{ all: reason }` when it cannot be placed. */
function reach(file, graph, maxImporters) {
  const what = classify(file);
  if (what.all) return { all: what.all };
  if (what.doc) {
    const readers = [...graph.reading].filter(
      ([test, body]) => graph.kinds.get(test).has("walks-markdown") || namesDocument(body, file),
    );
    return { tests: readers.map(([test]) => test) };
  }
  if (!graph.known.has(file)) return { all: "not in the import graph (deleted?)" };
  if (what.test) return { tests: [file], code: true };
  const above = closure([file], graph.importers);
  if (above.size > maxImporters) {
    return { all: `${above.size} transitive importers, over ${maxImporters}` };
  }
  return { tests: [...above].filter(isTest), code: true, source: true };
}

/** The convention prepush already uses: `x.ts` is covered by `x.test.ts`, imported or not. */
function ownTests(files, graph) {
  const byRoot = new Map();
  for (const file of files) {
    const prefix = sourceRoot(file);
    if (prefix !== null) {
      byRoot.set(prefix, [...(byRoot.get(prefix) ?? []), file.slice(prefix.length)]);
    }
  }
  const out = [];
  for (const [prefix, list] of byRoot) {
    const source = (p) => `${prefix}src/${p.slice("dist/".length, -".js".length)}.ts`;
    out.push(...testsForChanged(list, (p) => graph.known.has(source(p))).map(source));
  }
  return out;
}

/**
 * The selection for a list of changed paths.
 * @param {string[]} changed repository paths
 * @param {ReturnType<typeof buildGraph>} graph
 * @param {{ maxImporters?: number, maxTests?: number }} [limits]
 */
function select(changed, graph, limits = {}) {
  const maxImporters = limits.maxImporters ?? DEFAULTS.maxImporters;
  const maxTests = limits.maxTests ?? DEFAULTS.maxTests;
  const files = [...new Set(changed.map(norm).filter(Boolean))].sort();
  const all = graph.tests.map(compiledTest);
  const answer = (mode, reason, tests) => ({
    mode,
    reason,
    tests,
    changed: files,
    total: all.length,
  });
  if (files.length === 0) return answer("all", "the diff is empty", all);

  const picked = new Set();
  let sourceChanged = false;
  let codeChanged = false;
  for (const file of files) {
    const r = reach(file, graph, maxImporters);
    if (r.all) return answer("all", `${file}: ${r.all}`, all);
    for (const test of r.tests) picked.add(test);
    sourceChanged ||= r.source === true;
    codeChanged ||= r.code === true;
  }
  for (const test of ownTests(files, graph)) picked.add(test);

  // The cap counts what the graph and the document mapping selected. The forced tests below are a
  // fixed floor that does not depend on the change, so they say nothing about its reach.
  if (picked.size > maxTests) {
    return answer("all", `${picked.size} tests selected, over ${maxTests}`, all);
  }
  const before = picked.size;
  for (const [test, kind] of graph.kinds) {
    if ((sourceChanged && kind.has("cli-e2e")) || (codeChanged && kind.has("reads-source"))) {
      picked.add(test);
    }
  }
  const forced = picked.size - before;
  const note = forced > 0 ? `, ${forced} of them forced in (start the CLI or read source)` : "";
  const tests = [...picked].sort().map(compiledTest);
  return answer("selected", `${tests.length} of ${all.length} test files${note}`, tests);
}

/** The files a branch changed, or the reason they cannot be listed. */
function changedFiles(root, base, worktree) {
  const git = (args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { ok: r.status === 0, out: r.stdout ?? "" };
  };
  const mergeBase = git(["merge-base", "HEAD", base]);
  if (!mergeBase.ok || mergeBase.out.trim() === "") {
    return { error: `no merge base with ${base} (shallow checkout, or the ref is missing)` };
  }
  // --no-renames: a rename is a deletion plus an addition, and a deleted file runs everything.
  const range = worktree ? [mergeBase.out.trim()] : [mergeBase.out.trim(), "HEAD"];
  const diff = git(["diff", "--name-only", "--no-renames", ...range]);
  if (!diff.ok) return { error: "git diff failed" };
  const lines = diff.out.split("\n");
  if (worktree) lines.push(...git(["ls-files", "--others", "--exclude-standard"]).out.split("\n"));
  return { files: lines.map((l) => l.trim()).filter(Boolean) };
}

/** The test FILES with a failure in a node:test TAP report, as paths with forward slashes. */
function failingFiles(tap) {
  const out = new Set();
  const blocks = tap.split(/^(?=(?:not )?ok \d+ - )/m);
  for (const block of blocks) {
    if (!block.startsWith("not ok ")) continue;
    const name = /^not ok \d+ - (.+)$/m.exec(block)[1].trim();
    const where = /^ {2}location: '(.+?):\d+:\d+'$/m.exec(block);
    out.add(where ? norm(where[1]) : `(no location) ${name}`);
  }
  return [...out].sort();
}

/** For each failing file of a full run: was it in the selection? */
function compare(selection, tap) {
  const failing = failingFiles(tap);
  const tests = selection.tests ?? [];
  const has = (file) =>
    selection.mode !== "selected" || tests.some((t) => file === t || file.endsWith(`/${t}`));
  const missed = failing.filter((f) => !has(f));
  const lines = failing.map((f) =>
    has(f) ? `would have caught: ${f}` : `WOULD HAVE MISSED: ${f}`,
  );
  return { failing, missed, lines };
}

function selectionSummary(result) {
  return [
    "### Affected tests (shadow mode: every test still runs)",
    "",
    "| mode | selected | total | reason |",
    "| --- | --- | --- | --- |",
    `| ${result.mode} | ${result.tests.length} | ${result.total} | ${result.reason.split("|").join("/")} |`,
    "",
  ].join("\n");
}

function compareSummary(selection, result) {
  const head = "### Affected tests: would the selection have caught this run's failures?";
  if (result.failing.length === 0) return `${head}\n\nNo test file failed; nothing to compare.\n`;
  const verdict =
    result.missed.length > 0
      ? `**SELECTION WOULD HAVE MISSED ${result.missed.length} FAILING TEST FILE(S).** Mode was \`${selection.mode}\` (${selection.reason}).`
      : `All ${result.failing.length} failing test file(s) were in the selection (mode \`${selection.mode}\`).`;
  return `${head}\n\n${verdict}\n\n${result.lines.map((l) => `- ${l}`).join("\n")}\n`;
}

function writeSummary(file, text) {
  if (!file) return;
  try {
    appendFileSync(file, `${text}\n`);
  } catch (err) {
    console.error(`[affected-tests] could not write the summary: ${err.message}`);
  }
}

/** How the repository looks to the selection: the numbers that decide whether it is worth having. */
function stats(graph, limits) {
  const maxImporters = limits.maxImporters ?? DEFAULTS.maxImporters;
  const count = (kind) => [...graph.kinds.values()].filter((k) => k.has(kind)).length;
  const sources = [...graph.known].filter((f) => !isTest(f) && !isSupport(f));
  const hubs = sources.filter((f) => closure([f], graph.importers).size > maxImporters);
  return {
    testFiles: graph.tests.length,
    sourceFiles: sources.length,
    cliE2e: count("cli-e2e"),
    readsSource: count("reads-source"),
    walksMarkdown: count("walks-markdown"),
    forcedOnAnySourceChange: [...graph.kinds.values()].filter(
      (k) => k.has("cli-e2e") || k.has("reads-source"),
    ).length,
    sourcesOverImporterLimit: hubs.length,
    maxImporters,
  };
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: "string", default: "origin/main" },
      compare: { type: "boolean", default: false },
      files: { type: "string" },
      json: { type: "boolean", default: false },
      "max-importers": { type: "string" },
      "max-tests": { type: "string" },
      root: { type: "string" },
      stats: { type: "boolean", default: false },
      stdin: { type: "boolean", default: false },
      summary: { type: "string" },
      worktree: { type: "boolean", default: false },
    },
  });
  const root = resolve(values.root ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const limit = (name) => (values[name] === undefined ? undefined : Number(values[name]));
  const limits = { maxImporters: limit("max-importers"), maxTests: limit("max-tests") };

  if (values.compare) {
    const [selectionPath, tapPath] = positionals;
    const selection = JSON.parse(readFileSync(selectionPath, "utf8"));
    const result = compare(selection, readFileSync(tapPath, "utf8"));
    const text = compareSummary(selection, result);
    console.log(text);
    if (result.missed.length > 0 && process.env.GITHUB_ACTIONS) {
      console.log(`::warning title=Affected tests (shadow)::${result.lines.join("; ")}`);
    }
    writeSummary(values.summary, text);
    return;
  }

  const graph = buildGraph(root);
  if (values.stats) {
    console.log(JSON.stringify(stats(graph, limits), null, 2));
    return;
  }
  let result;
  if (values.files !== undefined || values.stdin) {
    const raw = values.stdin ? readFileSync(0, "utf8").split("\n") : values.files.split(",");
    result = select(
      raw.map((f) => f.trim()),
      graph,
      limits,
    );
  } else {
    const diff = changedFiles(root, values.base, values.worktree);
    result = diff.error
      ? { ...select([], graph, limits), reason: diff.error }
      : select(diff.files, graph, limits);
  }
  writeSummary(values.summary, selectionSummary(result));
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.mode}: ${result.reason}`);
    if (result.mode === "selected") for (const t of result.tests) console.log(t);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  try {
    main(argv);
  } catch (err) {
    // Shadow mode: this script never decides a job. An error is reported as "run everything".
    const reason = `affected-tests failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[affected-tests] ${reason}`);
    if (argv.includes("--json") && !argv.includes("--compare")) {
      console.log(JSON.stringify({ mode: "all", reason, tests: [], changed: [], total: 0 }));
    }
  }
}
