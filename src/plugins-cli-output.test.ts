import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdPlugin } from "./plugins-cli.js";

// eslint-disable-next-line no-control-regex
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

interface Run {
  code: number;
  out: string;
  err: string;
}

/** Run cmdPlugin in-process with argv set and console captured. Exit value 0 = true, 1 = false. */
async function kitPlugin(args: string[]): Promise<Run> {
  const argv = process.argv;
  const log = console.log;
  const error = console.error;
  let out = "";
  let err = "";
  console.log = (...a: unknown[]) => void (out += `${a.join(" ")}\n`);
  console.error = (...a: unknown[]) => void (err += `${a.join(" ")}\n`);
  process.argv = [argv[0], argv[1], "plugin", ...args];
  try {
    const ok = await cmdPlugin();
    return { code: ok ? 0 : 1, out: plain(out), err: plain(err) };
  } finally {
    process.argv = argv;
    console.log = log;
    console.error = error;
  }
}

describe("kit plugin output", () => {
  it("prints the usage for no subcommand, --help and -h, with exit 0", async () => {
    const outputs: string[] = [];
    for (const args of [[], ["--help"], ["-h"]]) {
      const r = await kitPlugin(args);
      assert.equal(r.code, 0);
      outputs.push(r.out);
    }
    assert.equal(outputs[1], outputs[0]);
    assert.equal(outputs[2], outputs[0]);
    for (const line of [
      "kit plugin — discover and manage kit plugins",
      "kit plugin list [--tag TAG] [--installed]  List plugins",
      "kit plugin scaffold <name> [--skip-install]  Create a new plugin from template",
      "kit plugin tags                      List all available plugin tags",
      "kit plugin uninstall railway         # Remove package and adapter registration",
    ]) {
      assert.ok(outputs[0].includes(line), `help lacks: ${line}`);
    }
  });

  it("list shows every plugin, and a tag filter names the tag in the header", async () => {
    const all = await kitPlugin(["list"]);
    assert.equal(all.code, 0);
    assert.match(all.out, /^Available Plugins — \d+ found\n/);
    const filtered = await kitPlugin(["list", "--tag", "database"]);
    assert.equal(filtered.code, 0);
    assert.match(filtered.out, /^Available Plugins \(database\) — \d+ found\n/);
  });

  it("list with a tag nothing has says so and still exits 0", async () => {
    const r = await kitPlugin(["list", "--tag", "no-such-tag"]);
    assert.equal(r.code, 0);
    assert.equal(r.out, "No plugins found with tag: no-such-tag\n");
  });

  it("search needs a query, reports no match, and lists a match", async () => {
    const missing = await kitPlugin(["search"]);
    assert.equal(missing.code, 1);
    assert.equal(missing.err, "Error: search query required\n");
    const none = await kitPlugin(["search", "zzzqqqxxx"]);
    assert.equal(none.code, 0);
    assert.equal(none.out, "No plugins found matching: zzzqqqxxx\n");
    const hit = await kitPlugin(["search", "railway"]);
    assert.equal(hit.code, 0);
    assert.match(hit.out, /^Search Results for "railway" — \d+ found\n/);
  });

  it("info needs a name, rejects an unknown one, and shows details for a known one", async () => {
    const missing = await kitPlugin(["info"]);
    assert.equal(missing.code, 1);
    assert.equal(missing.err, "Error: plugin name required\n");
    const unknown = await kitPlugin(["info", "no-such-plugin"]);
    assert.equal(unknown.code, 1);
    assert.equal(unknown.err, "Error: plugin not found: no-such-plugin\n");
    const known = await kitPlugin(["info", "railway"]);
    assert.equal(known.code, 0);
    assert.match(known.out, /^Plugin Details\n\n/);
  });

  it("install needs a name and rejects an unknown one before it installs anything", async () => {
    const missing = await kitPlugin(["install"]);
    assert.equal(missing.code, 1);
    assert.equal(missing.err, "Error: plugin name required\n");
    const unknown = await kitPlugin(["install", "no-such-plugin"]);
    assert.equal(unknown.code, 1);
    assert.equal(unknown.err, "Error: plugin not found: no-such-plugin\n");
    assert.equal(unknown.out, "");
  });

  it("uninstall needs a name with its usage line and rejects an unknown one", async () => {
    const missing = await kitPlugin(["uninstall"]);
    assert.equal(missing.code, 1);
    assert.equal(missing.err, "Error: plugin name required\nUsage: kit plugin uninstall <name>\n");
    const unknown = await kitPlugin(["uninstall", "no-such-plugin"]);
    assert.equal(unknown.code, 1);
    assert.equal(unknown.err, "Error: plugin not found: no-such-plugin\n");
  });

  it("tags prints the categories in rows of three", async () => {
    const r = await kitPlugin(["tags"]);
    assert.equal(r.code, 0);
    const lines = r.out.trimEnd().split("\n");
    assert.match(lines[0], /^Available Tags — \d+ categories$/);
    assert.equal(lines[1], "");
    const count = Number(/— (\d+) categories/.exec(lines[0])?.[1]);
    const words = lines.slice(2).flatMap((l) => l.trim().split(/\s+/));
    assert.equal(words.length, count);
    assert.equal(lines.length - 2, Math.ceil(count / 3));
  });

  it("scaffold needs a name and shows the usage and an example", async () => {
    const r = await kitPlugin(["scaffold"]);
    assert.equal(r.code, 1);
    assert.equal(
      r.err,
      [
        "Error: plugin name required",
        "Usage: kit plugin scaffold <name>",
        "Example: kit plugin scaffold my-stripe-adapter",
        "",
      ].join("\n"),
    );
  });

  it("an unknown subcommand points at --help and exits 1", async () => {
    const r = await kitPlugin(["frobnicate"]);
    assert.equal(r.code, 1);
    assert.equal(
      r.err,
      "Unknown subcommand: frobnicate\nRun 'kit plugin --help' for usage information.\n",
    );
  });
});

describe("kit plugin failures in an empty folder", () => {
  /** Run `fn` with the working directory set to a fresh empty folder. */
  async function inEmptyFolder(fn: () => Promise<void>): Promise<void> {
    const before = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "kit-plugin-empty-"));
    process.chdir(dir);
    try {
      await fn();
    } finally {
      process.chdir(before);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("uninstall of a known plugin reports the missing package.json and exits 1", async () => {
    await inEmptyFolder(async () => {
      const r = await kitPlugin(["uninstall", "railway"]);
      assert.equal(r.code, 1);
      assert.equal(r.out, "");
      assert.equal(
        r.err,
        "\u2717 Cannot uninstall railway: Project package.json required; run npm init first\n",
      );
    });
  });

  it("scaffold with an invalid name reports the error from the catch branch", async () => {
    await inEmptyFolder(async () => {
      const r = await kitPlugin(["scaffold", "Bad Name!"]);
      assert.equal(r.code, 1);
      assert.equal(r.out, "Scaffolding plugin: Bad Name!...\n");
      assert.equal(
        r.err,
        'Error: Invalid plugin scaffold name "Bad Name!"; use a lowercase npm slug\n',
      );
    });
  });
});
