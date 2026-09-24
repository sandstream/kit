# sandstream-kit-plugin-sentry

Sentry REST API client for organization, project, issue, event, and release operations. It does not export a `kit add` adapter.

## Installation

```bash
npm install sandstream-kit-plugin-sentry
```

## Configuration

Set `SENTRY_AUTH_TOKEN` in your secret manager. `SENTRY_URL` selects the Sentry host; `makeClient({ host, organizationSlug })` also accepts explicit values. Most project and issue operations need an organization slug.

## Usage

```js
import { makeClient, listOrganizations } from "sandstream-kit-plugin-sentry";

const client = makeClient();
const organizations = await listOrganizations(client);
console.log(organizations.map(({ slug }) => slug));
```

## API

Read operations: `listOrganizations`, `listProjects`, `searchIssues`, `getIssueEvents`. Write operations: `updateIssue`, `createRelease`. Write functions enforce kit's read-only and policy controls.

## Testing

From the repository root, run `npm run build` and `npm test` to compile and run the package's tests in the monorepo suite. This package has no standalone `npm test` script.

## Troubleshooting

- `SENTRY_AUTH_TOKEN not set`: provide a token through the environment or `makeClient`.
- Organization-scoped request fails: set `organizationSlug` and verify `SENTRY_URL` for your region.
- Write refused: check `KIT_READ_ONLY` and the project's agent-write policy.

## Support

Report package issues in [sandstream/kit issues](https://github.com/sandstream/kit/issues).

## Version

Current package version: `0.2.2`. See [CHANGELOG.md](./CHANGELOG.md).
