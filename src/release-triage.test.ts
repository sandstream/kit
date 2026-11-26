import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
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

  it("takes --checksum before anything published, and reads a BSD-style or per-asset file", async () => {
    const d = deps({}, release([]));
    assert.equal(
      status(await triageRelease({ url: URL_, file }, opts({ sha256: SHA }), d), "checksum"),
      "pass",
    );
    const bsd = opts({ shasumsText: `SHA256 (${ASSET}) = ${SHA}\n` });
    assert.equal(status(await triageRelease({ url: URL_, file }, bsd, d), "checksum"), "pass");
    const own = deps({ [`${URL_}.sha256`]: `${SHA}\n` }, release([`${ASSET}.sha256`]));
    assert.equal(status(await triageRelease({ url: URL_, file }, opts(), own), "checksum"), "pass");
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

function minisignPair(): { pub: string; key: KeyObject; id: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const id = Buffer.from("0123456789abcdef", "hex");
  const pub = `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from("Ed"), id, x]).toString("base64")}\n`;
  return { pub, key: privateKey, id };
}

function minisig(data: Buffer, key: KeyObject, id: Buffer, trusted = "timestamp:1"): string {
  const hash = createHash("blake2b512").update(data).digest();
  const sig = sign(null, hash, key);
  const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), key);
  const line = Buffer.concat([Buffer.from("ED"), id, sig]).toString("base64");
  return `untrusted comment: sig\n${line}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
}

describe("kit triage release: signatures", () => {
  it("verifies a minisign signature on the asset with the user's key, and fails another key's", async () => {
    const { pub, key, id } = minisignPair();
    const d = deps({ [`${URL_}.minisig`]: minisig(BYTES, key, id) }, release([`${ASSET}.minisig`]));
    const r = await triageRelease({ url: URL_, file }, opts({ minisignKey: pub }), d);
    assert.equal(status(r, "signature"), "pass", r.checks[1]!.detail);
    const other = minisignPair();
    const bad = await triageRelease({ url: URL_, file }, opts({ minisignKey: other.pub }), d);
    assert.equal(status(bad, "signature"), "fail");
    const tampered = deps(
      { [`${URL_}.minisig`]: minisig(Buffer.from("other"), key, id) },
      release([`${ASSET}.minisig`]),
    );
    assert.equal(
      status(
        await triageRelease({ url: URL_, file }, opts({ minisignKey: pub }), tampered),
        "signature",
      ),
      "fail",
    );
  });

  it("verifies a cosign key signature on the checksum list, which covers the asset", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const list = `${SHA}  ${ASSET}\n`;
    const sig = sign("sha256", Buffer.from(list), privateKey).toString("base64");
    const d = deps(
      { [`${BASE}/checksums.txt`]: list, [`${BASE}/checksums.txt.sig`]: sig },
      release(["checksums.txt", "checksums.txt.sig"]),
    );
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const r = await triageRelease({ url: URL_, file }, opts({ cosignKey: pem }), d);
    assert.equal(status(r, "signature"), "pass", r.checks[1]!.detail);
  });

  it("is unverified for a signature with no key, and fails a key with no signature", async () => {
    const d = deps({ [`${URL_}.asc`]: "-----BEGIN PGP SIGNATURE-----" }, release([`${ASSET}.asc`]));
    const r = await triageRelease({ url: URL_, file }, opts(), d);
    assert.equal(status(r, "signature"), "unverified");
    assert.match(r.checks[1]!.detail, /OpenPGP/);
    const keyOnly = await triageRelease(
      { url: URL_, file },
      opts({ minisignKey: minisignPair().pub }),
      deps({}, release([])),
    );
    assert.equal(status(keyOnly, "signature"), "fail");
  });
});
