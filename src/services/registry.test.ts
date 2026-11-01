/**
 * The services registry under concurrent writers, and the lease arithmetic.
 *
 * The concurrency test spawns real processes against one file: the failure it guards against is
 * two agents registering at the same moment and one entry silently vanishing (read, read, write,
 * write). An in-process loop cannot interleave like that.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmTemp } from "../temp-cleanup.test-support.js";
import {
  leaseActive,
  mutateRegistry,
  parseTtl,
  readRegistry,
  validateRef,
  type ServiceEntry,
} from "./registry.js";

const REGISTRY_MODULE = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "registry.js"),
).href;

function entry(name: string, leaseUntil: string): ServiceEntry {
  return {
    name,
    kind: "container",
    ref: name,
    project: "/p",
    owner: { agent: "claude", session: "s1" },
    startedAt: new Date(0).toISOString(),
    leaseUntil,
  };
}

function runWriter(file: string, name: string): Promise<number> {
  const script = `
    const { mutateRegistry } = await import(${JSON.stringify(REGISTRY_MODULE)});
    mutateRegistry((reg) => {
      reg.services.push({ name: ${JSON.stringify(name)}, kind: "container", ref: "r", project: "/p",
        owner: { agent: "unknown" }, startedAt: "x", leaseUntil: "x" });
      return { result: undefined };
    }, ${JSON.stringify(file)});
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

describe("services registry", () => {
  it("keeps every entry when many processes write at the same time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-services-reg-"));
    try {
      const file = join(dir, "services.json");
      const names = Array.from({ length: 12 }, (_, i) => `w${i}`);
      const codes = await Promise.all(names.map((n) => runWriter(file, n)));
      assert.deepEqual(
        codes,
        names.map(() => 0),
      );
      const got = readRegistry(file)
        .services.map((e) => e.name)
        .sort();
      assert.deepEqual(got, [...names].sort());
      // No lock file or temp file is left behind.
      assert.deepEqual(readdirSync(dir), ["services.json"]);
    } finally {
      rmTemp(dir);
    }
  });

  it("does not write when the change says write: false", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-services-reg-"));
    try {
      const file = join(dir, "services.json");
      mutateRegistry(() => ({ result: undefined, write: false }), file);
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmTemp(dir);
    }
  });

  it("refuses a corrupt file instead of treating it as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-services-reg-"));
    try {
      const file = join(dir, "services.json");
      writeFileSync(file, "{not json");
      assert.throws(() => readRegistry(file), /not valid JSON/);
      assert.throws(() => mutateRegistry(() => ({ result: 1 }), file), /not valid JSON/);
    } finally {
      rmTemp(dir);
    }
  });

  it("takes over a stale lock left by a crashed writer", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-services-reg-"));
    try {
      const file = join(dir, "services.json");
      const lock = `${file}.lock`;
      writeFileSync(lock, "99999\n");
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      mutateRegistry((reg) => {
        reg.services.push(entry("a", new Date().toISOString()));
        return { result: undefined };
      }, file);
      assert.equal(readRegistry(file).services.length, 1);
    } finally {
      rmTemp(dir);
    }
  });

  it("computes the lease from leaseUntil", () => {
    const now = Date.parse("2026-11-01T12:00:00Z");
    assert.equal(leaseActive(entry("a", "2026-11-01T12:00:01Z"), now), true);
    assert.equal(leaseActive(entry("a", "2026-11-01T12:00:00Z"), now), false);
    assert.equal(leaseActive(entry("a", "garbage"), now), false);
  });

  it("parses TTLs and rejects nonsense", () => {
    assert.equal(parseTtl(undefined), 4 * 3_600_000);
    assert.equal(parseTtl("30m"), 30 * 60_000);
    assert.equal(parseTtl("2d"), 2 * 86_400_000);
    assert.equal(parseTtl("0h"), null);
    assert.equal(parseTtl("31d"), null);
    assert.equal(parseTtl("4 hours"), null);
  });

  it("validates refs before they reach a command line", () => {
    assert.equal(validateRef("pid", "123"), null);
    assert.notEqual(validateRef("pid", "0"), null);
    assert.equal(validateRef("port", "54321"), null);
    assert.notEqual(validateRef("port", "70000"), null);
    assert.equal(validateRef("supabase", "my-project_1"), null);
    assert.notEqual(validateRef("supabase", "x; rm -rf /"), null);
    assert.notEqual(validateRef("container", "-rf"), null);
  });
});
