# Getting Started with kit Plugins

Kit's plugin registry lists packages published from this repository. Run `kit plugin list` to see the current IDs and `kit plugin info <id>` to inspect a package before installing it. The registry is generated from package manifests; it does not include unpublished services.

## Choose the package you need

Two package types appear in the registry:

| Type | Example | What installation does |
| --- | --- | --- |
| Service adapter | `railway` | Installs `sandstream-kit-plugin-railway` and adds it to the project's `package.json` `kitPlugins` array. Its `railway/deploy` adapter then becomes available to `kit add`. |
| API client or result ingestion | `stripe`, `supabase`, `snyk` | Installs the npm package for use through its exported API. These packages do not export a `ServiceAdapter`, so installation does not add them to `kitPlugins` or make them available to `kit add`. Consult each package's README for its API. |

`kit plugin info <id>` prints the package's integration type and install command. Install from the root of a Node project. An adapter needs a project `package.json` so kit can record its registration.

## Install and use an adapter

```bash
kit plugin search railway
kit plugin info railway
kit plugin install railway
kit add railway/deploy
```

`kit plugin install` triages the npm package before running `npm install`. For an adapter, it then records the package name in `kitPlugins`. Repeating the command does not duplicate the entry. If the npm package was already installed, the command still registers it.

You can also inspect the resulting manifest:

```json
{
  "kitPlugins": ["sandstream-kit-plugin-railway"]
}
```

The adapter loader reads this array when `kit add` runs, including `kit add --list`. `kit check` does not load plugin adapters, and kit exposes no `kit_add` MCP tool. Install an API-only package such as `stripe` only if your code needs its exported API; it does not provision a Stripe integration through `kit add`.

## Create an adapter package

```bash
kit plugin scaffold my-service
# Or skip dependency installation and install later:
kit plugin scaffold another-service --skip-install
cd kit-plugin-my-service
npm run build
npm test
```

The scaffold contains TypeScript source, tests, and a local type stub for the adapter SDK. By default the scaffold command installs its development tools, including in a production-configured Docker image. With `--skip-install`, install them before building. If dependency triage blocks installation or npm fails, follow the command's printed recovery steps before building.

Edit `src/my-service.ts`, then build and test again. The generated README explains how to add the published package to a consuming project's `kitPlugins` array. Read the [development guide](./PLUGIN_DEVELOPMENT.md), [documentation standards](./PLUGIN_DOCUMENTATION_STANDARDS.md), and [publishing checklist](./PLUGIN_PUBLISHING_CHECKLIST.md) before publishing.

## Current official packages

Use `kit plugin list` for the authoritative list. At this release, the registry includes `aisle`, `cloudflare`, `fly`, `github`, `railway`, `sentrux`, `sentry`, `snyk`, `stripe`, `supabase`, `vercel`, and `wiz`. Only `railway` advertises a `ServiceAdapter` for `kit add`; the other packages expose APIs or ingest results.
