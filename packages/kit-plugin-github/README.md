# sandstream-kit-plugin-github

GitHub REST API client for repository Actions secrets and deploy keys. It exports a client API, not a `kit add` adapter.

## Installation

```bash
npm install sandstream-kit-plugin-github
```

## Configuration

Set `GITHUB_TOKEN` in your secret manager, or pass `token` to `makeClient`. Give the token only the repository permissions needed for the operations you call. `baseUrl` can select another GitHub API endpoint.

## Usage

```js
import { makeClient, listRepoSecrets } from "sandstream-kit-plugin-github";

const client = makeClient();
const secrets = await listRepoSecrets(client, "owner", "repository");
console.log(secrets.map(({ name }) => name));
```

## API

`listRepoSecrets` lists metadata, `listDeployKeys` lists deploy keys, and `createOrUpdateRepoSecret` / `deleteRepoSecret` change repository secrets. Write functions enforce kit's read-only and policy controls. Secret values are not returned by `listRepoSecrets`.

## Testing

From the repository root, run `npm run build --workspace=sandstream-kit-plugin-github` and `npm test --workspace=sandstream-kit-plugin-github`. The test command runs the package's compiled tests.

## Troubleshooting

- `GITHUB_TOKEN not set`: provide a token through the environment or `makeClient`.
- Repository request fails: check `owner`, `repo`, and token permissions.
- Write refused: check `KIT_READ_ONLY` and the project's agent-write policy.

## Support

Report package issues in [sandstream/kit issues](https://github.com/sandstream/kit/issues).

## Version

Current package version: `0.2.2`. See [CHANGELOG.md](./CHANGELOG.md).
