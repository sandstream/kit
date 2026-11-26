import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { triageRelease, type ReleaseDeps, type ReleaseOptions } from "./release-triage.js";
import { makeTarGz } from "./release-fixtures.test-support.js";

const API = "https://api.h.example";
const BASE = "https://github.com/acme/tool/releases/download/v1.2.3";
const ASSET = "tool-linux-amd64.tar.gz";
const URL_ = `${BASE}/${ASSET}`;
const BYTES = makeTarGz([{ name: "tool", mode: 0o755, data: "\x7fELF" }]);
const SHA = createHash("sha256").update(BYTES).digest("hex");

let dir: string;
let file: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-release-triage-"));
  file = join(dir, ASSET);
  writeFileSync(file, BYTES);
});
after(() => rmSync(dir, { recursive: true, force: true }));

function release(assets: string[], extra: Record<string, unknown> = {}): unknown {
  return {
    tag_name: "v1.2.3",
    published_at: "2026-10-01T00:00:00Z",
    url: `${API}/repos/acme/tool/releases/1`,
    assets: [ASSET, ...assets].map((name) => ({ name, browser_download_url: `${BASE}/${name}` })),
    ...extra,
  };
}

function deps(texts: Record<string, string>, rel: unknown, ageOk = true): ReleaseDeps {
  return {
    githubApi: API,
    fetchText: async (u) => texts[u] ?? null,
    getJson: async (u) => (u === `${API}/repos/acme/tool/releases/tags/v1.2.3` ? rel : null),
    age: async (_r, tag) =>
      ageOk
        ? { status: "pass", detail: `${tag} was published 56 days ago` }
        : { status: "fail", detail: "cooling: 2 days, limit 14" },
  };
}

const opts = (o: Partial<ReleaseOptions> = {}): ReleaseOptions => ({ accept: [], ...o });
const status = (r: { checks: { name: string; status: string }[] }, name: string) =>
  r.checks.find((c) => c.name === name)?.status;

describe("kit triage release: checksum", () => {
  it("matches the publisher's checksums.txt found in the GitHub release", async () => {
    const d = deps(
      { [`${BASE}/checksums.txt`]: `${SHA}  ${ASSET}\n${"0".repeat(64)}  other\n` },
      release(["checksums.txt"]),
    );
    const r = await triageRelease({ url: URL_, file }, opts({ repo: "acme/tool" }), d);
    assert.equal(status(r, "checksum"), "pass");
    assert.equal(status(r, "age"), "pass");
    assert.equal(status(r, "repository"), "pass");
    assert.equal(status(r, "archive"), "pass");
    assert.equal(status(r, "signature"), "unverified");
    assert.equal(r.passed, false, "an unverified signature is never a silent pass");
    const accepted = await triageRelease(
      { url: URL_, file },
      opts({ repo: "acme/tool", accept: ["signature"] }),
      d,
    );
    assert.equal(accepted.passed, true);
    assert.deepEqual(accepted.accepted, ["signature"]);
  });

  it("fails a checksum that does not match, or two sources that disagree", async () => {
    const wrong = deps(
      { [`${BASE}/SHA256SUMS`]: `${"a".repeat(64)}  ${ASSET}\n` },
      release(["SHA256SUMS"]),
    );
    assert.equal(
      status(await triageRelease({ url: URL_, file }, opts(), wrong), "checksum"),
      "fail",
    );
    const rel = release(["checksums.txt"]) as { assets: { name: string; digest?: string }[] };
    rel.assets[0]!.digest = `sha256:${"b".repeat(64)}`;
    const both = deps({ [`${BASE}/checksums.txt`]: `${SHA}  ${ASSET}\n` }, rel);
    const r = await triageRelease({ url: URL_, file }, opts(), both);
    assert.equal(status(r, "checksum"), "fail");
    assert.match(r.checks[0]!.detail, /the GitHub asset digest says b{64}/);
  });
});

describe("kit triage release: age and repository", () => {
  it("fails a release inside the cooling period, a draft, a latest URL, a moved or unexpected repository", async () => {
    const young = await triageRelease({ url: URL_, file }, opts(), deps({}, release([]), false));
    assert.equal(status(young, "age"), "fail");
    const draft = await triageRelease(
      { url: URL_, file },
      opts(),
      deps({}, release([], { draft: true })),
    );
    assert.equal(status(draft, "age"), "fail");
    const latest = `https://github.com/acme/tool/releases/latest/download/${ASSET}`;
    assert.equal(
      status(await triageRelease({ url: latest, file }, opts(), deps({}, null)), "age"),
      "fail",
    );
    const moved = release([], { url: `${API}/repos/evil/tool/releases/1` });
    const r = await triageRelease(
      { url: URL_, file },
      opts({ repo: "acme/tool" }),
      deps({}, moved),
    );
    assert.match(
      r.checks.find((c) => c.name === "repository")!.detail,
      /serves the release from evil\/tool/,
    );
    const other = await triageRelease(
      { url: URL_, file },
      opts({ repo: "acme/other" }),
      deps({}, release([])),
    );
    assert.equal(status(other, "repository"), "fail");
  });

  it("is unverified, not pass, off GitHub, under air-gap, or for a local file with no URL", async () => {
    const off = await triageRelease(
      { url: `https://h.example/dl/${ASSET}`, file },
      opts({ sha256: SHA }),
      deps({}, null),
    );
    assert.equal(status(off, "age"), "unverified");
    assert.equal(status(off, "repository"), "unverified");
    const air = await triageRelease({ url: URL_, file }, opts(), {
      ...deps({}, release([])),
      githubApi: null,
    });
    assert.equal(status(air, "age"), "unverified");
    const local = await triageRelease({ url: null, file }, opts(), deps({}, null));
    assert.equal(status(local, "checksum"), "unverified");
    assert.equal(local.passed, false);
  });
});
