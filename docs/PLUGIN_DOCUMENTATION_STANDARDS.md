# Plugin Documentation Standards

This document defines the documentation structure and content standards for all kit plugins. Following these standards ensures plugins are discoverable, understandable, and professional.

## Document Structure

Every plugin package needs a README, CHANGELOG, and package metadata. Use either a self-contained README or split supporting docs:

```
plugin-root/
├── README.md              # Required: installation, configuration, usage, API,
│                          # testing, troubleshooting, support, and version
├── CHANGELOG.md           # Required: verified version history
├── package.json           # Required: package metadata
├── docs/                  # Optional when these topics are complete in README
│   ├── API.md
│   ├── CONFIGURATION.md
│   ├── EXAMPLES.md
│   ├── TESTING.md
│   └── TROUBLESHOOTING.md
└── plugin.json            # Optional registry metadata
```

Small first-party packages may keep all five topics in README rather than create empty or repetitive `docs/` files. Split a topic into `docs/` when it needs more detail, and link it from README. The published tarball must contain every document the README links to.

Match the package type: a `ServiceAdapter` can document `kit add <adapter-name>` after registration in `kitPlugins`; an API client documents its exported functions; a scanner-ingestion package documents its input, local output, and any read-only API calls. Do not present API clients or ingestion packages as `kit add` services.

## README.md (Required)

The README is the primary entry point. It should be concise but comprehensive.

The following extended template illustrates a service adapter. Replace adapter-specific commands and methods with the real exports for API clients or ingestion packages. For a self-contained README, include the API, configuration, examples, testing, and troubleshooting content directly instead of linking to `docs/`.

### Structure

```markdown
# Plugin Name

> One-line description

## Overview

2-3 paragraph overview of what this plugin does and when to use it.

### When to Use
- Use case 1
- Use case 2
- NOT suitable for [counter-case]

## Quick Start

```bash
kit plugin install railway
```

### Minimal Setup

Show the absolute minimum to get working:

```typescript
export const myAdapter: ServiceAdapter = {
  name: "provider/service",
  description: "...",
  // ...
};
```

## Features

- Feature 1: Description
- Feature 2: Description
- Feature 3: Description

## Installation

```bash
# Via kit (use the registry ID, not the adapter's provider/service name)
kit plugin install railway

# Via npm
npm install @provider/kit-service
```

## Configuration

Set required environment variables:

```env
SERVICE_API_KEY=your_key_here
SERVICE_WEBHOOK_SECRET=webhook_secret
```

See [CONFIGURATION.md](./docs/CONFIGURATION.md) for details.

## Usage Examples

### Basic Example

```typescript
// Using the adapter
const context = {
  projectPath: "/path/to/project",
  existingEnv: process.env,
};

const result = await adapter.provision(context);
if (result.success) {
  console.log("Configured:", result.secrets);
}
```

See [EXAMPLES.md](./docs/EXAMPLES.md) for more.

## API Reference

- `name`: string - Unique identifier (provider/service format)
- `check()` - Verify if already provisioned
- `provision()` - Perform provisioning
- `getRequiredTools()` - List required CLI tools

Full API documentation: [API.md](./docs/API.md)

## Testing

```bash
npm test
```

All tests should pass. See [TESTING.md](./docs/TESTING.md) for testing guidelines.

## Troubleshooting

Common issues and solutions: [TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)

## Support

- GitHub Issues: [provider/kit-service/issues](https://github.com/provider/kit-service/issues)
- Documentation: [Full Docs](./docs)
- kit Plugin Guide: [Plugin Development](../PLUGIN_DEVELOPMENT.md)

## License

MIT (or your chosen license)

## Version

Current version: 1.0.0

See [CHANGELOG.md](./CHANGELOG.md) for version history.
```

## Detailed reference examples

The [adapter documentation examples](./PLUGIN_DOCUMENTATION_REFERENCE.md) show expanded API, configuration, usage, and testing pages for packages that need more than a self-contained README. These examples are optional layouts; the coverage requirements above apply either way.

## CHANGELOG.md

Version history and breaking changes.

