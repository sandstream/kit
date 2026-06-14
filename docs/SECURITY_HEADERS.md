# Security headers

Ship these on every response by default — they are cheap, broadly applicable
hardening that closes whole classes of attack (clickjacking, MIME-sniffing,
referrer leakage, downgrade). The example below wires them in Next.js via
`next.config.js`; the same header *values* apply to any framework or reverse
proxy — only the wiring differs.

```js
// next.config.js
const securityHeaders = [
  // Force HTTPS for 2 years; preload-eligible. Only enable preload once you're
  // sure every subdomain is HTTPS-only — it's hard to undo.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  // Disallow framing → clickjacking protection. Use a CSP frame-ancestors
  // instead if you need to allow specific embedders.
  { key: 'X-Frame-Options', value: 'DENY' },
  // Don't let browsers MIME-sniff responses.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Send origin only on cross-origin; full URL same-origin.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Deny powerful features by default; add what you actually use.
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()' },
];

/** @type {import('next').NextConfig} */
module.exports = {
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};
```

## Content-Security-Policy (add when you can)

A CSP is the strongest single header but needs per-app tuning (inline scripts,
analytics, fonts). Start in report-only, watch violations, then enforce.

```js
{ key: 'Content-Security-Policy-Report-Only',
  value: "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" }
```

## Verify

```bash
curl -sI https://example.com/ | grep -iE 'strict-transport|x-frame|x-content-type|referrer-policy|permissions-policy'
```

Or scan with a public header checker such as https://securityheaders.com. Aim
for an A+ grade before release.
