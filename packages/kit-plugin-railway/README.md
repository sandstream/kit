# sandstream-kit-plugin-railway

[kit](https://github.com/sandstream/kit) `ServiceAdapter` for Railway project setup. It exports `adapter` with the service name `railway/deploy`.

## Installation

```bash
npm install --save-dev sandstream-kit-plugin-railway
```

Then register it in your `package.json`:

```json
{
  "kitPlugins": ["sandstream-kit-plugin-railway"]
}
```

## Usage

```bash
kit add railway/deploy
```

## Prerequisites

The `railway` CLI must be installed and available on `PATH`.

## What it does

1. Runs `railway login --browserless` unless an existing project ID is supplied
2. Creates a new Railway project with `railway init`
3. Returns `RAILWAY_PROJECT_ID` when Railway reports it, plus `RAILWAY_ENVIRONMENT`, to kit's provisioning flow

If `RAILWAY_PROJECT_ID` is already set, provisioning reuses it. `check()` also asks `railway status` whether the current directory is linked. When Railway's status JSON lacks a project ID, the adapter cannot return that ID; inspect the Railway project before relying on the generated configuration.

## Configuration

| Variable              | Description                                    |
| --------------------- | ---------------------------------------------- |
| `RAILWAY_PROJECT_ID`  | Railway project ID                             |
| `RAILWAY_ENVIRONMENT` | Deployment environment (default: `production`) |

## API

The package exports `adapter` (`railway/deploy`). Its `getRequiredTools()` returns `railway`; `check(context)` verifies a configured project ID and Railway CLI link; `provision(context)` reuses an existing project ID or attempts login and project initialization.

## Testing

From the repository root, run `npm run build --workspace=sandstream-kit-plugin-railway` and `npm test --workspace=sandstream-kit-plugin-railway`. The test command runs the package's compiled tests.

## Troubleshooting

- `railway` command missing: install the Railway CLI and confirm it is on `PATH`.
- Login or init fails: complete Railway authentication, then retry `kit add railway/deploy`.
- No `RAILWAY_PROJECT_ID` returned: inspect `railway status --json` and link the project before relying on the generated configuration.

## Support

Report package issues in [sandstream/kit issues](https://github.com/sandstream/kit/issues).

## Using this as a template for your own plugin

This package is the reference implementation for kit adapter plugins. To build your own:

1. Copy this directory structure
2. Rename `sandstream-kit-plugin-railway` → `sandstream-kit-plugin-<your-service>`
3. Implement `ServiceAdapter` from `sandstream-kit-adapter-sdk`
4. Export `{ adapter }` from `src/index.ts`
5. Publish to npm and add to `kitPlugins` in your project

See [PLUGIN_AUTHORING.md](https://github.com/sandstream/kit/blob/main/PLUGIN_AUTHORING.md) for the full guide.

## Version

Current package version: `0.1.2`. See [CHANGELOG.md](./CHANGELOG.md).
