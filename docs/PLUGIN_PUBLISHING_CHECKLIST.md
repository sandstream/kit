# Plugin Publishing Checklist

Use this checklist before publishing your plugin to npm and registering with the kit registry.

## Pre-Publishing (Local Testing)

### Code Quality
- [ ] All TypeScript compiles without errors: `npm run build`
- [ ] All tests pass: `npm test`
- [ ] Test coverage is >90%
- [ ] No console.log() or debug statements left
- [ ] No hardcoded credentials or secrets
- [ ] No unused imports or variables
- [ ] Code follows consistent style

### Functionality
- [ ] `check()` correctly identifies if service is configured
- [ ] `provision()` works with missing credentials
- [ ] `provision()` works with existing credentials (key-reuse)
- [ ] `getRequiredTools()` returns correct CLI tool names
- [ ] All error messages are helpful and actionable
- [ ] No unhandled promise rejections

### Testing
- [ ] Tested with missing environment variables
- [ ] Tested with invalid environment variables
- [ ] Tested with existing valid configuration
- [ ] Tested error paths and recovery
- [ ] Tested with different Node.js versions (18+)

## Documentation

### README.md
- [ ] Title clearly explains what the plugin does
- [ ] Overview section describes use cases
- [ ] Quick start shows minimal working example
- [ ] Installation instructions are clear
- [ ] Configuration section lists all required env vars
- [ ] Usage examples are working and tested
- [ ] API reference is complete
- [ ] Troubleshooting covers common issues
- [ ] Support/contact information provided
- [ ] No broken links
- [ ] Spell-checked

### Other Documentation
- [ ] `docs/API.md` exists (or in README)
- [ ] `docs/CONFIGURATION.md` exists (or in README)
- [ ] `docs/EXAMPLES.md` exists (or in README)
- [ ] `CHANGELOG.md` exists with version info
- [ ] All documentation follows [standards](./PLUGIN_DOCUMENTATION_STANDARDS.md)

## Package Configuration

### package.json
- [ ] Name follows convention: `@provider/kit-service` or `sandstream-kit-plugin-service`
- [ ] Version is valid semver: `1.0.0`, `0.1.0`, etc.
- [ ] Description is clear and concise
- [ ] Keywords include: `kit`, `adapter`, `plugin`
- [ ] Author name and email are correct
- [ ] License is specified (MIT recommended)
- [ ] Repository URL points to git repo
- [ ] `files` array includes: `dist`, `README.md`, `CHANGELOG.md`, `LICENSE`
- [ ] `main`/`exports` point to compiled output
- [ ] No `devDependencies` in production build

### tsconfig.json
- [ ] `strict: true` for type safety
- [ ] `declaration: true` to generate .d.ts files
- [ ] `outDir` points to `dist`
- [ ] `module` is set correctly for your target

