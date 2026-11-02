import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmTemp } from "./temp-cleanup.test-support.js";

/**
 * ADR-0009: cloud evidence is ingested from a file. `kit ingest` must not reach the
 * network. The preload makes every network entry point throw, so a call to one fails the
 * run. A negative control proves the preload really blocks.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");

const PRELOAD = `
import net from "node:net";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
const deny = (name) => () => { throw new Error("network blocked: " + name); };
globalThis.fetch = deny("fetch");
net.Socket.prototype.connect = deny("net.connect");
dns.lookup = deny("dns.lookup");
http.request = deny("http.request");
https.request = deny("https.request");
`;

const SARIF = {
  version: "2.1.0",
  runs: [
    {
      tool: { driver: { name: "prowler", rules: [{ id: "iam_root_mfa", name: "iam_root_mfa" }] } },
      results: [
        {
          ruleId: "iam_root_mfa",
          level: "error",
          message: { text: "root account has no MFA" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "account/123" } } }],
        },
      ],
    },
  ],
};

function setup(): { dir: string; preload: string; sarif: string } {
  const dir = mkdtempSync(join(tmpdir(), "kit-ingest-offline-"));
  const preload = join(dir, "block-network.mjs");
  const sarif = join(dir, "report.sarif");
  writeFileSync(preload, PRELOAD);
  writeFileSync(sarif, JSON.stringify(SARIF));
  return { dir, preload, sarif };
}

describe("kit ingest makes no network call (ADR-0009)", () => {
  it("ingests a SARIF file with every network entry point blocked", () => {
    const { dir, preload, sarif } = setup();
    try {
      const r = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(preload).href, CLI, "ingest", "sarif", sarif, "--json"],
        { cwd: dir, encoding: "utf8", env: { ...process.env, KIT_NO_UPDATE_CHECK: "1" } },
      );
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
      assert.equal(out.count, 1);
    } finally {
      rmTemp(dir);
    }
  });

  it("control: the preload does block a network call", () => {
    const { dir, preload } = setup();
    try {
      const r = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(preload).href, "-e", "fetch('http://127.0.0.1:9')"],
        { cwd: dir, encoding: "utf8" },
      );
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /network blocked: fetch/);
    } finally {
      rmTemp(dir);
    }
  });
});
