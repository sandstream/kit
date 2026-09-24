# sandstream-kit-plugin-cloudflare

Cloudflare Management API client for Workers secrets and API tokens. This package exports functions for application code; it does not export a `kit add` adapter.

## Installation

```bash
npm install sandstream-kit-plugin-cloudflare
```

## Configuration

Set `CLOUDFLARE_API_TOKEN` in your secret manager. Worker-secret operations also require `CLOUDFLARE_ACCOUNT_ID`. `makeClient` accepts `apiToken`, `accountId`, and `baseUrl` overrides.

## Usage

```js
import { makeClient, listWorkerSecrets } from "sandstream-kit-plugin-cloudflare";

const client = makeClient();
const secrets = await listWorkerSecrets(client, "my-worker");
console.log(secrets.map(({ name }) => name));
```

## API

Read operations: `listWorkerSecrets`, `listApiTokens`. Write operations: `putWorkerSecret`, `deleteWorkerSecret`, `revokeApiToken`. Write functions enforce kit's read-only and policy controls. Keep token values out of logs.

## Testing

From the repository root, run `npm run build` and `npm test` to compile and run the package's tests in the monorepo suite. This package has no standalone `npm test` script.

## Troubleshooting

- Missing token or account ID: set `CLOUDFLARE_API_TOKEN` and, for Worker secrets, `CLOUDFLARE_ACCOUNT_ID`.
- API permission error: check the token's account and Worker permissions.
- Write refused: check `KIT_READ_ONLY` and the project's agent-write policy.

## Support

Report package issues in [sandstream/kit issues](https://github.com/sandstream/kit/issues).

## Version

Current package version: `0.2.2`. See [CHANGELOG.md](./CHANGELOG.md).
