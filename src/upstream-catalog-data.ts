/**
 * Built-in release sources for `kit upstream`. Data only: the mapping from a service to the npm
 * packages and GitHub repos that publish its releases lives here, not in code branches. The shape
 * is checked by `validateUpstreamCatalog` (see upstream-catalog.ts) and by its test.
 *
 * `kitServices` lists the `[services.<name>]` keys in `.kit.toml` that mean the same service.
 * Add a row here, or override one per project with an `[upstream.<id>]` table.
 */
export const UPSTREAM_CATALOG_DATA: readonly unknown[] = [
  {
    id: "convex",
    label: "Convex",
    npm: ["convex", "@convex-dev/eslint-plugin"],
    github: ["convex/convex-js"],
    kitServices: ["convex"],
  },
  {
    id: "stripe",
    label: "Stripe",
    npm: ["stripe"],
    github: ["stripe/stripe-node"],
    kitServices: ["stripe"],
  },
  {
    id: "workos",
    label: "WorkOS",
    npm: ["@workos-inc/node"],
    github: ["workos/workos-node"],
    kitServices: ["workos"],
  },
];
