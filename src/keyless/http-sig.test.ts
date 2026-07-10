import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import {
  signatureBase,
  signatureParamsValue,
  signRequest,
  verifyRequest,
  componentValue,
  DEFAULT_COMPONENTS,
  type SignableRequest,
  type SignatureParams,
} from "./http-sig.js";

// Ephemeral Ed25519 keypair — mirrors how identity.ts signs (crypto.sign(null,…)).
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const KID = "kid_test0000";

const sign = (data: Buffer): Buffer => edSign(null, data, privateKey);
const verify = (data: Buffer, sig: Buffer, pubPem: string): boolean => {
  try {
    return edVerify(null, data, pubPem, sig);
  } catch {
    return false;
  }
};
const resolvePub = (kid: string): string | undefined => (kid === KID ? PUB_PEM : undefined);

const REQ: SignableRequest = {
  method: "post",
  url: "https://api.acme.com/v1/charge?amount=100",
  headers: { "content-type": "application/json" },
};

const baseParams = (over: Partial<SignatureParams> = {}): SignatureParams => ({
  keyid: KID,
  created: 1_000_000,
  ...over,
});

describe("keyless RFC 9421 — component derivation", () => {
  it("derives @method uppercased, @authority lowercased, @path, @query with leading ?", () => {
    assert.equal(componentValue("@method", REQ), "POST");
    assert.equal(componentValue("@authority", REQ), "api.acme.com");
    assert.equal(componentValue("@path", REQ), "/v1/charge");
    assert.equal(componentValue("@query", REQ), "?amount=100");
    assert.equal(componentValue("@scheme", REQ), "https");
  });

  it("uses '?' for @query when there is no query string", () => {
    assert.equal(componentValue("@query", { method: "GET", url: "https://x.io/a" }), "?");
  });

  it("resolves a header component case-insensitively and trims OWS", () => {
    const r: SignableRequest = {
      method: "GET",
      url: "https://x.io/",
      headers: { "X-Foo": "  bar " },
    };
    assert.equal(componentValue("x-foo", r), "bar");
  });

  it("throws for a covered header that is not present (fail-closed at sign time)", () => {
    assert.throws(() => componentValue("x-missing", REQ), /covered header not present/);
  });
});

describe("keyless RFC 9421 — signature base", () => {
  it("emits one line per component then the @signature-params line last", () => {
    const params = baseParams({
      components: ["@method", "@authority", "@path"],
      expires: 1_000_060,
    });
    const base = signatureBase(REQ, params);
    assert.equal(
      base,
      [
        `"@method": POST`,
        `"@authority": api.acme.com`,
        `"@path": /v1/charge`,
        `"@signature-params": ("@method" "@authority" "@path");created=1000000;keyid="${KID}";alg="ed25519";expires=1000060`,
      ].join("\n"),
    );
  });

  it("serializes params in a deterministic order", () => {
    const v = signatureParamsValue(baseParams({ expires: 5, nonce: "n1" }));
    assert.equal(
      v,
      `("@method" "@authority" "@path");created=1000000;keyid="${KID}";alg="ed25519";expires=5;nonce="n1"`,
    );
  });

  it("rejects a parameterized or unknown derived component", () => {
    assert.throws(
      () => signatureParamsValue(baseParams({ components: ["@query-param;name=q"] })),
      /not supported/,
    );
    assert.throws(
      () => signatureParamsValue(baseParams({ components: ["@bogus"] })),
      /unsupported covered component/,
    );
  });
});

describe("keyless RFC 9421 — sign + verify round-trip", () => {
  it("a freshly signed request verifies", () => {
    const params = baseParams({ expires: 1_000_060 });
    const headers = signRequest(REQ, params, sign);
    const r = verifyRequest(
      REQ,
      { signatureInput: headers["Signature-Input"], signature: headers.Signature },
      resolvePub,
      verify,
      { now: 1_000_010 },
    );
    assert.equal(r.valid, true, r.detail);
    assert.equal(r.keyid, KID);
  });

  it("emits the expected header shapes", () => {
    const headers = signRequest(REQ, baseParams(), sign);
    assert.match(headers["Signature-Input"], /^sig1=\("@method" "@authority" "@path"\);created=/);
    assert.match(headers.Signature, /^sig1=:[A-Za-z0-9+/=]+:$/);
  });
});

describe("keyless RFC 9421 — fail-closed", () => {
  const signed = () => signRequest(REQ, baseParams({ expires: 1_000_060 }), sign);
  const hdr = (h: ReturnType<typeof signRequest>) => ({
    signatureInput: h["Signature-Input"],
    signature: h.Signature,
  });

  it("rejects when the method is tampered", () => {
    const r = verifyRequest({ ...REQ, method: "GET" }, hdr(signed()), resolvePub, verify, {
      now: 1_000_010,
    });
    assert.equal(r.valid, false);
    assert.match(r.detail, /does not verify/);
  });

  it("rejects when the path is tampered", () => {
    const r = verifyRequest(
      { ...REQ, url: "https://api.acme.com/v1/refund?amount=100" },
      hdr(signed()),
      resolvePub,
      verify,
      { now: 1_000_010 },
    );
    assert.equal(r.valid, false);
  });

  it("rejects an expired signature", () => {
    const r = verifyRequest(REQ, hdr(signed()), resolvePub, verify, { now: 1_000_061 });
    assert.equal(r.valid, false);
    assert.match(r.detail, /expired/);
  });

  it("rejects an unresolvable keyid", () => {
    const r = verifyRequest(REQ, hdr(signed()), () => undefined, verify, { now: 1_000_010 });
    assert.equal(r.valid, false);
    assert.match(r.detail, /unknown keyid/);
  });

  it("rejects when a required component was not covered", () => {
    const r = verifyRequest(REQ, hdr(signed()), resolvePub, verify, {
      now: 1_000_010,
      required: ["content-type"],
    });
    assert.equal(r.valid, false);
    assert.match(r.detail, /required component not covered/);
  });

  it("verifies when the required component IS covered", () => {
    const headers = signRequest(
      REQ,
      baseParams({ components: [...DEFAULT_COMPONENTS, "content-type"], expires: 1_000_060 }),
      sign,
    );
    const r = verifyRequest(REQ, hdr(headers), resolvePub, verify, {
      now: 1_000_010,
      required: ["content-type"],
    });
    assert.equal(r.valid, true, r.detail);
  });

  it("rejects malformed headers", () => {
    assert.equal(
      verifyRequest(REQ, { signatureInput: "garbage", signature: "sig1=::" }, resolvePub, verify)
        .valid,
      false,
    );
  });

  it("rejects a Signature/Signature-Input label mismatch", () => {
    const h = signed();
    const r = verifyRequest(
      REQ,
      { signatureInput: h["Signature-Input"], signature: h.Signature.replace("sig1=", "other=") },
      resolvePub,
      verify,
      { now: 1_000_010 },
    );
    assert.equal(r.valid, false);
    assert.match(r.detail, /label mismatch/);
  });
});
