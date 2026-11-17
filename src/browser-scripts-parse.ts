/**
 * Pure text parsing for the `browser scripts` security row: which external scripts a page loads,
 * whether their URL is pinned, whether the page holds a card form, and whether a file declares a
 * Content-Security-Policy. Text in, facts out: no filesystem, no network.
 */

export interface ScriptTag {
  /** The literal `src` value as written. */
  src: string;
  /** True when the tag carries an `integrity` attribute. */
  integrity: boolean;
}

/** How a CDN URL names its version. `vendor` is a third-party URL that is not an npm CDN. */
export type UrlPin = "pinned" | "mutable" | "vendor";

export interface ScriptUrl {
  host: string;
  pin: UrlPin;
  /** Why a mutable URL is mutable: `@latest`, `no version`, or the range such as `@18`. */
  reason?: string;
}

// `<script ...>` in HTML and templates (in any case, as HTML allows), and `<script ...>` and
// Next's `<Script ...>` in JSX. A JSX attribute in braces may hold `>` (an arrow function), so
// braces are matched one level deep.
const SCRIPT_TAG = /<script\b((?:[^>{}]|\{[^{}]*\})*)>/gi;
const SRC_ATTR =
  /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`$]*)["'`]\s*\}|([^\s"'{}>]+))/i;
const INTEGRITY_ATTR = /(?:^|\s)integrity\s*=/i;

/** Every `<script src>` / `<Script src>` whose src is a literal string. */
export function extractScriptTags(text: string): ScriptTag[] {
  const tags: ScriptTag[] = [];
  for (const match of text.matchAll(SCRIPT_TAG)) {
    const attrs = match[1] ?? "";
    const src = SRC_ATTR.exec(attrs);
    const value = src ? (src[1] ?? src[2] ?? src[3] ?? src[4] ?? "").trim() : "";
    if (value) tags.push({ src: value, integrity: INTEGRITY_ATTR.test(attrs) });
  }
  return tags;
}

/** True for `http://`, `https://` and protocol-relative `//host` sources; relative paths are same-origin. */
export function isExternalSrc(src: string): boolean {
  return /^(?:https?:)?\/\/[^/]/i.test(src);
}

const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][\w.]+)?$/;

function judgeVersion(version: string | undefined): Pick<ScriptUrl, "pin" | "reason"> {
  if (version === undefined || version === "") return { pin: "mutable", reason: "no version" };
  if (EXACT_VERSION.test(version)) return { pin: "pinned" };
  if (/^[a-z]/i.test(version)) return { pin: "mutable", reason: `@${version}` };
  return { pin: "mutable", reason: `range @${version}` };
}

/** `[@scope/]name[@version]` at the start of an npm CDN path. */
function npmVersion(path: string): string | undefined {
  const spec = /^(@[^/@]+\/[^/@]+|[^/@]+)(?:@([^/]*))?/.exec(path);
  return spec?.[2] === undefined ? undefined : decodeURIComponent(spec[2]);
}

const NPM_CDN: { host: RegExp; prefix: RegExp }[] = [
  { host: /^unpkg\.com$/i, prefix: /^\// },
  { host: /^cdn\.jsdelivr\.net$/i, prefix: /^\/(?:npm\/|gh\/[^/]+\/)/ },
  { host: /^esm\.sh$/i, prefix: /^\/(?:v\d+\/)?/ },
  { host: /^cdn\.skypack\.dev$/i, prefix: /^\// },
];

function cdnjsVersion(path: string): string | undefined {
  const version = /^\/ajax\/libs\/[^/]+\/([^/]+)\//.exec(path)?.[1];
  return version && /^\d/.test(version) ? version : undefined;
}

/** Classify an external script URL; null when it cannot be parsed as a URL. */
export function classifyScriptUrl(src: string): ScriptUrl | null {
  let url: URL;
  try {
    url = new URL(src.startsWith("//") ? `https:${src}` : src);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (/^cdnjs\.cloudflare\.com$/i.test(host))
    return { host, ...judgeVersion(cdnjsVersion(url.pathname)) };
  const cdn = NPM_CDN.find((c) => c.host.test(host) && c.prefix.test(url.pathname));
  if (!cdn) return { host, pin: "vendor" };
  return { host, ...judgeVersion(npmVersion(url.pathname.replace(cdn.prefix, ""))) };
}

// Hosts that serve hosted payment fields. Loading them on a checkout page is the fix this row
// recommends, so they are not counted as third-party code beside a card form.
const PAYMENT_HOSTS = new Set([
  "js.stripe.com",
  "checkout.stripe.com",
  "js.braintreegateway.com",
  "www.paypal.com",
  "www.paypalobjects.com",
  "pay.google.com",
  "applepay.cdn-apple.com",
  "js.squareup.com",
  "web.squarecdn.com",
  "sandbox.web.squarecdn.com",
  "checkoutshopper-live.adyen.com",
  "checkoutshopper-test.adyen.com",
  "cdn.checkout.com",
  "js.authorize.net",
  "jstest.authorize.net",
  "js.recurly.com",
  "js.chargebee.com",
]);

export function isPaymentProviderHost(host: string): boolean {
  return PAYMENT_HOSTS.has(host.toLowerCase());
}

const CARD_AUTOCOMPLETE =
  /\bautoComplete\s*=\s*\{?\s*["'`]\s*cc-(?:number|csc|exp(?:-month|-year)?)\b/i;
const INPUT_TAG = /<input\b[^>]*>/gi;
const CARD_NAME =
  /(?:^|\s)(?:name|id)\s*=\s*\{?\s*["'`][^"'`]*(?:card[-_ ]?(?:number|num|no)|cc[-_]?(?:number|num)|cvc|cvv|csc|card[-_]?code|security[-_]?code)[^"'`]*["'`]/i;

/** True when the text holds a card input: a `cc-*` autocomplete, or an input named for card number / CVC / CVV. */
export function hasPaymentForm(text: string): boolean {
  if (CARD_AUTOCOMPLETE.test(text)) return true;
  for (const input of text.matchAll(INPUT_TAG)) if (CARD_NAME.test(input[0])) return true;
  return false;
}

/** True when the text declares a Content-Security-Policy (meta tag, header config or server code). */
export function declaresCsp(text: string): boolean {
  // Report-Only enforces nothing; helmet() sets a policy by default.
  return (
    /content-security-policy(?!-report-only)/i.test(text) ||
    /\b(?:contentSecurityPolicy|helmet\()/.test(text)
  );
}
