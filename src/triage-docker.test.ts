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
    if (/^(qdrant\/qdrant|library\/nginx)\/?$/.test(path)) return send(200, REPO);
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
