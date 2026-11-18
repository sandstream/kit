/**
 * `kit triage docker <image>:<tag>` put the tag in Docker Hub's repository path, which answers
 * HTTP 400, so every tagged image failed CRITICAL "cannot verify", official ones included. These
 * run the real triage.py against a local fixture that answers like Hub (KIT_DOCKER_REGISTRY is
 * the air-gap override, which makes it injectable).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { warmPython } from "./python-warmup.test-support.js";

// The first python3 start of a cold Windows job can outlast the 30 s per-run limit.
before(() => warmPython());

const exec = promisify(execFile);
const TRIAGE_PY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "triage",
  "scripts",
  "triage.py",
);
const REPO = { pull_count: 5_000_000, last_updated: new Date().toISOString() };
// Hub's repository API as measured on 2026-11-17: `is_official` is null even for official
// images, and the Docker Official Images are the ones under the `library` namespace.
const OFFICIAL = { ...REPO, namespace: "library", is_official: null };
const DAY = 86_400_000;
// The shape of the backdoored ARTEX image (FBI FLASH 2026-11-13): thousands of pulls within a
// month of the repository's registration. Shape only; the name is not the real one.
const YOUNG_POPULAR = {
  pull_count: 8_817,
  last_updated: new Date().toISOString(),
  date_registered: new Date(Date.now() - 27 * DAY).toISOString(),
};
const ESTABLISHED = {
  ...YOUNG_POPULAR,
  date_registered: new Date(Date.now() - 900 * DAY).toISOString(),
};
const TAGS = new Set(["qdrant/qdrant/tags/latest", "library/nginx/tags/1.27"]);

let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "").split("?")[0]).replace(
      /^\/v2\/repositories\//,
      "",
    );
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path.includes(":")) return send(400, { message: "invalid repository name" }); // as Hub does
    if (/^qdrant\/qdrant\/?$/.test(path)) return send(200, { ...REPO, namespace: "qdrant" });
    if (/^library\/nginx\/?$/.test(path)) return send(200, OFFICIAL);
    if (/^example\/young-popular\/?$/.test(path)) return send(200, YOUNG_POPULAR);
    if (/^example\/established\/?$/.test(path)) return send(200, ESTABLISHED);
    if (TAGS.has(path.replace(/\/$/, ""))) return send(200, { name: path.split("/").pop() });
    send(404, { message: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(() => server.close());

async function triage(t: { skip(m: string): void }, image: string): Promise<string | null> {
  try {
    const run = await exec("python3", ["-I", TRIAGE_PY, "docker", image], {
      env: { ...process.env, KIT_DOCKER_REGISTRY: base },
      timeout: 30_000,
    });
    return run.stdout;
  } catch (err) {
    const e = err as { code?: string | number; stdout?: string };
    if (e.code === "ENOENT") {
      t.skip("python3 not installed — triage.py's own behaviour is NOT verified in this run");
      return null;
    }
    return e.stdout ?? "";
  }
}

describe("kit triage docker: tags and digests", () => {
  for (const image of [
    "qdrant/qdrant:latest",
    "nginx:1.27",
    "qdrant/qdrant",
    "qdrant/qdrant@sha256:" + "0".repeat(64),
  ]) {
    it(`passes ${image}`, async (t) => {
      const out = await triage(t, image);
      if (out === null) return;
      assert.doesNotMatch(out, /CRITICAL/, out);
      assert.match(out, /TRIAGE PASSED/);
    });
  }

  it("fails a tag that does not exist, naming the full reference", async (t) => {
    const out = await triage(t, "qdrant/qdrant:no-such-tag");
    if (out === null) return;
    assert.match(out, /CRITICAL: image 'qdrant\/qdrant:no-such-tag' not found on Docker Hub/);
    assert.match(out, /TRIAGE FAILED/);
  });
});

describe("kit triage docker: pull count is not provenance", () => {
  it("warns on a repository under 30 days old, however many pulls it has", async (t) => {
    // Was: 8,817 pulls passed the only publisher check (< 1,000 pulls) without a word.
    const out = await triage(t, "example/young-popular");
    if (out === null) return;
    assert.match(out, /image repository is very new \(27 days\)/);
    assert.match(out, /pull count is reputation, not provenance/);
  });

  it("does not warn on age for an older repository, but still states what pulls do not show", async (t) => {
    const out = await triage(t, "example/established");
    if (out === null) return;
    assert.doesNotMatch(out, /very new/);
    assert.match(out, /pull count is reputation, not provenance/);
    assert.match(out, /TRIAGE PASSED/);
  });
});

describe("kit triage docker: official images", () => {
  it("recognises an official image by its library namespace, as Hub no longer sets is_official", async (t) => {
    // Was: official=False for nginx, and the unofficial-publisher checks ran on it.
    const out = await triage(t, "nginx:1.27");
    if (out === null) return;
    assert.match(out, /library\/nginx: 5000000 pulls, official=True/);
    assert.doesNotMatch(out, /pull count is reputation, not provenance/);
  });

  it("still treats an image under any other namespace as unofficial", async (t) => {
    const out = await triage(t, "qdrant/qdrant");
    if (out === null) return;
    assert.match(out, /official=False/);
    assert.match(out, /pull count is reputation, not provenance/);
  });
});

describe("kit triage docker: what it does not read", () => {
  it("declares the image's vulnerabilities not checked, so a PASS never reads as a clean scan", async (t) => {
    // nginx:1.31.8 carries CVE-2026-123633 and CVE-2026-123007 and passed 100/100 with nothing said.
    const out = await triage(t, "nginx:1.27");
    if (out === null) return;
    assert.match(out, /NOT CHECKED: known vulnerabilities in the image -- .*kit scan/);
    assert.match(out, /^Coverage: PARTIAL/m);
  });
});
