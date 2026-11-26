/**
 * kit-research#233 E1: a static `node:sqlite` import in the CLI's import graph printed
 * "ExperimentalWarning: SQLite is an experimental feature" on every kit call, each PreToolUse
 * gate included, though no gate opens a database. `node:sqlite` now loads in one place, on first
 * use (utils/sqlite.ts). These tests run the gates for real and check which modules loaded, and
 * scan the source so a new static import cannot bring the warning back.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLI_JS = fileURLToPath(new URL("./cli.js", import.meta.url));
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const WARNING = /SQLite is an experimental feature/;
// Reports at exit whether the `node:sqlite` builtin was loaded in this process.
const PROBE = `import { writeSync } from "node:fs";
process.on("exit", () => writeSync(2,
  "KIT_PROBE_SQLITE=" + process.moduleLoadList.includes("NativeModule sqlite") + "\\n"));
`;

function runKit(args: string[], payload?: object) {
  const dir = mkdtempSync(join(tmpdir(), "kit-lazy-sqlite-"));
  // A command that opens the memory store opens this scratch one, never the real ~/.kit.
  const isolated = { HOME: dir, USERPROFILE: dir, KIT_MEMORY_DB: join(dir, "memory.db") };
  try {
    writeFileSync(join(dir, "probe.mjs"), PROBE);
    const probe = pathToFileURL(join(dir, "probe.mjs")).href;
    return spawnSync(process.execPath, ["--import", probe, CLI_JS, ...args], {
      cwd: dir,
      encoding: "utf8",
      input: payload ? JSON.stringify(payload) : "",
      env: { ...process.env, KIT_NON_INTERACTIVE: "1", KIT_NO_UPDATE_CHECK: "1", ...isolated },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const CASES: { name: string; args: string[]; payload?: object; exit: number }[] = [
  { name: "gate-bash allow", args: ["gate-bash"], payload: bash("ls -la"), exit: 0 },
  {
    name: "gate-env allow",
    args: ["gate-env"],
    payload: { tool_name: "Edit", tool_input: { file_path: "src/a.ts", new_string: "b" } },
    exit: 0,
  },
  { name: "gate-egress allow", args: ["gate-egress"], payload: bash("ls"), exit: 0 },
  { name: "kit --version", args: ["--version"], exit: 0 },
];

describe("node:sqlite stays unloaded where nothing opens a database", () => {
  for (const c of CASES) {
    it(`${c.name}: no SQLite warning, node:sqlite not loaded`, () => {
      const r = runKit(c.args, c.payload);
      assert.equal(r.status, c.exit, `stderr: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, WARNING);
      assert.match(r.stderr, /KIT_PROBE_SQLITE=false/);
    });
  }

  // A deny writes an audit event under the SQLite-backed audit write lock (sqlite-mutex.ts), so
  // it loads node:sqlite on purpose. It must still record the event.
  it("a gate deny still records its audit event", () => {
    const r = runKit(["gate-egress"], bash("curl https://example.com"));
    assert.equal(r.status, 2, `stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /was not recorded|Failed to write audit log/);
  });

  it("still loads node:sqlite for a command that opens the memory database", () => {
    const r = runKit(["memory", "stats", "--json"]);
    assert.match(r.stderr, /KIT_PROBE_SQLITE=true/, `stderr: ${r.stderr}`);
  });
});

/** Production TypeScript under src/, as paths relative to it with `/` separators. */
function productionSources(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionSources(path));
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$|test-support|\.d\.ts$/.test(entry.name))
      out.push(relative(SRC, path).split(sep).join("/"));
  }
  return out;
}

// A value import (`import { X } from`, `import * as`, a default import) or a require/import()
// call whose result is used as a value. `import type` and `import("node:sqlite").T` type
// queries are erased at build time and load nothing.
const SQLITE = String.raw`["']node:sqlite["']`;
const VALUE_IMPORT = new RegExp(String.raw`^\s*import\s+(?!type\s)[^;]*?from\s*${SQLITE}`, "m");
const CALL = new RegExp(
  String.raw`(?<!typeof\s)(?:\brequire|\bimport|\))\(\s*${SQLITE}\s*,?\s*\)(?!\s*\.)`,
);

describe("node:sqlite is loaded only by utils/sqlite.ts", () => {
  it("no other production file imports or requires it as a value", () => {
    const offenders = productionSources().filter((file) => {
      if (file === "utils/sqlite.ts") return false;
      const text = readFileSync(join(SRC, file), "utf8");
      return VALUE_IMPORT.test(text) || CALL.test(text);
    });
    assert.deepEqual(offenders, [], "open databases with openSqlite() from utils/sqlite.ts");
  });

  it("the scan catches the forms it is meant to catch", () => {
    assert.ok(VALUE_IMPORT.test(`import { DatabaseSync } from "node:sqlite";`));
    assert.ok(VALUE_IMPORT.test(`import * as sqlite from 'node:sqlite';`));
    assert.ok(CALL.test(`createRequire(import.meta.url)("node:sqlite")`));
    assert.ok(CALL.test(`const { DatabaseSync } = await import("node:sqlite");`));
    assert.ok(!CALL.test(`as typeof import("node:sqlite");`));
    assert.ok(!VALUE_IMPORT.test(`import type { DatabaseSync } from "node:sqlite";`));
    assert.ok(!CALL.test(`let db: import("node:sqlite").DatabaseSync;`));
  });
});
