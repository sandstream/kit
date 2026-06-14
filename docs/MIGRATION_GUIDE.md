# Migration Guide: Legacy to kit

This guide helps you migrate from manual environment setup and legacy tooling to the kit ecosystem.

## What Is kit Migration?

**Before kit:**
```bash
# Manual setup (error-prone, time-consuming)
1. Create .env file manually
2. Install tools via homebrew/apt/npm
3. Configure each service separately
4. Document setup in README
5. Onboard team members repeatedly
6. Fix environment issues ad-hoc
```

**With kit:**
```bash
# Automated setup (reliable, reproducible)
kit setup
# Everything configured automatically!
```

## Migration Checklist

### Phase 1: Assessment (1-2 hours)

- [ ] Document current setup process
- [ ] List all tools and versions
- [ ] Identify all services (databases, APIs, auth)
- [ ] Record environment variables
- [ ] Note any custom scripts

### Phase 2: Preparation (2-4 hours)

- [ ] Install kit CLI
- [ ] Create `.kit.toml` configuration
- [ ] Identify kit adapters for your services
- [ ] Prepare migration plan
- [ ] Set up test environment

### Phase 3: Migration (2-8 hours)

- [ ] Run `kit init` to initialize
- [ ] Configure each service via adapters
- [ ] Run `kit setup` to verify
- [ ] Update documentation
- [ ] Test with clean environment

### Phase 4: Adoption (ongoing)

- [ ] Onboard team members
- [ ] Update CI/CD pipelines
- [ ] Monitor for issues
- [ ] Refine configuration

## Step-by-Step Migration

### Step 1: Assessment

Document your current setup:

```bash
# What tools do you use?
which node npm python ruby java
npm list -g --depth=0

# What environment variables?
grep -h "^[A-Z]" .env .env.local

# What services?
echo "Database: PostgreSQL 14"
echo "Cache: Redis 7"
echo "Auth: Clerk"
```

### Step 2: Install kit

```bash
# Install
npm install -g sandstream-kit

# Or via npm
npm install -g kit

# Verify
kit --version
```

### Step 3: Create .kit.toml

```bash
# Auto-detect your stack
kit init

# This creates .kit.toml with:
# - Detected tools and versions
# - Suggested services
# - Ready-to-customize configuration

# Review and edit
vim .kit.toml
```

### Step 4: Configure Services

```bash
# List available adapters
kit plugin list

# Add each service
kit add stripe/payments
kit add supabase/database
kit add vercel/hosting

# Or manually edit .kit.toml
# [adapters]
# payments = "stripe/payments"
# database = "supabase/database"
```

### Step 5: Run Setup

```bash
# Perform full setup
kit setup

# This:
# 1. Installs tools via mise
# 2. Verifies versions
# 3. Runs service provisioning
# 4. Generates .env.local
# 5. Runs project setup (migrations, seeds)

# Watch output for any issues
```

### Step 6: Verify

```bash
# Check everything is working
kit check

# Start development
npm run dev

# Test services
# - Database: Test queries
# - API Keys: Verify working
# - Webhooks: Verify configured
```

### Step 7: Update Documentation

Update your README:

```markdown
## Setup

Install kit, then:

\`\`\`bash
git clone <repo>
cd project
kit setup
npm run dev
\`\`\`

Previously required 10 manual steps. kit handles it automatically!
```

## Migration Patterns

### Pattern 1: Gradual Service Migration

Don't migrate all services at once. Migrate incrementally:

```bash
# Week 1: Migrate database
kit add supabase/database

# Week 2: Migrate auth
kit add clerk/auth

# Week 3: Migrate payments
kit add stripe/payments

# Week 4: Migrate analytics
kit add posthog/analytics
```

Benefits:
- Lower risk (easier to debug issues)
- Team can learn gradually
- Easier to rollback if needed

### Pattern 2: Parallel Setup (New/Old)

Run both systems in parallel:

```bash
# .kit.toml (new way)
[adapters]
database = "supabase/database"

# .env.local-legacy (old way)
DATABASE_URL=postgresql://...

# App can read both until migration complete
```

### Pattern 3: Team Onboarding During Migration

As you migrate, new team members use kit immediately:

```bash
# Old onboarding (2-3 hours per person)
1. Clone repo
2. Install Node 18.x
3. Install PostgreSQL
4. Install Redis
5. Create databases
6. Load schema
7. Configure .env
8. Run migrations

# New onboarding (2 minutes)
git clone <repo>
kit setup
npm run dev
```

## Common Migration Issues

### Issue: "Tool X not in mise registry"

**Problem:** A tool you use isn't available through mise.

