# Changelog

sandstream-kit-adapter-sdk follows its own semantic-versioning track, decoupled
from the kit CLI version. The major version of this package is the contract: a
bump to 2.0.0 means the adapter interface shape changed in a breaking way.

## 1.0.0 - frozen public API

First stable release. The public interface is now FROZEN: within the 1.x line the
shapes below will not change in a breaking way (no removed/renamed members, no
narrowed types). Additive, backward-compatible growth (new optional fields, new
exports) may ship in 1.x minors.

Frozen public exports:

- `ServiceAdapter` (interface) - the adapter contract: `name`, `description`,
  `check(ctx)`, `provision(ctx)`, `getRequiredTools()`.
- `AdapterContext` (interface) - `projectPath`, optional `projectName`,
  `existingEnv`.
- `ProvisionResult` (interface) - `success`, `message`, optional `secrets`,
  `config`, `error`.
- `AdapterRegistry` (interface) - `{ [key: string]: ServiceAdapter }`.
- `ReadOnlyModeError` (class) - thrown by `assertNotReadOnly`.
- `isReadOnlyMode()` (function) - reads `KIT_READ_ONLY` from the environment.
- `assertNotReadOnly(operation)` (function) - throws `ReadOnlyModeError` in
  read-only mode.

### kit compatibility

| adapter-sdk | kit CLI                               |
| ----------- | ------------------------------------- |
| 1.x         | kit 1.40+ and the entire kit 2.x line |

The read-only contract is environment-level (`KIT_READ_ONLY=1`), not an import of
kit-core, so adapters built against 1.x keep working across the kit 2.0 major bump
without recompilation.

### peerDependencies guidance

This package ships type-only contracts and has no runtime dependencies, so it does
not declare a peer dependency on the kit CLI. Plugins that consume it should pin a
caret range so they pick up additive 1.x growth but never a breaking 2.0:

```json
{
  "dependencies": {
    "sandstream-kit-adapter-sdk": "^1.0.0"
  }
}
```

### Notes for the next major

- `ProvisionResult` carries both a human-readable `message` and an optional
  `error`. This is intentional (a failure can surface a multi-line `message` for
  the user plus a short machine `error`), so it is frozen as-is rather than
  collapsed. A future 2.0 could revisit consolidating these, but 1.x keeps both.
