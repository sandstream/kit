/**
 * kit keyless credentials (Pillar 2 tail) — RFC 9421 HTTP Message Signatures.
 *
 * "Sign, don't store": instead of carrying a long-lived bearer token, an agent
 * signs each outbound request with its Ed25519 identity (Pillar 1). The server
 * verifies against the agent's PUBLIC key — there is no secret at rest to steal,
 * rotate, or redact. This module is the pure, deterministic core that builds the
 * RFC 9421 signature base and assembles / checks the `Signature-Input` +
 * `Signature` headers.
 *
 * Deliberately pure: NO filesystem, NO network, NO identity import, NO model
 * calls. Signing/verifying take injected callbacks (`sign` / `resolvePub`) so the
 * same primitive is used by the broker (with `signWithIdentity`) and by tests
 * (with an ephemeral keypair). Byte-for-byte stable across machines so a
 * signature produced on one host verifies offline on another.
 *
 * Fail-CLOSED throughout: a missing covered component, an unresolvable keyid, an
 * expired signature, or a base that does not verify all return "not valid" — the
 * caller must treat anything but `valid: true` as no proof of identity.
 *
 * Scope of this v1: the derived components `@method`, `@authority`, `@path`,
 * `@query`, `@scheme`, `@target-uri`, plus arbitrary request headers by name.
 * Parameterized component identifiers (e.g. `@query-param;name=…`) are out of
 * scope and rejected rather than half-supported.
 */

/** A request in a form we can derive RFC 9421 covered-component values from. */
export interface SignableRequest {
  method: string;
  /** Absolute request URL (scheme://authority/path?query). */
  url: string;
  /** Request headers, matched case-insensitively for header components. */
  headers?: Record<string, string>;
}

/** Parameters of a single signature (the `@signature-params` line). */
export interface SignatureParams {
  /** Key id of the signer — an identity `kid_…`. */
  keyid: string;
  /** Unix seconds the signature was created. */
  created: number;
  /** Unix seconds after which the signature must be rejected (replay bound). */
  expires?: number;
  /** Optional nonce for extra replay resistance. */
  nonce?: string;
  /** Signature algorithm; only `ed25519` is supported. Default `ed25519`. */
  alg?: string;
  /** Ordered covered component identifiers. Default {@link DEFAULT_COMPONENTS}. */
  components?: string[];
  /** Signature label used in the headers. Default `sig1`. */
  label?: string;
}

/** The two headers a signed request carries. */
export interface SignatureHeaders {
  "Signature-Input": string;
  Signature: string;
}

/** Minimal covered set: method + authority + path. Enough to bind who/where/what. */
export const DEFAULT_COMPONENTS = ["@method", "@authority", "@path"];

const SUPPORTED_ALG = "ed25519";

/** Derived component identifiers we know how to evaluate (no parameters). */
const DERIVED = new Set(["@method", "@authority", "@path", "@query", "@scheme", "@target-uri"]);

function parseUrl(url: string): URL {
  return new URL(url);
}

/**
 * Derive the RFC 9421 value for one covered component. Throws for a component
 * that cannot be evaluated (missing header, unknown/parameterized id) so signing
 * never emits a base that silently omits a claimed component.
 */
export function componentValue(id: string, req: SignableRequest): string {
  if (id.startsWith("@")) {
    const u = parseUrl(req.url);
    switch (id) {
      case "@method":
        return req.method.toUpperCase();
      case "@authority":
        return u.host.toLowerCase();
      case "@path":
        return u.pathname || "/";
      case "@query":
        // Per §2.2.8: the query INCLUDING the leading "?"; "?" when there is none.
        return u.search === "" ? "?" : u.search;
      case "@scheme":
        return u.protocol.replace(/:$/, "").toLowerCase();
      case "@target-uri":
        return req.url;
      default:
        throw new Error(`unsupported derived component: ${id}`);
    }
  }
  // A header component. Match case-insensitively, trim OWS, join dupes with ", ".
  const wanted = id.toLowerCase();
  const headers = req.headers ?? {};
  const values: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted) values.push(String(v).trim());
  }
  if (values.length === 0) throw new Error(`covered header not present: ${id}`);
  return values.join(", ");
}