**Solution:**
1. Check [mise registry](https://mise.jdx.dev/)
2. Contribute the tool to mise
3. Temporarily use manual installation
4. Switch to kit once available

```bash
# Workaround in .kit.toml
[tools]
custom_tool = "1.0.0"  # Still installed manually
```

### Issue: "Adapter not available for service Y"

**Problem:** kit doesn't have an adapter for your service.

**Solution:**
1. Create your own adapter: `kit plugin scaffold my-service`
2. Implement the adapter for your service
3. Publish to npm: `npm publish`
4. Use your custom adapter: `kit add my-service`

See [Plugin Development Guide](./PLUGIN_DEVELOPMENT.md)

### Issue: "Environment variables in wrong format"

**Problem:** Your .env uses different format than kit expects.

**Solution:** kit supports multiple formats:

```bash
# Standard .env (supported)
DATABASE_URL=postgresql://...

# Export syntax (supported)
export API_KEY=sk_...

# Comments (supported)
# This is a comment
SERVICE_KEY=value

# JSON (not supported - convert first)
{ "key": "value" }  # Convert to SERVICE_KEY=value
```

### Issue: "CI/CD doesn't work with kit"

**Problem:** Your CI pipeline breaks with kit setup.

**Solution:**
1. Update CI configuration to use `kit setup`
2. Example GitHub Actions:

```yaml
# .github/workflows/test.yml
- name: Setup environment
  run: kit setup

- name: Run tests
  run: npm test
```

3. Example Docker:

```dockerfile
# Dockerfile
RUN npm install -g sandstream-kit
RUN kit setup
```

## Migration Troubleshooting

### Debugging Setup Issues

```bash
# See detailed setup logs
kit setup --verbose

# Check specific service
kit add database/supabase --check

# Verify environment
kit check

# See what would be installed
kit install --dry-run
```

### Rolling Back Migration

If migration fails:

```bash
# Keep old .env as backup
cp .env.local .env.local-backup

# Use old setup temporarily
source .env.local-backup

# Fix kit configuration
vim .kit.toml

# Try setup again
kit setup
```

## Success Metrics

After migration, you should see:

✅ **Faster Onboarding**
- Before: 2-3 hours per team member
- After: <5 minutes with `kit setup`

✅ **Fewer Environment Issues**
- Before: "Works on my machine" problems
- After: Consistent environment for all

✅ **Easier Debugging**
- Before: "What version did they have?"
- After: `kit check` shows everything

✅ **Faster Releases**
- Before: Manual verification before release
- After: `kit check` catches issues automatically

✅ **Better Documentation**
- Before: Manual setup README (often outdated)
- After: Automated `.kit.toml` is the documentation

## Migration Timeline

### Small Project (1-2 people)
- **Total time:** 4-6 hours
- **Effort:** 1 person
- **Risk:** Low (easy to rollback)

### Medium Project (5-10 people)
- **Total time:** 2-3 days
- **Effort:** 1-2 people
- **Risk:** Low-medium (test with subset first)

### Large Project (10+ people)
- **Total time:** 1-2 weeks
- **Effort:** 2-3 people
- **Risk:** Medium (staged rollout recommended)

## Post-Migration

### Week 1
- [ ] Monitor for issues
- [ ] Gather team feedback
- [ ] Fix any configuration issues
- [ ] Document learnings

### Month 1
- [ ] Onboard any remaining team members
- [ ] Optimize configuration
- [ ] Consider additional adapters
- [ ] Plan advanced kit usage

### Ongoing
- [ ] Update dependencies via kit
- [ ] Add new services as needed
- [ ] Improve documentation
- [ ] Share learnings with community

## Getting Help

- [kit Documentation](./GETTING_STARTED_PLUGINS.md)
- [Troubleshooting Guide](./PLUGIN_DOCUMENTATION_STANDARDS.md#troubleshooting)
- [FAQ](#)
- [GitHub Issues](https://github.com/sandstream/kit/issues)

## Migration Comparison

| Aspect | Before | After |
|--------|--------|-------|
| **Setup Time** | 2-3 hours | <5 minutes |
| **Documentation** | Manual README | Automated .kit.toml |
| **Onboarding** | Per-person manual | One command: `kit setup` |
| **Tool Versions** | Manual tracking | Automatic via .kit.toml |
| **Environment** | Manual .env files | Automated via kit |
| **Services** | Manual configuration | kit adapters |
| **CI/CD** | Complex setup | Single `kit setup` |
| **Debugging** | "What's your setup?" | `kit check` |

---

**Ready to migrate? Start with:**
```bash
kit init
```

**Questions?** See [Getting Started](./GETTING_STARTED_PLUGINS.md) or create an issue.
