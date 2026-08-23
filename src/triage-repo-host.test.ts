/**
 * `kit triage repo <target>` reduces its target to `owner/repo` and asks the GitHub API
 * about it. Before #532 that reduction ignored the host: it stripped the scheme, stripped
 * only the literal `github.com/`, and took the first two path segments — so a NON-GitHub
 * URL had its hostname promoted to an "owner".
 *
 * Measured against 6.9.0:
 *
 *   kit triage repo https://example.com/a/b     -> queried the GitHub API as `example.com/a`
 *   kit triage repo https://example.com/        -> could not parse owner/repo  (correct)
 *
 * The two results were produced by a path-segment count, not a host check, which is why one
 * refused and the other did not. It was fail-closed — a 404 becomes CRITICAL, so nothing
 * could be green-lit — but the operator was told "repo '…' not found (or private)" about a
 * repo that never existed, instead of "that URL is not a repo I can check". A wrong
 * diagnosis on a security probe teaches the wrong lesson, which is the defect.
 *
 * These tests run the real `triage.py`. `KIT_GITHUB_API` is env-overridable for air-gapped
 * mirrors, which makes it injectable here, so the accepted forms are asserted end-to-end
 * against a local fixture rather than against a re-implementation of the parser. The
 * refusals need no server at all: they happen before any request.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
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

describe("triage repo: the target must name a repo this probe can actually check (#532)", () => {
  let server: Server;
  let base = "";
  /** Every accepted spelling must land here, and nothing else may be requested. */
  const requested: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      requested.push(req.url ?? "");
      if (req.url === "/repos/owner/repo") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            stargazers_count: 1234,
            license: { spdx_id: "MIT" },
            archived: false,
            disabled: false,
            pushed_at: new Date(Date.now() - 86_400_000).toISOString(),
            created_at: new Date(Date.now() - 400 * 86_400_000).toISOString(),
          }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no fixture port");
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  /**
   * Skips LOUDLY when python3 is absent: the script under test IS python, so a silent skip
   * would report a passing suite for a probe that never ran.
   */
  const runRepo = async (
    target: string,
    t: { skip: (m: string) => void },
  ): Promise<string | null> => {
    try {
      const { stdout } = await exec("python3", [TRIAGE_PY, "repo", target], {
        // No token, and a fixture base: nothing reaches the real GitHub.
        env: { ...process.env, KIT_GITHUB_API: base, GITHUB_TOKEN: "", GH_TOKEN: "" },
        timeout: 30_000,
      });
      return stdout;
    } catch (err) {
      const e = err as { code?: string | number; stdout?: string };
      if (e.code === "ENOENT") {
        t.skip("python3 not installed — triage.py's own behaviour is NOT verified in this run");
        return null;
      }
      throw err;
    }
  };

  // ─── the equivalent spellings of one repo ────────────────────────────────────────────

  const ACCEPTED = [
    "owner/repo",
    "https://github.com/owner/repo",
    "http://github.com/owner/repo",
    "github.com/owner/repo",
    "https://www.github.com/owner/repo",
    "https://github.com/owner/repo/",
    "https://github.com/owner/repo.git",
    "https://github.com/owner/repo/tree/main",
    "git@github.com:owner/repo.git",
  ];

  for (const target of ACCEPTED) {
    it(`accepts ${target} and resolves it to the same repo`, async (t) => {
      const out = await runRepo(target, t);
      if (out === null) return;
      // The fact line is printed with the resolved owner/repo, so this asserts the
      // reduction, not merely that the run completed.
      assert.match(out, /owner\/repo: 1234 stars, license: MIT/);
      assert.doesNotMatch(out, /could not parse/);
      assert.doesNotMatch(out, /is not a github\.com repo URL/);
    });
  }

  it("a raw file URL still names its repo, so it resolves instead of being refused", async (t) => {
    // The common way a piped installer is cited. Refusing it would be technically true and
    // practically useless: the URL names the repo unambiguously.
    const out = await runRepo("https://raw.githubusercontent.com/owner/repo/main/install.sh", t);
    if (out === null) return;
    assert.match(out, /owner\/repo: 1234 stars/);
  });

  // ─── the regression this file exists for ─────────────────────────────────────────────

  const UNSUPPORTED_HOSTS = [
    "https://example.com/a/b",
    "https://fx.sh/setup.sh",
    "https://gitlab.com/owner/repo",
    "https://example.com/",
    "https://example.com/a/b/c/d",
  ];

  for (const target of UNSUPPORTED_HOSTS) {
    it(`refuses ${target} by host, and never asks GitHub about it`, async (t) => {
      const before = requested.length;
      const out = await runRepo(target, t);
      if (out === null) return;

      assert.match(out, /is not a github\.com repo URL/);
      assert.match(out, /TRIAGE FAILED/);

      // The heart of #532: the old code produced a verdict about a fabricated repo.
      // Neither "not found" nor a rate-limit line may appear for a non-repo URL.
      assert.doesNotMatch(out, /not found \(or private\)/);
      assert.doesNotMatch(out, /rate-limited/);

      // And it must refuse BEFORE the network, not by relying on a 404 to save it.
      assert.equal(
        requested.length,
        before,
        `a request was made for ${target}: ${requested.slice(before).join(", ")}`,
      );
    });
  }

  it("keeps the two refusals distinct — a shapeless target is not a host problem", async (t) => {
    const out = await runRepo("not-a-url-at-all", t);
    if (out === null) return;
    assert.match(out, /could not parse owner\/repo from 'not-a-url-at-all'/);
    assert.doesNotMatch(out, /is not a github\.com repo URL/);
  });

  it("a bare owner with no repo is shapeless, not a host problem", async (t) => {
    const out = await runRepo("owner", t);
    if (out === null) return;
    assert.match(out, /could not parse owner\/repo/);
    assert.doesNotMatch(out, /is not a github\.com repo URL/);
  });

  it("a genuinely missing GitHub repo still reports not-found — the 404 path is intact", async (t) => {
    const out = await runRepo("owner/does-not-exist", t);
    if (out === null) return;
    assert.match(out, /not found \(or private\)/);
    assert.match(out, /TRIAGE FAILED/);
  });
});
