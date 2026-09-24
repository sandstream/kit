# sandstream-kit-plugin-vercel

Vercel Management API client for projects, environment variables, and redeploy requests. It exports functions for application code, not a `kit add` adapter.

## Installation

```bash
npm install sandstream-kit-plugin-vercel
```

## Configuration

Set `VERCEL_TOKEN` in your secret manager, or pass `token` to `makeClient`. `VERCEL_TEAM_ID` (or `teamId`) scopes requests to a team. `baseUrl` overrides the API endpoint.

## Usage

```js
import { makeClient, listProjects } from "sandstream-kit-plugin-vercel";

const client = makeClient();
const projects = await listProjects(client);
console.log(projects.map(({ name }) => name));
```

## API

`listProjects` and `listEnvVars` read metadata. `createEnvVar`, `updateEnvVar`, `deleteEnvVar`, `upsertEnvVar`, and `redeployLatest` make remote changes and enforce kit's read-only and policy controls. Environment-variable reads request metadata without decrypted values.

## Testing

From the repository root, run `npm run build --workspace=sandstream-kit-plugin-vercel` and `npm test --workspace=sandstream-kit-plugin-vercel`. The test command runs the package's compiled tests.

## Troubleshooting

- `VERCEL_TOKEN not set`: provide a token through the environment or `makeClient`.
- Team project missing: set `VERCEL_TEAM_ID` or pass `teamId` to `makeClient`.
- Write refused: check `KIT_READ_ONLY` and the project's agent-write policy.

## Support

Report package issues in [sandstream/kit issues](https://github.com/sandstream/kit/issues).

## Version

Current package version: `0.2.2`. See [CHANGELOG.md](./CHANGELOG.md).
