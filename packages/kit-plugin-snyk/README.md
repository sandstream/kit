# sandstream-kit-plugin-snyk

Ingests Snyk findings into kit's local scan-results log. It accepts saved CLI JSON or fetches issues with read-only Snyk API requests. It does not export a `kit add` adapter.

## Installation

```bash
npm install sandstream-kit-plugin-snyk
```

## Configuration

Local JSON ingestion needs no API credential. API fetching requires `SNYK_TOKEN` or an explicit `token`, plus an organization slug.

## Usage: local CLI results

```js
import { readFileSync } from "node:fs";
import { parseSnykJson, recordSnykFindings } from "sandstream-kit-plugin-snyk";

const results = parseSnykJson(readFileSync("snyk-results.json", "utf8"));
const recorded = await recordSnykFindings(results, process.cwd());
console.log(`${recorded.written} vulnerabilities recorded`);
```

Save `snyk test --json` output to `snyk-results.json` first. The parser also accepts multi-project JSON. Recording appends to `.kit-scan-results.jsonl`.

## Read-only API fetch

`fetchSnykIssues({ orgSlug, projectId? })` fetches issues with GET requests. Set `SNYK_TOKEN` in the environment, or pass `token` explicitly; `orgSlug` is required. `apiBase` can select a regional endpoint. Call `recordSnykFindings` with parsed CLI results when you want local log rows; the fetch function returns issue objects for your own handling.

## API

`parseSnykJson(text)` accepts single- or multi-project CLI JSON. `recordSnykFindings(results, cwd?)` appends vulnerability rows to `.kit-scan-results.jsonl`. `fetchSnykIssues({ orgSlug, projectId?, token?, apiBase? })` returns read-only API issue data.

## Testing

From the repository root, run `npm run build` and `npm test` to compile and run the package's tests in the monorepo suite. This package has no standalone `npm test` script.

## Troubleshooting

- `SNYK_TOKEN not set`: configure a token for API fetching; saved CLI JSON needs no token.
- API authorization error: verify the token, organization slug, and regional `apiBase`.
- Zero recorded rows: inspect `results[].vulnerabilities` from `parseSnykJson`.

## Support

Report package issues in [sandstream/kit issues](https://github.com/sandstream/kit/issues).

## Version

Current package version: `0.1.2`. See [CHANGELOG.md](./CHANGELOG.md).
