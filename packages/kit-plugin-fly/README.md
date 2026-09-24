# sandstream-kit-plugin-fly

Fly.io Management API client for app secrets and machine inspection. This is an importable API client, not a `kit add` adapter.

## Installation

```bash
npm install sandstream-kit-plugin-fly
```

## Configuration

Set `FLY_API_TOKEN` in your secret manager or pass `token` to `makeClient`. Optional `graphqlUrl` and `machinesUrl` select alternate endpoints.

## Usage

```js
import { makeClient, listAppSecrets } from "sandstream-kit-plugin-fly";

const client = makeClient();
const secrets = await listAppSecrets(client, "my-app");
console.log(secrets.map(({ name }) => name));
```

## API

`listAppSecrets` and `listMachines` inspect an app. `setAppSecrets` and `unsetAppSecrets` change app secrets and enforce kit's read-only and policy controls. The API does not return secret plaintext in `listAppSecrets`.

## Testing

From the repository root, run `npm run build` and `npm test` to compile and run the package's tests in the monorepo suite. This package has no standalone `npm test` script.

## Troubleshooting

- `FLY_API_TOKEN not set`: provide a token through the environment or `makeClient`.
- App lookup fails: check the app name and token access.
- Write refused: check `KIT_READ_ONLY` and the project's agent-write policy.

## Support

Report package issues in [sandstream/kit issues](https://github.com/sandstream/kit/issues).

## Version

Current package version: `0.2.2`. See [CHANGELOG.md](./CHANGELOG.md).
