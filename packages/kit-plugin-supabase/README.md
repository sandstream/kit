# sandstream-kit-plugin-supabase

Supabase Management API client for project and API-key inspection, plus explicit key-rotation flows. It does not export a `kit add` database adapter.

## Installation

```bash
npm install sandstream-kit-plugin-supabase
```

## Configuration

Set `SUPABASE_ACCESS_TOKEN` in your secret manager, or pass `accessToken` to `makeClient`. `baseUrl` overrides the Management API endpoint. Rotation calls also need a project reference and a deliberate mode selection.

## Usage

```js
import { makeClient, listProjects } from "sandstream-kit-plugin-supabase";

const client = makeClient();
const projects = await listProjects(client);
console.log(projects.map(({ name }) => name));
```

## API

`listProjects`, `listApiKeys`, `detectKeyMode`, and `previewSupabaseRotation` inspect state. `rotateSupabaseKey` chooses `jwt-secret-roll` or `scoped-key-mint`; lower-level exports include `rollJwtSecret`, `mintScopedKey`, and `revokeScopedKey`. Rotation returns a value for kit's vault pipeline; this package does not write it to a vault. Mutating calls enforce kit's read-only and policy controls.

## Testing

From the repository root, run `npm run build --workspace=sandstream-kit-plugin-supabase` and `npm test --workspace=sandstream-kit-plugin-supabase`. The test command runs the package's compiled tests.

## Troubleshooting

- `SUPABASE_ACCESS_TOKEN not set`: provide a token through the environment or `makeClient`.
- Rotation mode rejected: call `previewSupabaseRotation` to inspect the project's key mode first.
- Write refused: check `KIT_READ_ONLY` and the project's agent-write policy.

## Support

Report package issues in [sandstream/kit issues](https://github.com/sandstream/kit/issues).

## Version

Current package version: `0.2.2`. See [CHANGELOG.md](./CHANGELOG.md).