/** Serialize the `@signature-params` value: the inner list + ordered parameters. */
export function signatureParamsValue(params: SignatureParams): string {
  const components = params.components ?? DEFAULT_COMPONENTS;
  for (const c of components) {
    if (c.includes(";")) throw new Error(`parameterized component not supported: ${c}`);
    if (c.startsWith("@") && !DERIVED.has(c)) {
      throw new Error(`unsupported covered component: ${c}`);
    }
  }
  const inner = "(" + components.map((c) => `"${c}"`).join(" ") + ")";
  // Deterministic parameter order: created, keyid, alg, expires, nonce.
  let out = inner + `;created=${params.created}`;
  out += `;keyid="${params.keyid}"`;
  out += `;alg="${params.alg ?? SUPPORTED_ALG}"`;
  if (params.expires !== undefined) out += `;expires=${params.expires}`;
  if (params.nonce !== undefined) out += `;nonce="${params.nonce}"`;
  return out;
}

/**
 * Build the RFC 9421 signature base (§2.5): one line per covered component, then
 * the `"@signature-params": …` line last. This exact string is what gets signed.
 */
export function signatureBase(req: SignableRequest, params: SignatureParams): string {
  const components = params.components ?? DEFAULT_COMPONENTS;
  const lines: string[] = [];
  for (const c of components) {
    lines.push(`"${c}": ${componentValue(c, req)}`);
  }
  lines.push(`"@signature-params": ${signatureParamsValue(params)}`);
  return lines.join("\n");
}

/**
 * Sign a request: build the base, sign it with the injected `sign` callback
 * (Ed25519 over the base bytes), and return the two headers. `sign` is expected
 * to produce a raw Ed25519 signature (e.g. `signWithIdentity`).
 */
export function signRequest(
  req: SignableRequest,
  params: SignatureParams,
  sign: (data: Buffer) => Buffer,
): SignatureHeaders {
  if ((params.alg ?? SUPPORTED_ALG) !== SUPPORTED_ALG) {
    throw new Error(`unsupported alg: ${params.alg}`);
  }
  const label = params.label ?? "sig1";
  const base = signatureBase(req, params);
  const sig = sign(Buffer.from(base, "utf-8"));
  return {
    "Signature-Input": `${label}=${signatureParamsValue(params)}`,
    Signature: `${label}=:${sig.toString("base64")}:`,
  };
}

// ─── Verification ──────────────────────────────────────────────────────────────

/** A parsed `Signature-Input` entry for one label. */
interface ParsedInput {
  label: string;
  components: string[];
  params: SignatureParams;
}

/** Parse a single-signature `Signature-Input` value. Returns null if malformed. */
function parseSignatureInput(value: string): ParsedInput | null {
  // <label>=("comp" "comp");created=..;keyid="..";alg="..";expires=..;nonce=".."
  const m = /^([A-Za-z0-9_-]+)=\(([^)]*)\)(.*)$/.exec(value.trim());
  if (!m) return null;
  const [, label, inner, rest] = m;
  const components: string[] = [];
  for (const tok of inner.trim().length ? inner.trim().split(/\s+/) : []) {
    const q = /^"(.*)"$/.exec(tok);
    if (!q) return null; // a bare (unquoted) component id is malformed
    components.push(q[1]);
  }
  const params: Partial<SignatureParams> & { keyid?: string; created?: number } = {};
  const paramRe = /;([A-Za-z0-9_-]+)=("[^"]*"|[0-9]+)/g;
  let pm: RegExpExecArray | null;
  while ((pm = paramRe.exec(rest)) !== null) {
    const key = pm[1];
    const raw = pm[2];
    const val = raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
    switch (key) {
      case "created":
        params.created = Number(val);
        break;
      case "expires":
        params.expires = Number(val);
        break;
      case "keyid":
        params.keyid = String(val);
        break;
      case "alg":
        params.alg = String(val);
        break;
      case "nonce":
        params.nonce = String(val);
        break;
      // unknown params are ignored but do not fail the parse
    }
  }
  if (params.keyid === undefined || params.created === undefined) return null;
  return {
    label,
    components,
    params: {
      keyid: params.keyid,
      created: params.created,
      expires: params.expires,
      nonce: params.nonce,
      alg: params.alg,
      components,
      label,
    },
  };
}

