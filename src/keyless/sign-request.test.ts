import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, recordRevocation } from "../identity.js";
import { PROFILE_FILE } from "../profile/schema.js";
import { signProfile } from "../profile/sign.js";
import { signOutbound, verifyInbound, hostRequiresSigning } from "./sign-request.js";
import type { SignableRequest } from "./http-sig.js";

let idDir: string;
let proj: string;
let savedIdEnv: string | undefined;

const REQ: SignableRequest = {
  method: "POST",
  url: "https://api.acme.com/v1/charge",
  headers: { "content-type": "application/json" },
};

const withSign = `version = 1\n[scope]\negress = ["api.acme.com"]\nsign = ["api.acme.com"]\n`;

beforeEach(() => {
  idDir = mkdtempSync(join(tmpdir(), "kit-id-"));
  proj = mkdtempSync(join(tmpdir(), "kit-keyless-"));
  savedIdEnv = process.env.KIT_IDENTITY_DIR;
  process.env.KIT_IDENTITY_DIR = idDir;
  loadOrCreateIdentity();
});

afterEach(() => {
  if (savedIdEnv === undefined) delete process.env.KIT_IDENTITY_DIR;
  else process.env.KIT_IDENTITY_DIR = savedIdEnv;
  rmSync(idDir, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

describe("keyless hostRequiresSigning", () => {
  it("matches exact and suffix hosts, empty list matches nothing", () => {
    assert.equal(hostRequiresSigning("https://api.acme.com/x", ["api.acme.com"]), true);
    assert.equal(hostRequiresSigning("https://a.internal.io/x", [".internal.io"]), true);
    assert.equal(hostRequiresSigning("https://api.acme.com/x", []), false);
    assert.equal(hostRequiresSigning("https://other.com/x", ["api.acme.com"]), false);
  });
});

describe("keyless signOutbound", () => {
  it("not-required when the host is not declared keyless", async () => {
    writeFileSync(join(proj, PROFILE_FILE), `version = 1\n[scope]\negress = ["api.acme.com"]\n`);
    await signProfile(proj);
    const r = await signOutbound(REQ, { root: proj, dir: idDir });
    assert.equal(r.status, "not-required");
  });

  it("denied (fail-closed) when the host is keyless but the scope is UNVERIFIED", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign); // written but NOT signed
    const r = await signOutbound(REQ, { root: proj, dir: idDir });
    assert.equal(r.status, "denied");
    assert.match(r.detail, /unverified/);
  });

  it("signs a keyless host when the scope is verified, and verifyInbound accepts it", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign);
    await signProfile(proj);
    const r = await signOutbound(REQ, { root: proj, dir: idDir, now: new Date(1_000_000_000_000) });
    assert.equal(r.status, "signed", r.detail);
    if (r.status !== "signed") return;
    assert.match(r.keyid, /^kid_/);
    const v = verifyInbound(
      REQ,
      { signatureInput: r.headers["Signature-Input"], signature: r.headers.Signature },
      { dir: idDir, now: new Date(1_000_000_060_000) },
    );
    assert.equal(v.valid, true, v.detail);
  });

  it("verifyInbound rejects a tampered request", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign);
    await signProfile(proj);
    const r = await signOutbound(REQ, { root: proj, dir: idDir, now: new Date(1_000_000_000_000) });
    assert.equal(r.status, "signed");
    if (r.status !== "signed") return;
    const v = verifyInbound(
      { ...REQ, url: "https://api.acme.com/v1/refund" },
      { signatureInput: r.headers["Signature-Input"], signature: r.headers.Signature },
      { dir: idDir, now: new Date(1_000_000_060_000) },
    );
    assert.equal(v.valid, false);
  });

  it("denied when the signing identity is revoked (fail-closed)", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign);
    await signProfile(proj);
    const id = loadOrCreateIdentity().identity;
    recordRevocation(id.id, "compromised", idDir);
    const r = await signOutbound(REQ, { root: proj, dir: idDir });
    assert.equal(r.status, "denied");
    assert.match(r.detail, /revoked/);
  });

  it("verifyInbound rejects a signature from a revoked signer", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign);
    await signProfile(proj);
    const r = await signOutbound(REQ, { root: proj, dir: idDir, now: new Date(1_000_000_000_000) });
    assert.equal(r.status, "signed");
    if (r.status !== "signed") return;
    recordRevocation(r.keyid, "compromised", idDir);
    const v = verifyInbound(
      REQ,
      { signatureInput: r.headers["Signature-Input"], signature: r.headers.Signature },
      { dir: idDir, now: new Date(1_000_000_060_000) },
    );
    assert.equal(v.valid, false);
  });
});

