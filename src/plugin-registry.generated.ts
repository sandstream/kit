/**
 * kit's OFFICIAL PLUGINS — generated from each plugin package manifest under packages.
 *
 * (The path is spelled out rather than globbed: a literal star-slash inside a block comment ends
 * the comment early, and the first version of this generator emitted a file TypeScript could not
 * parse. Writing it with a backtick broke the generator's own template literal instead.)
 *
 * GENERATED. Regenerate with:  node scripts/gen-plugin-registry.mjs
 * `plugins-registry.test.ts` fails when this file drifts from the packages on disk, so a shipped
 * plugin cannot stay invisible and an entry cannot describe a package that does not exist.
 *
 * The hand-written table this replaces advertised npm packages that were never published
 * (`@kit/plugins/stripe`), a 404 repository per plugin, versions that did not match the published
 * ones, and invented ratings and download counts that `kit plugin list` printed as `★★★★◆ 4.8`.
 * Five of eleven shipped plugins were listed at all.
 *
 * Fields with no local source — rating, downloads, publish date — are absent by design. The display
 * code treats them as optional, so absent means unshown rather than estimated.
 */

import type { PluginMetadata } from "./plugins.js";

export const OFFICIAL_PLUGINS: PluginMetadata[] = [
  {
    name: "aisle",
    description: "AISLE nano-analyzer result ingestion for kit (read-only).",
    version: "0.1.0",
    author: "Sandstream",
    license: "MIT",
    repository: "https://github.com/sandstream/kit",
    package: "sandstream-kit-plugin-aisle",
    kitVersion: ">=6.0.0",
    tags: ["aisle", "ingestion", "kit-plugin", "official", "read-only", "scanning", "security"],
    install: "npm install sandstream-kit-plugin-aisle",
  },
  {
    name: "cloudflare",
    description: "Cloudflare Workers secret + API token surface for kit",
    version: "0.2.1",
    author: "Sandstream",
    license: "MIT",
    repository: "https://github.com/sandstream/kit",
    package: "sandstream-kit-plugin-cloudflare",
    kitVersion: ">=6.0.0",
    tags: ["cloudflare", "hosting", "kit-plugin", "official", "secrets", "workers"],
    install: "npm install sandstream-kit-plugin-cloudflare",
  },
  {
    name: "fly",
    description: "Fly.io app-secret rotation via flyctl GraphQL API",
    version: "0.2.1",
    author: "Sandstream",
    license: "MIT",
    repository: "https://github.com/sandstream/kit",
    package: "sandstream-kit-plugin-fly",
    kitVersion: ">=6.0.0",
    tags: ["deployment", "fly", "fly.io", "hosting", "kit-plugin", "official", "secrets"],
    install: "npm install sandstream-kit-plugin-fly",
  },
  {
    name: "github",
    description: "kit plugin: GitHub REST API (repo + org secrets, deploy keys, workflow runs).",
    version: "0.2.1",
    author: "Sandstream",
    license: "MIT",
    repository: "https://github.com/sandstream/kit",
    package: "sandstream-kit-plugin-github",
    kitVersion: ">=6.0.0",
    tags: ["ci", "github", "kit-plugin", "official", "secrets", "vcs"],
    install: "npm install sandstream-kit-plugin-github",
  },
  {
    name: "railway",
    description: "kit adapter plugin for Railway deployment platform",
    version: "0.1.1",
    author: "Sandstream",
    license: "MIT",
    repository: "https://github.com/sandstream/kit",
    package: "sandstream-kit-plugin-railway",
    kitVersion: ">=6.0.0",
    tags: ["deployment", "hosting", "kit-plugin", "official", "railway"],
    install: "npm install sandstream-kit-plugin-railway",
  },
  {
    name: "sentrux",
    description: "Sentrux architecture-scan ingestion for kit (read-only).",
    version: "0.1.1",
    author: "Sandstream",
    license: "MIT",
    repository: "https://github.com/sandstream/kit",
    package: "sandstream-kit-plugin-sentrux",
    kitVersion: ">=6.0.0",
    tags: ["ingestion", "kit-plugin", "official", "read-only", "scanning", "security", "sentrux"],
    install: "npm install sandstream-kit-plugin-sentrux",
  },
  {
    name: "sentry",
    description:
      "Sentry REST API client for kit — issue triage, release tagging, project introspection.",
    version: "0.2.1",
    author: "Sandstream",
    license: "MIT",
    repository: "https://github.com/sandstream/kit",
    package: "sandstream-kit-plugin-sentry",
    kitVersion: ">=6.0.0",
    tags: ["kit-plugin", "monitoring", "observability", "official", "sentry"],
    install: "npm install sandstream-kit-plugin-sentry",
  },
  {
    name: "snyk",
    description: "Snyk scan-result ingestion for kit (read-only).",
    version: "0.1.1",
    author: "Sandstream",
    license: "MIT",
    repository: "https://github.com/sandstream/kit",
    package: "sandstream-kit-plugin-snyk",
    kitVersion: ">=6.0.0",
    tags: ["ingestion", "kit-plugin", "official", "read-only", "scanning", "security", "snyk"],
    install: "npm install sandstream-kit-plugin-snyk",
  },
  {
    name: "stripe",
    description:
      "Stripe Management API surface for kit (webhook endpoint rotation + account introspection)",
    version: "0.2.1",
    author: "Sandstream",
    license: "MIT",
    repository: "https://github.com/sandstream/kit",
    package: "sandstream-kit-plugin-stripe",
    kitVersion: ">=6.0.0",
    tags: ["kit-plugin", "official", "payments", "stripe", "webhooks"],
    install: "npm install sandstream-kit-plugin-stripe",
  },
  {
    name: "supabase",
    description:
      "kit plugin: Supabase Management API integration (service-role key rotation, project introspection).",
    version: "0.2.1",
    author: "Sandstream",
    license: "MIT",
    repository: "https://github.com/sandstream/kit",
    package: "sandstream-kit-plugin-supabase",
    kitVersion: ">=6.0.0",
    tags: ["database", "kit-plugin", "official", "secrets", "supabase"],
    install: "npm install sandstream-kit-plugin-supabase",
  },
  {
    name: "vercel",
    description:
      "kit plugin: Vercel Management API (env management, project metadata, redeploy triggers).",
    version: "0.2.1",
    author: "Sandstream",
    license: "MIT",
    repository: "https://github.com/sandstream/kit",
    package: "sandstream-kit-plugin-vercel",
    kitVersion: ">=6.0.0",
    tags: ["deployment", "env", "hosting", "kit-plugin", "official", "vercel"],
    install: "npm install sandstream-kit-plugin-vercel",
  },
  {
    name: "wiz",
    description: "Wiz issue-graph ingestion for kit (read-only).",
    version: "0.1.1",
    author: "Sandstream",
    license: "MIT",
    repository: "https://github.com/sandstream/kit",
    package: "sandstream-kit-plugin-wiz",
    kitVersion: ">=6.0.0",
    tags: ["ingestion", "kit-plugin", "official", "read-only", "scanning", "security", "wiz"],
    install: "npm install sandstream-kit-plugin-wiz",
  },
];
