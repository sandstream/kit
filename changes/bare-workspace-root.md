### Fixed

- **A bare install below a workspace root is refused until the root is reviewed** (`install gate`):
  npm and bun follow the registry config of a parent `package.json` with `workspaces`, and pnpm that
  of a parent `pnpm-workspace.yaml`, when that root lists the folder as a member. The check for a
  folder's own `.npmrc` did not see it. The gate now walks up from the install folder and refuses
  when a parent is such a root, or holds a `package.json` it cannot read. A plain parent `.npmrc`
  next to a parent `package.json` without `workspaces` stays allowed: npm, pnpm and bun ignore it
  when the folder has its own `package.json`. Probed with npm 10, pnpm 10 and bun 1.3; yarn is
  assumed to follow the same `workspaces` rule and was not run.
