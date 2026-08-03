# Contributing to kit

Thank you for contributing to kit! This document outlines the process for developing, testing, and publishing.

## Development

### Prerequisites

- Node.js 22.0.0 or higher
- npm workspaces enabled (built into npm 7+)

### Setup

```bash
# Clone the repository
git clone https://github.com/sandstream/kit.git
cd kit

# Install dependencies
npm install

# Run tests
npm test

# Build for development
npm run build

# Run CLI from source
npm run dev -- check
```

### Running Tests

```bash
# Run all tests
npm test

# Run in watch mode (requires tsx)
npm run dev -- test
```

### Code Style

- Use TypeScript for the CLI and library code (the `src/` tree). JavaScript is
  only for tooling — `eslint.config.js` and the `scripts/` helpers (`.js`/`.mjs`)
  — and the triage gate's sandboxed checker is Python (`skills/triage/`).
- Follow the existing patterns in the codebase
- ESM modules only (no CommonJS)
- Include tests for new features

### Creating Service Adapters

Adapters follow the `ServiceAdapter` interface:

1. Create `src/adapters/<service>-<type>.ts`
2. Implement the interface with `name`, `description`, `getRequiredTools()`, `check()`, and `provision()`
3. Register in `src/adapters/index.ts`
4. Add tests in `src/adapters-<service>.test.ts`
5. Document in README

See `PLUGIN_AUTHORING.md` for creating plugin-based adapters.

## Publishing to npm

### Automatic Publishing (GitHub Actions)

The kit CLI is automatically published to npm when a version tag is pushed:

```bash
# 1. Bump the CLI. Do NOT bump the workspaces with it: `sandstream-kit-adapter-sdk` is frozen
#    on its OWN semver track (README.md, and public-surface.test.ts asserts 1.x), and the
#    plugins version independently too. An SDK major that tracked the CLI would force every
#    third-party plugin to bump its peerDependency range on each kit release for no API reason.
#    Bump a workspace only when its own code changes, as its own semver decision.
npm version patch --no-git-tag-version  # or minor, major

# 2. Update CHANGELOG.md (publish.yml verifies the version has an entry), commit, then tag.
#    The tag must be GPG-signed — publish.yml verifies the signature before it publishes.
git tag -s vX.Y.Z -m "kit X.Y.Z"
git push origin main --tags

# 3. The workflow then:
#    - verifies the tag signature, the tag↔package.json match, the CHANGELOG, that adapter-sdk
#      is still 1.x, and that every plugin's peer range admits the SDK version being published
#    - runs tests and builds production artifacts
#    - publishes `sandstream-kit` to npm with SLSA provenance
#    - publishes `sandstream-kit-adapter-sdk`, then the 11 first-party plugins — each at its OWN
#      declared version, skipping any already on the registry, so a re-run completes a partial
#      release instead of failing on a version that is already there
#    - creates the GitHub release and attaches the SBOMs

# 4. Users can then use:
npx sandstream-kit setup
```

**Why the plugins are published at all:** `packages/` is not in the root tarball, and
`plugin-loader.ts` resolves plugins by package name out of the consuming project's
`node_modules`. An unpublished workspace is therefore unreachable to anyone who has not cloned
this repo — and leaving a name unregistered that our own docs tell people to `npm install` is a
dependency-confusion invitation. Owning the name is the defensive position.

### Signed release tags

Release tags SHOULD be cryptographically signed so the tag itself shows as
**Verified** on GitHub (this is separate from — and in addition to — the npm
**provenance** attestation the publish workflow already produces via GitHub OIDC,
and from GitHub's own signing of squash-merge commits).

Git's signing config lives in your local/global git config, NOT in the repo (it
can't be committed), so each maintainer enables it once on their own machine.
kit uses **SSH signing** (despite the `gpg.*` config names):

```bash
# One-time, per machine — sign tags (and commits) with your SSH key:
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global tag.gpgsign true      # auto-sign every annotated tag
git config --global commit.gpgsign true   # (optional) auto-sign commits too
```

Make sure that same public key is added to your GitHub account under
**Settings → SSH and GPG keys → New SSH key → key type: Signing Key**, or GitHub
can't mark the tag Verified.

Then cut a signed release tag:

```bash
git tag -s v1.2.3 -m "kit 1.2.3"   # -s = signed (or just `git tag` once tag.gpgsign=true)
git push origin v1.2.3             # pushing the tag triggers the publish workflow
```

Prereleases (e.g. `v1.2.3-alpha.1`) publish under the npm `next` dist-tag, not
`latest` — see `.github/workflows/publish.yml`.

### Manual Publishing

If you need to publish manually (e.g., in a local environment without GitHub Actions):

```bash
# 1. Verify the package manifest
npm publish --dry-run

# 2. Build production artifacts
npm run build:prod

# 3. Publish to npm (requires NPM_TOKEN set in .npmrc or environment)
npm publish
```

### Version Management

- Follow [Semantic Versioning](https://semver.org/)
- Start at 0.1.0 for initial release
- Increment: major.minor.patch
  - **major**: Breaking changes
  - **minor**: New features (backwards compatible)
  - **patch**: Bug fixes

### npm Configuration

The package is configured in `package.json` for automatic publishing:

- **bin**: Exports the `kit` command globally
- **exports**: Exports the MCP server for programmatic use
- **files**: Includes only dist/ and README.md in published package
- **prepublishOnly**: Automatically builds before publishing

### NPM Credentials

GitHub Actions uses the `NPM_TOKEN` secret for authentication. To set up:

1. Generate token at https://npmjs.com/settings/tokens
2. Set as GitHub secret: `Settings` → `Secrets` → `NPM_TOKEN`
3. Token should have "publish" scope

## Pull Request Process

1. Create a branch: `git checkout -b feature/my-feature`
2. Make changes and commit: `git commit -am "feat: add my feature"`
3. Push: `git push origin feature/my-feature`
4. Open a pull request with a clear description
5. Address code review comments
6. PR will be merged once tests pass and changes are approved

## Issue Reports

When reporting issues:

- Include the output of `kit check`
- Include your OS and Node.js version
- Include minimal reproduction steps
- Tag with appropriate label (bug, feature-request, docs)

## Questions?

- Check [README.md](README.md) for usage
- See [PLUGIN_AUTHORING.md](PLUGIN_AUTHORING.md) for adapter development
- Open an issue for questions or discussions
