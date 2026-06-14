# sandstream-kit-plugin-railway

[kit](https://github.com/sandstream/kit) adapter plugin for [Railway](https://railway.app) — Heroku-style deployment platform.

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

Or via MCP:

```json
{ "name": "kit_add", "arguments": { "service": "railway/deploy", "project_name": "my-app" } }
```

## Prerequisites

The Railway CLI must be installed:

```bash
npm install -g @railway/cli
```

## What it does

1. Runs `railway login --browserless` (suitable for agent/CI use)
2. Creates a new Railway project with `railway init`
3. Writes `RAILWAY_PROJECT_ID` and `RAILWAY_ENVIRONMENT` to `.env.local`

If `RAILWAY_PROJECT_ID` is already set, provisioning is skipped (key-reuse pattern).

## Environment variables

| Variable | Description |
|----------|-------------|
| `RAILWAY_PROJECT_ID` | Railway project ID |
| `RAILWAY_ENVIRONMENT` | Deployment environment (default: `production`) |

---

## Using this as a template for your own plugin

This package is the reference implementation for kit adapter plugins. To build your own:

1. Copy this directory structure
2. Rename `sandstream-kit-plugin-railway` → `sandstream-kit-plugin-<your-service>`
3. Implement `ServiceAdapter` from `sandstream-kit-adapter-sdk`
4. Export `{ adapter }` from `src/index.ts`
5. Publish to npm and add to `kitPlugins` in your project

See [PLUGIN_AUTHORING.md](../../PLUGIN_AUTHORING.md) for the full guide.