/** Fixed signing clock: `created` lands on unix second 1_000_000_000 exactly. */
const SIGN_AT = new Date(1_000_000_000_000);

/** Write + sign a profile marking `api.acme.com` keyless, then mint headers for `req`. */
async function mintSignedHeaders(
  req: SignableRequest = REQ,
  extra: { now?: Date; ttlSeconds?: number; components?: string[] } = {},
): Promise<{ signatureInput: string; signature: string; keyid: string }> {
  writeFileSync(join(proj, PROFILE_FILE), withSign);
  const signed = await signProfile(proj);
  assert.equal(signed.ok, true, signed.error);
  const r = await signOutbound(req, { root: proj, dir: idDir, now: SIGN_AT, ...extra });
  assert.equal(r.status, "signed", r.detail);
  if (r.status !== "signed") throw new Error("unreachable: signOutbound refused to sign");
  return {
    signatureInput: r.headers["Signature-Input"],
    signature: r.headers.Signature,
    keyid: r.keyid,
  };
}

describe("keyless signOutbound — fail-closed edges and minted parameters", () => {
  it("is not-required when no profile is declared at all", async () => {
    // An empty project declares no keyless host, so the caller keeps its normal credential
    // path. This must NOT be a deny: only a DECLARED host is allowed to fail closed.
    const r = await signOutbound(REQ, { root: proj, dir: idDir });
    assert.equal(r.status, "not-required");
  });

  it("denies when a signed profile is edited afterwards to add the keyless host", async () => {
    writeFileSync(join(proj, PROFILE_FILE), `version = 1\n[scope]\negress = ["api.acme.com"]\n`);
    assert.equal((await signProfile(proj)).ok, true);
    // Post-signature edit: `.kit-profile.sig` no longer covers these bytes. A tampered sign
    // list must grant nothing, or anyone able to write the profile could aim kit's identity
    // at a host of their choosing.
    writeFileSync(join(proj, PROFILE_FILE), withSign);
    const r = await signOutbound(REQ, { root: proj, dir: idDir });
    assert.equal(r.status, "denied", r.detail);
    assert.match(r.detail, /unverified/);
  });

  it("denies when the host is keyless but the identity dir holds no identity", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign);
    await signProfile(proj);
    const empty = mkdtempSync(join(tmpdir(), "kit-noid-"));
    try {
      // No identity ⇒ no proof of who we are. Deny; never fall through to "not-required",
      // which the caller would read as permission to use a stored bearer token instead.
      const r = await signOutbound(REQ, { root: proj, dir: empty });
      assert.equal(r.status, "denied", r.detail);
      assert.match(r.detail, /no identity/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("denies (never throws) when the record exists but the key file is gone", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign);
    await signProfile(proj);
    const partial = mkdtempSync(join(tmpdir(), "kit-partial-"));
    try {
      // A half-provisioned identity dir: public record present, `identity.key` absent. The
      // signer throws ENOENT inside signOutbound and that must surface as a denial, not as
      // an exception escaping into the caller's request path.
      writeFileSync(
        join(partial, "identity.json"),
        JSON.stringify({
          id: "kid_00000000000000000000000000000000",
          algo: "ed25519",
          publicKey: "-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----\n",
          createdAt: "2020-01-01T00:00:00.000Z",
        }) + "\n",
      );
      const r = await signOutbound(REQ, { root: proj, dir: partial });
      assert.equal(r.status, "denied", r.detail);
      assert.match(r.detail, /cannot sign/);
    } finally {
      rmSync(partial, { recursive: true, force: true });
    }
  });

  it("denies instead of signing when a hardware identity is mandated", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign);
    await signProfile(proj); // sign the profile BEFORE the mandate is in force
    const saved = process.env.KIT_REQUIRE_HARDWARE_IDENTITY;
    process.env.KIT_REQUIRE_HARDWARE_IDENTITY = "1";
    try {
      // The mandate says the key must live outside kit, so the same-UID file key must not be
      // used. A keyless host with no usable key is a deny — the whole point of the mandate is
      // that it cannot be satisfied by the file key it is meant to retire.
      const r = await signOutbound(REQ, { root: proj, dir: idDir });
      assert.equal(r.status, "denied", r.detail);
      assert.match(r.detail, /cannot sign/);
    } finally {
      if (saved === undefined) delete process.env.KIT_REQUIRE_HARDWARE_IDENTITY;
      else process.env.KIT_REQUIRE_HARDWARE_IDENTITY = saved;
    }
  });

  it("denies when a requested covered component cannot be derived from the request", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign);
    await signProfile(proj);
    // REQ carries no `x-request-id`. Rather than sign a base that silently omits a component
    // the Signature-Input claims to cover, signing fails and the outcome is a deny.
    const r = await signOutbound(REQ, {
      root: proj,
      dir: idDir,
      components: ["@method", "x-request-id"],
    });
    assert.equal(r.status, "denied", r.detail);
    assert.match(r.detail, /cannot sign: covered header not present/);
  });

  it("mints created/expires from the injected clock and ttlSeconds", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign);
    await signProfile(proj);
    const r = await signOutbound(REQ, { root: proj, dir: idDir, now: SIGN_AT, ttlSeconds: 60 });
    assert.equal(r.status, "signed", r.detail);
    if (r.status !== "signed") return;
    // The replay window is exactly [created, created+ttl] and is derived from the injected
    // clock, not the wall clock — a widened or missing `expires` would extend replay life.
    assert.match(r.headers["Signature-Input"], /;created=1000000000;/);
    assert.match(r.headers["Signature-Input"], /;expires=1000000060(;|$)/);
    assert.match(r.headers["Signature-Input"], /;alg="ed25519"/);
    assert.equal(r.detail, `signed by ${r.keyid}, expires in 60s`);
  });

  it("defaults the replay window to 300 seconds", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign);
    await signProfile(proj);
    const r = await signOutbound(REQ, { root: proj, dir: idDir, now: SIGN_AT });
    assert.equal(r.status, "signed", r.detail);
    if (r.status !== "signed") return;
    // A signature with no bound (or a much longer one) is a replay primitive; pin the default.
    assert.match(r.headers["Signature-Input"], /;expires=1000000300(;|$)/);
  });

  it("covers the requested components in the requested order", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign);
    await signProfile(proj);
    const components = ["@method", "@authority", "@path", "@query", "content-type"];
    const r = await signOutbound(REQ, { root: proj, dir: idDir, now: SIGN_AT, components });
    assert.equal(r.status, "signed", r.detail);
    if (r.status !== "signed") return;
    // Component ORDER is part of the signature base, so it is part of the wire contract:
    // reordering here silently invalidates every signature a peer is mid-verification on.
    assert.equal(
      r.headers["Signature-Input"].startsWith(
        'sig1=("@method" "@authority" "@path" "@query" "content-type")',
      ),
      true,
      r.headers["Signature-Input"],
    );
    const v = verifyInbound(
      REQ,
      { signatureInput: r.headers["Signature-Input"], signature: r.headers.Signature },
      { dir: idDir, now: SIGN_AT, required: components },
    );
    assert.equal(v.valid, true, v.detail);
  });
});

