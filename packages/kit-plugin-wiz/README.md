# sandstream-kit-plugin-wiz

Fetches Wiz issue-graph findings and records them in kit's local scan-results log. It reads issues from Wiz and does not export a `kit add` adapter.

## Installation

```bash
npm install sandstream-kit-plugin-wiz
```

## Configuration

Provide `WIZ_CLIENT_ID`, `WIZ_CLIENT_SECRET`, and your tenant-specific `WIZ_API_URL` through your secret manager. `WIZ_AUTH_URL` optionally overrides the OAuth token endpoint. `makeClient` also accepts these values as options. It obtains a fresh access token; callers create a new client after token expiry.

## Usage

```js
import { makeClient, fetchIssues, recordWizIssues } from "sandstream-kit-plugin-wiz";

const client = await makeClient();
const issues = await fetchIssues(client, { minSeverity: "HIGH" });
const recorded = await recordWizIssues(issues, process.cwd());
console.log(`${recorded.written} issues recorded`);
```

`fetchIssues` supports `limit`, `minSeverity`, and `statusIn`. `recordWizIssues` appends one row per issue to `.kit-scan-results.jsonl` and does nothing when the issue list is empty.

## API

`makeClient(options?)` exchanges client credentials for an access token. `fetchIssues(client, options?)` reads issue-graph nodes; `recordWizIssues(issues, cwd?)` appends local scan-result rows and returns the count written.

## Testing

From the repository root, run `npm run build` and `npm test` to compile and run the package's tests in the monorepo suite. This package has no standalone `npm test` script.

## Troubleshooting

- Missing credentials or API URL: set `WIZ_CLIENT_ID`, `WIZ_CLIENT_SECRET`, and `WIZ_API_URL`.
- Authentication failure: verify the tenant's auth endpoint and credential scope.
- Expired access token: call `makeClient` again before fetching issues.

## Support

Report package issues in [sandstream/kit issues](https://github.com/sandstream/kit/issues).

## Version

Current package version: `0.1.2`. See [CHANGELOG.md](./CHANGELOG.md).