### .gitignore
- [ ] `node_modules/` ignored
- [ ] `dist/` ignored (if generated)
- [ ] `.env*` ignored (don't commit credentials!)
- [ ] `.DS_Store` ignored (Mac)
- [ ] `.env.local` ignored

## Build & Distribution

### Compilation
- [ ] `npm run build` succeeds
- [ ] `dist/` directory has compiled JavaScript
- [ ] `dist/` directory has `.d.ts` files
- [ ] No errors in compiled output

### Testing Production Build
- [ ] `npm test` passes on dist/ files
- [ ] Plugin can be imported from dist/
- [ ] No missing dependencies

### Package Contents
- [ ] Verify package contents: `npm pack --dry-run`
- [ ] Only necessary files are included
- [ ] No large unnecessary files
- [ ] No credentials or secrets in package

## Registry Preparation

### npm Registration
- [ ] npm account created and logged in
- [ ] 2FA enabled on npm account (recommended)
- [ ] Package name is available and not taken
- [ ] Scope is correct (`@provider/` or `sandstream-kit-plugin-`)

### Plugin.json Metadata
- [ ] Create `plugin.json` with registry metadata:
  ```json
  {
    "name": "provider/service",
    "description": "...",
    "version": "1.0.0",
    "author": "Your Name",
    "license": "MIT",
    "repository": "https://github.com/.../...",
    "package": "@provider/kit-service",
    "kitVersion": ">=0.1.0",
    "tags": ["category1", "category2"],
    "published": "2026-04-15T00:00:00Z",
    "install": "npm install @provider/kit-service"
  }
  ```

## Publishing Steps

### Step 1: Final Verification
- [ ] Run: `npm run build`
- [ ] Run: `npm test`
- [ ] Run: `npm run lint` (if configured)
- [ ] Review: `npm pack --dry-run`

### Step 2: Version Update
- [ ] Update version in `package.json`
- [ ] Conventional: `npm version patch|minor|major`
- [ ] Update `CHANGELOG.md` with new version

### Step 3: Git Commit
```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump version to 1.0.0"
git tag v1.0.0
git push origin main --tags
```

### Step 4: npm Publish
```bash
# Verify credentials
npm whoami

# Publish to npm
npm publish

# Wait for publish to complete (verify on npmjs.com)
```

### Step 5: Announce
- [ ] Post on GitHub Discussions/Issues
- [ ] Create release on GitHub
- [ ] Share on Twitter/community channels
- [ ] Update kit registry (submit PR or form)

## Post-Publishing

### Verification
- [ ] Package is visible on https://www.npmjs.com/
- [ ] GitHub release is created
- [ ] Installation works: `npm install @provider/kit-service`
- [ ] Package can be imported in a test project

### Registry Registration
- [ ] Submitted plugin info to kit registry
- [ ] Plugin appears in `kit plugin list`
- [ ] Plugin is searchable via `kit plugin search`

### Maintenance
- [ ] Monitor for issues and bug reports
- [ ] Plan for updates and improvements
- [ ] Keep documentation up-to-date
- [ ] Respond to community feedback

## Semantic Versioning Guide

| Change | Version | Example |
|--------|---------|---------|
| Breaking API changes | MAJOR | 1.0.0 → 2.0.0 |
| New features, backward compatible | MINOR | 1.0.0 → 1.1.0 |
| Bug fixes, patches | PATCH | 1.0.0 → 1.0.1 |

### When to Release
- **PATCH**: Bug fix, small improvement
- **MINOR**: New feature that doesn't break existing code
- **MAJOR**: Breaking changes (e.g., renamed interface, removed method)

## Common Issues & Solutions

### "Package already exists"
**Problem**: Error when publishing to npm.

**Solution**:
1. Check package name is unique: https://www.npmjs.com/
2. Try different scope: `@mycompany/kit-service`
3. Try different name: `kit-plugin-my-service`

### "401 Unauthorized"
**Problem**: npm authentication failed.

**Solution**:
1. Run: `npm login`
2. Enter npm username and password
3. Enable 2FA if required
4. Try publish again

### "dist/ directory missing"
**Problem**: Published package is empty.

**Solution**:
1. Run: `npm run build`
2. Verify `dist/` exists: `ls -la dist/`
3. Update `files` in package.json
4. Try pack again: `npm pack --dry-run`

### "Tests fail in CI"
**Problem**: Tests pass locally but fail on npm CI.

**Solution**:
1. Check Node.js version requirement
2. Install dependencies fresh: `rm -rf node_modules && npm install`
3. Run tests: `npm test`
4. Check for OS-specific issues (Windows/Mac/Linux)

## Documentation Checklist

### README.md Structure
- [ ] Title and description
- [ ] Features list
- [ ] Installation instructions
- [ ] Configuration guide
- [ ] Usage examples
- [ ] API reference
- [ ] Testing instructions
- [ ] Troubleshooting section
- [ ] License and version

### Code Examples
- [ ] Examples are working code (not pseudocode)
- [ ] Examples don't use hardcoded credentials
- [ ] Examples show common use cases
- [ ] Examples include error handling

## Security Checklist

- [ ] No credentials in version control
- [ ] No credentials in compiled output
- [ ] `.env*` files are gitignored
- [ ] No hardcoded API keys, tokens, or secrets
- [ ] Error messages don't leak sensitive info
- [ ] Dependencies are from trusted sources
- [ ] No known vulnerabilities: `npm audit`

## Final Review

Before hitting publish:

1. **Am I ready?**
   - Tests pass? ✓
   - Docs complete? ✓
   - No credentials? ✓

2. **Is my package correct?**
   - Name is unique? ✓
   - Version is correct? ✓
   - Files are included? ✓

3. **Did I test?**
   - Local tests? ✓
   - Package contents? ✓
   - Installation? ✓

4. **Am I prepared for support?**
   - GitHub issues enabled? ✓
   - README is clear? ✓
   - Examples work? ✓

## After Publishing

### Immediate (Day 1)
- [ ] Announce release
- [ ] Monitor for initial feedback
- [ ] Fix any critical issues found

### Short Term (Week 1)
- [ ] Respond to issues
- [ ] Gather community feedback
- [ ] Plan next version

### Ongoing
- [ ] Keep dependencies updated
- [ ] Monitor npm security alerts
- [ ] Engage with community
- [ ] Plan improvements

---

**Ready to publish? Good luck! 🚀**

Questions? See [Publishing Guide in Docs](./PLUGIN_DOCUMENTATION_STANDARDS.md#publishing-documentation)