```markdown
# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-15

### Added
- Initial release
- ServiceAdapter implementation for Service Name
- Support for API key authentication
- Webhook signature validation
- Complete test suite (10 tests, 100% pass)

### Changed
- Breaking: Renamed SERVICE_TOKEN to SERVICE_API_KEY
- Updated to sandstream-kit-adapter-sdk 0.1.0

### Fixed
- Incorrect timeout values in retry logic

### Deprecated
- SERVICE_TOKEN environment variable (use SERVICE_API_KEY)

## [0.1.0] - 2026-04-01

### Added
- Beta release for testing
- Basic adapter structure

---

## Version Format

Use [Semantic Versioning](https://semver.org/):
- MAJOR: Breaking changes (0.1.0 → 1.0.0)
- MINOR: New features (1.0.0 → 1.1.0)
- PATCH: Bug fixes (1.0.0 → 1.0.1)

## Commit Message Standards

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation only
- `perf:` Performance improvement
- `test:` Test additions/changes
- `chore:` Dependencies, tooling

Example: `feat: add webhook signing support`
```

## package.json Metadata

Include plugin metadata in package.json:

```json
{
  "name": "@provider/kit-service",
  "version": "1.0.0",
  "description": "kit adapter for Service Name",
  "type": "module",
  "license": "MIT",
  "author": "Your Name <email@example.com>",
  "repository": {
    "type": "git",
    "url": "https://github.com/provider/kit-service"
  },
  "keywords": ["kit", "adapter", "service-name", "plugin"],
  "kitPlugin": {
    "name": "provider/service",
    "description": "Provisions Service Name",
    "tags": ["category1", "category2"],
    "requiredTools": ["cli-tool-1"],
    "minkitVersion": "0.1.0"
  }
}
```

## Registry Metadata Schema

For plugins submitted to the official registry, include a `plugin.json`:

```json
{
  "name": "provider/service",
  "description": "What this plugin does",
  "version": "1.0.0",
  "author": "Your Name",
  "license": "MIT",
  "repository": "https://github.com/provider/kit-service",
  "package": "@provider/kit-service",
  "kitVersion": ">=0.1.0",
  "tags": ["category", "tag"],
  "published": "2026-04-15T00:00:00Z",
  "downloads": 0,
  "rating": 5.0,
  "install": "npm install @provider/kit-service"
}
```

## Documentation Quality Checklist

- [ ] README is concise (< 200 lines)
- [ ] Installation instructions are clear
- [ ] Configuration section shows all required env vars
- [ ] Examples work without modification
- [ ] API documentation is complete
- [ ] Testing instructions match the scripts this package actually provides
- [ ] Troubleshooting covers common issues
- [ ] Support path is provided
- [ ] Every linked file is included in the npm tarball
- [ ] CHANGELOG follows Semantic Versioning
- [ ] All documentation is spell-checked
- [ ] Links are not broken
- [ ] Code examples are tested and pass

## Best Practices

### DO

- Keep documentation DRY (don't repeat sections)
- Use clear headings and structure
- Provide working code examples
- Include error handling examples
- Document required CLI tools
- Explain what env vars do
- List related resources

### DON'T

- Assume user knowledge of the service
- Bury long reference material in a README when a linked supporting document is clearer
- Use acronyms without explanation
- Hardcode usernames/credentials in examples
- Document unfinished features
- Forget to update docs when code changes

## Publishing Documentation

When publishing to npm:

1. Include README and CHANGELOG, plus any linked `docs/` files, in the package.
2. Set `files` in package.json to match the chosen layout. For a split layout:
   ```json
   "files": ["dist", "docs", "README.md", "CHANGELOG.md"]
   ```
   For a self-contained README, omit `docs` and retain both Markdown files.
3. Create detailed npm package description
4. Link to GitHub repository
5. Add topic: "kit-plugin"

## Validation

To validate plugin documentation:

```bash
# Check files exist
test -f README.md || echo "Missing README.md"
test -f CHANGELOG.md || echo "Missing CHANGELOG.md"
# A docs/ directory is optional when README covers its five topics.

# Check required sections in README
grep -q "Installation" README.md || echo "Missing Installation section"
grep -q "Configuration" README.md || echo "Missing Configuration section"
grep -q "Usage" README.md || echo "Missing Usage section"
grep -q "API" README.md || echo "Missing API section"
grep -q "Testing" README.md || echo "Missing Testing section"
grep -q "Troubleshooting" README.md || echo "Missing Troubleshooting section"
grep -q "Support" README.md || echo "Missing Support section"
npm pack --dry-run --json  # Inspect README, CHANGELOG, linked docs, and test exclusions.
```

## Template

Use this as a template for new plugins:

```bash
kit plugin scaffold my-plugin
# Comes with template files following these standards
```

All generated templates follow this documentation standard.
