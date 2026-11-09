/** TOTP encoding, provisioning URIs, and code verification. This module does not access stores. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function generateBase32Secret(byteLength: number = 20): string {
  // Use the module-level crypto import.
  const bytes = randomBytes(byteLength);
  // RFC 4648 base32 uses no padding and the alphabet expected by TOTP libraries.
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

export interface OtpAuthUriInput {
  /** Identifier shown in the authenticator app (typically user@host). */
  accountName: string;
  /** Top-level label shown as the section heading. */
  issuer?: string;
  /** Base32 secret. */
  secret: string;
}

export function buildOtpAuthUri(input: OtpAuthUriInput): string {
  const issuer = input.issuer ?? "kit";
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(input.accountName)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = "";
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 char: ${ch}`);
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotp(
  secretBase32: string,
  step: number = Math.floor(Date.now() / 1000 / 30),
): string {
  const secret = base32Decode(secretBase32);
  const counter = Buffer.alloc(8);
  // Big-endian uint64. step fits in uint32 for the next ~136 years, so write
  // the high word as zero.
  counter.writeUInt32BE(0, 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const hmac = createHmac("sha1", secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 1_000_000).toString().padStart(6, "0");
}

/**
 * Verifies a user-supplied TOTP. Accepts the current step ± 1 (handles minor
 * clock skew, ±30s window). Compares codes with timingSafeEqual.
 * Both sides use six ASCII digits, so their lengths match.
 */
export function verifyTotp(code: string, secretBase32: string, windowSteps: number = 1): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const codeBuf = Buffer.from(code, "ascii");
  const now = Math.floor(Date.now() / 1000 / 30);
  for (let delta = -windowSteps; delta <= windowSteps; delta++) {
    const expected = Buffer.from(generateTotp(secretBase32, now + delta), "ascii");
    if (expected.length === codeBuf.length && timingSafeEqual(expected, codeBuf)) return true;
  }
  return false;
}