/** Parse a single-signature `Signature` value into {label, sig bytes}. */
function parseSignature(value: string): { label: string; sig: Buffer } | null {
  const m = /^([A-Za-z0-9_-]+)=:([^:]*):\s*$/.exec(value.trim());
  if (!m) return null;
  try {
    return { label: m[1], sig: Buffer.from(m[2], "base64") };
  } catch {
    return null;
  }
}

export interface VerifyResult {
  valid: boolean;
  detail: string;
  keyid?: string;
}

/**
 * Verify a signed request, fail-closed. Reconstructs the signature base from the
 * request + the parsed `Signature-Input`, resolves the signer's public key via
 * `resolvePub(keyid)`, and checks the Ed25519 signature with `verify`.
 *
 * Rejects (valid:false) when: headers are malformed, the two labels disagree, a
 * covered component cannot be derived, a `required` component is not covered, the
 * alg is not ed25519, the keyid is unresolvable, the signature is expired, or the
 * signature does not verify.
 */
export function verifyRequest(
  req: SignableRequest,
  headers: { signatureInput: string; signature: string },
  resolvePub: (keyid: string) => string | undefined,
  verify: (data: Buffer, sig: Buffer, pubPem: string) => boolean,
  opts: { now?: number; required?: string[] } = {},
): VerifyResult {
  const input = parseSignatureInput(headers.signatureInput);
  if (!input) return { valid: false, detail: "malformed Signature-Input" };
  const parsedSig = parseSignature(headers.signature);
  if (!parsedSig) return { valid: false, detail: "malformed Signature" };
  if (parsedSig.label !== input.label) {
    return { valid: false, detail: "Signature/Signature-Input label mismatch" };
  }
  if ((input.params.alg ?? SUPPORTED_ALG) !== SUPPORTED_ALG) {
    return {
      valid: false,
      detail: `unsupported alg: ${input.params.alg}`,
      keyid: input.params.keyid,
    };
  }
  // Every required component must actually be covered by this signature.
  for (const need of opts.required ?? []) {
    if (!input.components.includes(need)) {
      return {
        valid: false,
        detail: `required component not covered: ${need}`,
        keyid: input.params.keyid,
      };
    }
  }
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  if (input.params.expires !== undefined && nowSec > input.params.expires) {
    return { valid: false, detail: "signature expired", keyid: input.params.keyid };
  }
  const pub = resolvePub(input.params.keyid);
  if (!pub) {
    return {
      valid: false,
      detail: `unknown keyid: ${input.params.keyid}`,
      keyid: input.params.keyid,
    };
  }
  let base: string;
  try {
    base = signatureBase(req, input.params);
  } catch (err) {
    return {
      valid: false,
      detail: `cannot rebuild base: ${err instanceof Error ? err.message : String(err)}`,
      keyid: input.params.keyid,
    };
  }
  const ok = verify(Buffer.from(base, "utf-8"), parsedSig.sig, pub);
  return ok
    ? { valid: true, detail: `verified ${input.params.keyid}`, keyid: input.params.keyid }
    : { valid: false, detail: "signature does not verify", keyid: input.params.keyid };
}
