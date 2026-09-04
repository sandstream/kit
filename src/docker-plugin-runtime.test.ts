import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("Docker plugin runtime", () => {
  it("pins every Node base image to the reviewed multi-architecture manifest", async () => {
    const dockerfile = await readFile(resolve(repoRoot, "Dockerfile"), "utf-8");
    const fromLines = dockerfile.split("\n").filter((line) => line.startsWith("FROM node:"));

    assert.equal(fromLines.length, 2);
    for (const line of fromLines) {
      assert.match(line, /^FROM node:22-alpine@sha256:[a-f0-9]{64}(?: AS builder)?$/);
    }
  });

  it("retains every executable and asset required by triage-gated plugin installs", async () => {
    const dockerfile = await readFile(resolve(repoRoot, "Dockerfile"), "utf-8");
    const builder = dockerfile.slice(0, dockerfile.lastIndexOf("FROM node:22-alpine@sha256:"));
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM node:22-alpine@sha256:"));

    assert.match(builder, /COPY skills \.\/skills/);
    assert.match(runtime, /apk add[^\n\\]*(?:\\\n[^\n]*)*\bpython3\b/);
    assert.match(runtime, /npm\s+install\s+-g\s+npm@11\.19\.1\s+--ignore-scripts/);
    assert.match(runtime, /npm\s+cache\s+clean\s+--force/);
    assert.match(runtime, /COPY --from=builder[^\n]*\/build\/skills\s+\.\/skills/);
    assert.match(runtime, /chown\s+kit:kit\s+\/app/);
  });
});
