# API Stability & Versioning Guide

This document defines the versioning strategy, stability guarantees, and compatibility policy for kit and its plugin ecosystem.

## Table of Contents

1. [Semantic Versioning](#semantic-versioning)
2. [Stability Tiers](#stability-tiers)
3. [Compatibility Guarantees](#compatibility-guarantees)
4. [Deprecation Policy](#deprecation-policy)
5. [Breaking Changes](#breaking-changes)
6. [Release Process](#release-process)
7. [Migration Guides](#migration-guides)
8. [Long-Term Support](#long-term-support)
9. [Plugin Compatibility](#plugin-compatibility)

## Semantic Versioning

kit and plugins follow [Semantic Versioning 2.0.0](https://semver.org/).

```
MAJOR.MINOR.PATCH

Example: 1.2.3
         ↓ ↓ ↓
         │ │ └─ Patch: Bug fixes (1.2.3 → 1.2.4)
         │ └─── Minor: New features, backward compatible (1.2.3 → 1.3.0)
         └───── Major: Breaking changes (1.2.3 → 2.0.0)
```

### Version Increments

| Type | When | Increment | Examples |
|------|------|-----------|----------|
| **PATCH** | Bug fixes, security patches, minor improvements | Z in X.Y.Z | 1.2.3 → 1.2.4 |
| **MINOR** | New features, new adapters, new CLI commands | Y in X.Y.Z | 1.2.3 → 1.3.0 |
| **MAJOR** | Breaking API changes, removed features | X in X.Y.Z | 1.2.3 → 2.0.0 |

### Pre-Release Versions

For development and testing:

```
1.0.0-alpha.1    # Alpha release (experimental)
1.0.0-beta.1     # Beta release (feature complete)
1.0.0-rc.1       # Release candidate (release imminent)
```

## Stability Tiers

kit APIs are classified into stability tiers:

### 🟢 Stable (Production Ready)

**API:** ServiceAdapter interface, CLI commands, configuration format  
**Promise:** Will follow semantic versioning strictly  
**Breaking changes:** Only in MAJOR versions with migration guide  
**Deprecation notice:** Minimum 6 months notice before removal  

```typescript
// Stable interfaces
export interface ServiceAdapter {
  name: string;
  description: string;
  check(context: AdapterContext): Promise<boolean>;
  provision(context: AdapterContext): Promise<ProvisionResult>;
  getRequiredTools(): string[];
}
```

### 🟡 Evolving (Mostly Stable)

**API:** MCP protocol, plugin.json format, registry schema  
**Promise:** Backward compatibility maintained where possible  
**Breaking changes:** Rare, with extended notice period  
**Deprecation notice:** Minimum 3 months notice  

Examples:
- New optional fields in plugin.json
- New MCP tool parameters
- Enhanced registry features

### 🟠 Experimental (May Change)

**API:** Telemetry, performance monitoring, internal APIs  
**Promise:** No stability guarantees  
**Breaking changes:** Can happen in MINOR versions  
**Deprecation notice:** At least 1 month notice, best-effort  

Examples:
- Performance diagnostics API
- Internal telemetry hooks
- Experimental features marked `@experimental`

## Compatibility Guarantees

### kit Version Compatibility

kit versions are compatible with:
- All plugins specifying compatible kitVersion
- All configuration files from previous MINOR versions
- All environment variable formats from previous MAJOR versions

### Forward Compatibility

```toml
# .kit.toml from kit 1.0
# Works in kit 1.x, but not guaranteed in 2.0+
```

### Plugin Compatibility Matrix

```
kit Version  | Compatible Plugin API | Status
─────────────────────────────────────────────────
0.1.x          | ServiceAdapter v0.1   | Stable
1.0.x - 1.x.x  | ServiceAdapter v1.0   | Stable
2.0.x - 2.x.x  | ServiceAdapter v2.0   | Stable (future)
```

Plugins specify minimum kit version:

```json
{
  "name": "@provider/kit-stripe",
  "kitVersion": ">=1.0.0 <2.0.0"
}
```

### Plugin Compatibility with Each Other

Plugins are independent and can have different versions. kit manages:
- Version resolution
- Dependency tracking
- Conflict detection

```bash
# Install multiple plugins with different versions
kit plugin install stripe/payments        # Uses @1.0.0
kit plugin install supabase/database      # Uses @2.1.0
# Both work together as long as they target compatible kit versions
```

## Deprecation Policy

### Deprecation Timeline

1. **Announcement** (Month 0)
   - Feature marked as deprecated in documentation
   - Release notes highlight the change
   - Code comment added with `@deprecated`

2. **Support Period** (Months 1-6)
   - Feature continues to work
   - Warnings logged when used
   - Migration guide provided

3. **Removal** (Month 6+)
   - Feature removed in next MAJOR version
   - Clear migration instructions in changelog

### Example: Deprecating an Interface Method

```typescript
// Version 1.5.0: Deprecation announced
export interface ServiceAdapter {
  /**
   * @deprecated Use `getRequiredTools()` instead.
   * Will be removed in kit 2.0.0
   * See migration guide: docs/MIGRATION_1_5_TO_2_0.md
   */
  requiredTools?: string[];
  
  getRequiredTools(): string[];
}

// Version 1.6.0 - 1.9.9: Both work, warnings logged
if (adapter.requiredTools) {
  console.warn(
    "ServiceAdapter.requiredTools is deprecated. " +
    "Use getRequiredTools() instead. " +
    "Will be removed in kit 2.0.0"
  );
}

// Version 2.0.0: Removed
// requiredTools field no longer exists
```

## Breaking Changes

Breaking changes are **only** allowed in MAJOR version releases.

### Examples of Breaking Changes

❌ **NOT allowed in MINOR/PATCH:**
- Removing an interface property
- Changing parameter types
- Removing CLI commands
- Changing CLI behavior
- Renaming configuration keys

✅ **Allowed in MAJOR:**
- Removing deprecated features
- Changing interface structure
- Updating required Node.js version
- Reorganizing configuration

### Breaking Change Announcement

Breaking changes require:

1. **Release Notes** - Clearly documented
2. **Migration Guide** - Step-by-step instructions
3. **Changelog Entry** - Highlighted prominently
4. **Notice Period** - 6+ months advance warning

```markdown
# CHANGELOG.md

## [2.0.0] - 2026-10-15

### BREAKING CHANGES

- **Removed:** `ServiceAdapter.requiredTools` property
  - **Migration:** Use `getRequiredTools()` method instead
  - **Guide:** See [MIGRATION_1_TO_2.md](../CHANGELOG.md)
  
- **Changed:** Node.js minimum version from 18 to 20
  - **Migration:** Update your Node.js installation
  - **Guide:** See [Node.js Setup](../README.md)
```

## Release Process

### Pre-Release Checklist

- [ ] All tests passing (`npm test`)
- [ ] Code reviewed and approved
- [ ] Documentation updated
- [ ] CHANGELOG entries added
- [ ] Version bumped (npm version)
- [ ] Breaking changes documented

### Release Steps

```bash
# 1. Prepare release branch
git checkout -b release/1.2.0

# 2. Update version
npm version minor  # Bumps 1.1.x → 1.2.0

# 3. Build and test
npm run build
npm test

# 4. Update CHANGELOG
vim CHANGELOG.md
# Add: ## [1.2.0] - 2026-04-15
#      ### Added
#      - New feature description

# 5. Commit changes
git add package.json CHANGELOG.md
git commit -m "chore: release 1.2.0"

# 6. Create git tag
git tag v1.2.0

# 7. Push and create PR
git push origin release/1.2.0
# Create PR, wait for review and merge

# 8. Publish to npm
npm publish

# 9. Create GitHub release
gh release create v1.2.0 --generate-notes
```

### Release Cadence

| Release Type | Schedule | Example |
|---|---|---|
| **Patch** | As needed (bug fixes) | Weekly if issues found |
| **Minor** | Monthly or when features ready | 1st Tuesday of month |
| **Major** | Annually or as planned | Q4 each year |

## Migration Guides

### Versioning Migration Documents

Migration guides are provided for each MAJOR version:

```
../CHANGELOG.md
docs/MIGRATION_2_TO_3.md
```

### Migration Guide Structure

```markdown
# Migration Guide: kit 1.x → 2.0

## Overview
Summary of breaking changes and impact

## Breaking Changes
- Change 1: Old way → New way
- Change 2: Impact and action required

## Step-by-Step Migration
1. Update Node.js version requirement
2. Update .kit.toml format
3. Test your project
4. Update plugins

## Checklist
- [ ] Updated Node.js
- [ ] Updated .kit.toml
- [ ] Tested with new version
- [ ] All plugins updated
```

### Example: Plugin Migration

```typescript
// kit 1.0 (OLD)
export const adapter: ServiceAdapter = {
  name: "stripe/payments",
  requiredTools: ["curl"],  // ❌ Deprecated
};

// kit 2.0 (NEW)
export const adapter: ServiceAdapter = {
  name: "stripe/payments",
  getRequiredTools(): string[] {  // ✅ New way
    return ["curl"];
  },
};
```

## Long-Term Support

### LTS Versions

Major versions are designated as LTS (Long-Term Support):

| Version | Type | Released | End of Support |
|---------|------|----------|---|
| 1.0.x | LTS | 2026-04-15 | 2028-04-15 |
| 2.0.x | Current | 2026-10-15 | TBD |

### LTS Support Policy

**LTS Versions** receive:
- ✅ Security patches
- ✅ Critical bug fixes
- ✅ Compatibility updates for dependencies
- ❌ New features (only in next MAJOR)

**Non-LTS Versions** receive:
- ✅ All patches until end of life
- ❌ Support after next MAJOR released

Example:
```
1.0.0 (LTS)  - Release: 2026-04-15
1.1.0        - Release: 2026-06-15 (MINOR updates allowed)
1.0.5        - Release: 2026-08-15 (Security patch for 1.0 line)
2.0.0        - Release: 2026-10-15 (Next major)
1.0.x        - Support until: 2028-04-15
```

## Plugin Compatibility

### Plugin Version Requirements

Plugins specify the kit versions they support:

```json
{
  "kitVersion": ">=1.0.0 <2.0.0",
  "nodeVersion": ">=18.0.0"
}
```

### Compatible Ranges

| Range | Meaning | Example |
|-------|---------|---------|
| `1.0.0` | Exact version | Only kit 1.0.0 |
| `^1.0.0` | Compatible MINOR/PATCH | kit 1.0.0 through 1.9.9 |
| `~1.0.0` | Compatible PATCH only | kit 1.0.0 through 1.0.9 |
| `>=1.0.0 <2.0.0` | Range | kit 1.x only |
| `*` or `latest` | Any version | Not recommended |

### Plugin Update Strategy

When kit releases a new MAJOR version:

```bash
# kit 1.0 plugin
"kitVersion": ">=1.0.0 <2.0.0"

# After kit 2.0 released:
# Option 1: Support both
"kitVersion": ">=1.0.0"

# Option 2: Support only 2.0+
"kitVersion": ">=2.0.0"

# Option 3: Support both with major version
"kitVersion": ">=1.0.0 || >=2.0.0"
```

## Stability Checklist

Before marking a feature as stable:

- [ ] Used in production by multiple projects
- [ ] No known critical issues
- [ ] API design is sound (no planned changes)
- [ ] Documentation is complete
- [ ] Tests have >90% coverage
- [ ] Community feedback collected
- [ ] Performance benchmarked
- [ ] Security review completed

## API Stability Changes

Document any stability tier changes:

```
CHANGELOG.md:
- Feature X moved from Experimental → Evolving (in 1.5.0)
- Feature Y moved from Evolving → Stable (in 1.3.0)
```

## Version Communication

### Release Announcements

Each release includes:
- Changelog with all changes
- Migration guides for breaking changes
- Security advisories if applicable
- Performance improvements summary

### Deprecation Announcements

Deprecations are announced via:
- CHANGELOG.md entries
- GitHub releases and discussions
- Email to registered users (future)
- Console warnings in code

### Emergency Releases

Critical security issues trigger emergency releases:
- Bypass normal release schedule
- Released immediately after fix
- Back-ported to all supported versions
- Announced with severity level

## FAQ

### Q: Will kit plugins from 1.0 work with 2.0?

**A:** Only if the plugin specifies `kitVersion: ">=1.0.0"`. Most 1.0 plugins will need updates for 2.0. Check the plugin's `kitVersion` field and CHANGELOG.

### Q: Can I use multiple plugin versions?

**A:** Yes. kit manages compatibility. You can have:
- Plugin A v1.0.0 (supports kit 1.x)
- Plugin B v2.0.0 (supports kit 2.x)
Both work in the same kit 2.x project if compatible.

### Q: How long will 1.0 be supported?

**A:** Until 2028-04-15 (2 years from release). After that, only 2.0+ receives security updates.

### Q: What if my plugin uses deprecated features?

**A:** Update before the removal deadline:
1. See deprecation notice in code/docs
2. Follow migration guide
3. Test your plugin thoroughly
4. Publish updated version

### Q: Can I rely on experimental features?

**A:** No. Experimental features may change or be removed. Only use for testing/development.

## Resources

- [Semantic Versioning](https://semver.org/)
- [Keep a Changelog](https://keepachangelog.com/)
- [Node.js Version Policy](https://nodejs.org/en/about/releases/)
- [Plugin Development Guide](./PLUGIN_DEVELOPMENT.md)
- [Changelog Format](./CHANGELOG.md)

---

**Last Updated:** 2026-04-15  
**Status:** Stable  
**Applies to:** kit 1.0.0+
