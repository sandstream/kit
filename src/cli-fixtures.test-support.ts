/** Config fixtures shared by the cli*.test.ts files. */

export const FIXTURE_EMPTY = `# Minimal kit config — no tools, services, or secrets
`;

export const FIXTURE_CONFIG_SECRET = `# Config with config-sourced secrets (always available, no CLI deps)
[secrets]
store = "env"

[secrets.keys]
APP_NAME = { source = "config", value = "my-app" }
APP_ENV = { source = "config", value = "test" }
`;

export const FIXTURE_ENV_SECRET = `# Config with env-sourced secret
[secrets]
store = "env"

[secrets.keys]
_KIT_INTEG_SECRET = { source = "env" }
`;

export const FIXTURE_MISSING_ENV_SECRET = `# Config requiring env var that is not set
[secrets]
store = "env"

[secrets.keys]
_KIT_DEFINITELY_ABSENT_XYZ = { source = "env" }
`;

export const FIXTURE_NODE_TOOL = `# Config requiring node at latest (always installed in CI)
[tools]
node = "latest"
`;

export const FIXTURE_FULL_PIPELINE = `# Full pipeline fixture: config secrets + node tool
[tools]
node = "latest"

[secrets]
store = "env"

[secrets.keys]
BUILD_TARGET = { source = "config", value = "production" }
`;

export const FIXTURE_MANUAL_SERVICES = `# Services that need human-in-the-loop setup
[services.stripe]
login = "stripe login"
check = "kit-definitely-missing-auth-check"

[services.sentry]
login = "# sentry - no CLI login; get DSN from https://sentry.io"
check = "# sentry - check SENTRY_DSN is set"

[secrets]
store = "env"
template = ".env.template"

[secrets.keys]
SENTRY_DSN = { source = "env" }
SENTRY_AUTH_TOKEN = { source = "env" }
`;

export const FIXTURE_DEPLOY_MISSING = `
[deploy.vercel.environments.production]
project = "app-prod"
required = ["NEXT_PUBLIC_SENTRY_DSN", "NEXT_PUBLIC_SENTRY_ENVIRONMENT"]
`;

export const FIXTURE_DEPLOY_FIX = `
[secrets.keys]
NEXT_PUBLIC_SENTRY_ENVIRONMENT = { source = "config", value = "super-secret-env-value" }

[deploy.vercel.environments.production]
project = "app-prod"
required = ["NEXT_PUBLIC_SENTRY_ENVIRONMENT"]
remote_env = "production"
`;