describe("keyless verifyInbound — trust resolution and replay bounds", () => {
  it("accepts at exactly the expiry second and rejects one second later", async () => {
    const h = await mintSignedHeaders(REQ, { ttlSeconds: 60 });
    // Boundary: `expires` is inclusive (rejection is now > expires). Off-by-one either way
    // changes how long a captured signature can be replayed.
    const atExpiry = verifyInbound(REQ, h, { dir: idDir, now: new Date(1_000_000_060_000) });
    assert.equal(atExpiry.valid, true, atExpiry.detail);
    const past = verifyInbound(REQ, h, { dir: idDir, now: new Date(1_000_000_061_000) });
    assert.equal(past.valid, false);
    assert.match(past.detail, /expired/);
  });

  it("accepts a signature whose created is in the future (no not-before check)", async () => {
    const h = await mintSignedHeaders(REQ, { ttlSeconds: 60 });
    // Documenting ACTUAL behaviour: only `expires` is enforced, so a verifier whose clock is
    // behind the signer's still accepts. There is no not-before / skew bound to lean on.
    const v = verifyInbound(REQ, h, { dir: idDir, now: new Date(1_000_000_000_000 - 3_600_000) });
    assert.equal(v.valid, true, v.detail);
  });

  it("rejects a signer that is absent from the local trust set, reporting the keyid", async () => {
    const h = await mintSignedHeaders();
    const stranger = mkdtempSync(join(tmpdir(), "kit-trust-"));
    try {
      // Trust is the LOCAL identity set: an otherwise perfectly valid signature from a key we
      // do not know must not verify. The keyid is still reported so the caller can audit it.
      const v = verifyInbound(REQ, h, { dir: stranger, now: SIGN_AT });
      assert.equal(v.valid, false);
      assert.match(v.detail, /unknown keyid/);
      assert.equal(v.keyid, h.keyid);
    } finally {
      rmSync(stranger, { recursive: true, force: true });
    }
  });

  it("rejects a malformed Signature-Input, including unquoted component ids", async () => {
    const h = await mintSignedHeaders();
    const bad = verifyInbound(
      REQ,
      { signatureInput: "sig1=@method;created=1000000000", signature: h.signature },
      { dir: idDir, now: SIGN_AT },
    );
    assert.equal(bad.valid, false);
    assert.match(bad.detail, /malformed Signature-Input/);
    // A bare component id must be rejected outright, not parsed as "covers nothing" — the
    // latter would verify a base far weaker than the header appears to claim.
    const bareIds = `sig1=(@method @authority @path);created=1000000000;keyid="${h.keyid}"`;
    const unquoted = verifyInbound(
      REQ,
      { signatureInput: bareIds, signature: h.signature },
      { dir: idDir, now: SIGN_AT },
    );
    assert.equal(unquoted.valid, false);
    assert.match(unquoted.detail, /malformed Signature-Input/);
  });

  it("rejects a malformed Signature header and a garbled signature body", async () => {
    const h = await mintSignedHeaders();
    const malformed = verifyInbound(
      REQ,
      { signatureInput: h.signatureInput, signature: "not-a-signature" },
      { dir: idDir, now: SIGN_AT },
    );
    assert.equal(malformed.valid, false);
    assert.match(malformed.detail, /malformed Signature/);
    // Well-formed wrapper, nonsense bytes: the Ed25519 check must fail-closed rather than
    // throw on a wrong-length signature.
    const garbled = verifyInbound(
      REQ,
      { signatureInput: h.signatureInput, signature: "sig1=:AAAA:" },
      { dir: idDir, now: SIGN_AT },
    );
    assert.equal(garbled.valid, false);
    assert.match(garbled.detail, /does not verify/);
  });

  it("rejects when the Signature and Signature-Input labels disagree", async () => {
    const h = await mintSignedHeaders();
    // The label is what binds the two headers together. Accepting a mismatch would let an
    // attacker pair a captured signature with a different set of claimed parameters.
    const v = verifyInbound(
      REQ,
      { signatureInput: h.signatureInput, signature: h.signature.replace("sig1=", "sig2=") },
      { dir: idDir, now: SIGN_AT },
    );
    assert.equal(v.valid, false);
    assert.match(v.detail, /label mismatch/);
  });

  it("rejects when a required component is not covered by the signature", async () => {
    const h = await mintSignedHeaders(); // default components: @method, @authority, @path
    // A verifier that demands body binding must not accept a signature that never covered
    // it, even though that signature is otherwise cryptographically sound.
    const v = verifyInbound(REQ, h, {
      dir: idDir,
      now: SIGN_AT,
      required: ["@method", "content-digest"],
    });
    assert.equal(v.valid, false);
    assert.match(v.detail, /required component not covered: content-digest/);
    assert.equal(v.keyid, h.keyid);
  });

  it("does not bind headers or method casing outside the covered set", async () => {
    const h = await mintSignedHeaders();
    // Honest statement of reach: the default covered set is method/authority/path only, so
    // dropping content-type still verifies. Callers needing header integrity must pass
    // `components` when signing AND `required` when verifying.
    const noHeaders = verifyInbound({ method: "POST", url: REQ.url }, h, {
      dir: idDir,
      now: SIGN_AT,
    });
    assert.equal(noHeaders.valid, true, noHeaders.detail);
    // @method is normalized to upper case in the base, so casing is not part of the binding.
    const lower = verifyInbound({ ...REQ, method: "post" }, h, { dir: idDir, now: SIGN_AT });
    assert.equal(lower.valid, true, lower.detail);
  });

  it("falls back to the real clock when no now is supplied", async () => {
    // `now: undefined` makes signOutbound stamp the wall clock; verifyInbound with no `now`
    // must then take the same path and accept a signature inside its default 300s window.
    const h = await mintSignedHeaders(REQ, { now: undefined });
    const v = verifyInbound(REQ, h, { dir: idDir });
    assert.equal(v.valid, true, v.detail);
  });
});
