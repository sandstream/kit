# Browser scripts in the security check

kit's install gate, triage and cooling stop at `node_modules`. A `<script src>` in a page is also
a dependency: third-party code that runs with the site's authority in every visitor's browser. In
November 2026 a compromised Optimizely snippet served a card skimmer from a source 178 organisations
already trusted; a strict Content-Security-Policy was the control that stopped it.

`kit check --category security` has a `browser scripts` row (category `supply-chain`, cited as
CWE-829). It reads the repository's text files, with no network and no model.

## What it reads

- External `<script src="https://…">` and protocol-relative `<script src="//…">` in HTML and
  templates (`.html`, `.ejs`, `.hbs`, `.njk`, `.liquid`, `.vue`, `.svelte`, `.astro`).
- `<script src>` and Next.js `<Script src>` in JSX, TSX and JavaScript, when `src` is a literal
  string. A `src` built at runtime is not seen.
- Card inputs: `autocomplete="cc-number"`, `cc-csc` or `cc-exp*`, or an input whose `name` or `id`
  names a card number, CVC, CVV or security code.
- A Content-Security-Policy anywhere: a `<meta http-equiv>` tag, `next.config.*`, `vercel.json`,
  `netlify.toml`, `_headers`, or server code that sets the header or calls `helmet()`.
  `Content-Security-Policy-Report-Only` does not count, because it blocks nothing.

Relative and absolute-path scripts are same-origin and are never a finding.

## What it reports

| Finding                                                                                                                                   | Status       | Fix                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| A third-party script on a page with a card form. Scripts in `pages/_document`, `pages/_app` or `app/layout` count for every Next.js page. | fail, high   | Move the script off that page, or take card data in the payment provider's hosted fields.                         |
| A mutable CDN URL: `@latest` or another tag, no version, or a range such as `@18` (unpkg, jsDelivr, cdnjs, esm.sh, Skypack).              | warn, medium | Pin an exact version.                                                                                             |
| A version-pinned CDN URL with no `integrity`.                                                                                             | warn, low    | Add `integrity` and `crossorigin="anonymous"`. SRI costs nothing on a fixed file.                                 |
| Third-party scripts, other than pinned files with `integrity`, and no CSP found.                                                          | warn, medium | Add a CSP. A vendor snippet that changes cannot be pinned by a hash; `connect-src` limits where it can send data. |

The scripts of hosted-payment providers (Stripe.js, Braintree, PayPal, Adyen, Square and others)
are not counted beside a card form, because loading them is the fix.

With no finding, the row passes with a count, for example `3 external script(s), all pinned with
integrity`. With no external script, it is skipped.

## Bounds

The scan skips `node_modules`, `dist`, `build`, `out`, `.next`, `vendor`, `.git` and other
generated directories, as well as test files and fixture directories. It reads at most 5,000 files
and 16 directory levels. Markup files over 256 KB, and paths it cannot read, make the scan
incomplete: a clean result then becomes a warning, never a pass. Script files over 256 KB are
treated as bundles and skipped.

## Not yet

A lockfile of browser scripts (`.kit/browser-scripts.json`) that `kit security verify-pull` would diff, so
that a new origin or a newly mutable URL shows up like a new dependency, is not built.
