# Getting Started with kit Plugins

Welcome to the kit plugin ecosystem! This guide helps you discover, create, and publish plugins.

## Quick Links

- **Discover Plugins**: `kit plugin list`
- **Create a Plugin**: `kit plugin scaffold my-plugin`
- **Plugin Guide**: [Plugin Development Guide](./PLUGIN_DEVELOPMENT.md)
- **Documentation Standards**: [Documentation Standards](./PLUGIN_DOCUMENTATION_STANDARDS.md)
- **Advanced Patterns**: [Advanced Patterns](./ADAPTER_PATTERNS.md)

## 5-Minute Plugin Tour

### 1. Discover Available Plugins

```bash
# List all plugins
kit plugin list

# Search for a plugin
kit plugin search stripe

# View plugin details
kit plugin info stripe/payments

# Browse by category
kit plugin list --tag database
```

### 2. Install a Plugin

```bash
# Install a plugin
kit plugin install stripe/payments

# You'll see setup instructions
# FOLLOW THE PROMPTS to configure the service
```

### 3. Create Your Own Plugin

```bash
# Scaffold a new plugin package
kit plugin scaffold my-first-adapter

# Navigate to the plugin
cd kit-plugin-my-first-adapter

# Build and test
npm run build
npm test

# Edit your adapter
vim src/my-first-adapter.ts
```

### 4. Test Your Plugin

```bash
# Ensure all tests pass
npm test

# Expected output:
# # tests 5
# # pass 5
# # fail 0
```

### 5. Publish

```bash
# Update version
npm version patch

# Publish to npm
npm publish

# Register with kit plugin registry
# (See PUBLISHING_CHECKLIST.md)
```

## What Are Plugins?

A **plugin** is a TypeScript package that implements the `ServiceAdapter` interface. It automatically configures external services (payment providers, databases, hosting platforms, etc.) in your project.

### Why Plugins?

✅ **Automation**: One command to configure a service  
✅ **Standardization**: Consistent API across all services  
✅ **Quality**: Tests and documentation included  
✅ **Community**: Reusable by all kit projects  

### Example: Stripe Payments

Instead of manually:
```bash
# Without plugins (manual)
1. Visit https://stripe.com
2. Create account
3. Copy API key
4. Create .env.local
5. Add: STRIPE_SECRET_KEY=sk_...
6. Test the key works
```

With plugins:
```bash
# With plugins (one command)
kit plugin install stripe/payments
```

Done! 🎉

## Plugin Categories

### Payments
- `stripe/payments` - Payment processing
- `paypal/payments` - PayPal integration

### Databases
- `supabase/database` - PostgreSQL + Auth
- `neon/database` - Serverless PostgreSQL
- `planetscale/database` - MySQL serverless

### Hosting
- `vercel/hosting` - Serverless deployment
- `railway/hosting` - Full-stack deployment
- `flyio/hosting` - Container deployment

### Analytics
- `posthog/analytics` - Product analytics
- `sentry/monitoring` - Error tracking
- `tinybird/analytics` - Real-time analytics

### Email
- `resend/email` - Transactional email
- `loops/email` - Email marketing

### Authentication
- `clerk/auth` - User authentication
- `supabase/auth` - Built into Supabase

## Common Workflows

### I Want to Add a Service to My Project

```bash
# 1. Search for plugins
kit plugin search service-name

# 2. View details
kit plugin info provider/service

# 3. Install
kit plugin install provider/service

# 4. Follow setup instructions
# (Plugin will show required environment variables)

# 5. Verify it works
npm run dev
```

### I'm Building a New Service Library

```bash
# 1. Create plugin scaffold
kit plugin scaffold my-service

# 2. Implement the adapter
vim src/my-service.ts

# 3. Create comprehensive tests
vim src/my-service.test.ts

# 4. Write documentation
vim README.md

# 5. Test thoroughly
npm test

# 6. Publish and register
npm publish
# Submit PR to register in kit
```

### I Want to Contribute to kit

kit welcomes plugin contributions! Here's how:

```bash
# 1. Check out official plugins
cd ~/kit/src/adapters

# 2. See examples
ls -la

# 3. Create your plugin
kit plugin scaffold my-contribution

# 4. Make it excellent
# - Add tests (>90% coverage)
# - Complete documentation
# - Follow standards

# 5. Submit as PR
git checkout -b plugins/my-contribution
git add .
git commit -m "feat: add my-contribution plugin"
git push origin plugins/my-contribution
# Create PR on GitHub
```

## Understanding the Ecosystem

```
┌─────────────────────────────────────┐
│   kit Plugin Ecosystem           │
├─────────────────────────────────────┤
│                                     │
│ ┌───────────────────────────────┐  │
│ │ Plugin Registry (SYMA-100)    │  │
│ │ - Search & Discovery          │  │
│ │ - Metadata & Ratings          │  │
│ │ - CLI Commands                │  │
│ └───────────────────────────────┘  │
│            ↓ ↑                      │
│ ┌───────────────────────────────┐  │
│ │ Plugin Scaffold (SYMA-101)    │  │
│ │ - Generate from template      │  │
│ │ - TypeScript setup            │  │
│ │ - Test framework              │  │
│ └───────────────────────────────┘  │
│            ↓ ↑                      │
│ ┌───────────────────────────────┐  │
│ │ Documentation (SYMA-103)      │  │
│ │ - Standards & Examples        │  │
│ │ - API Reference               │  │
│ │ - Best Practices              │  │
│ └───────────────────────────────┘  │
│            ↓ ↑                      │
│ ┌───────────────────────────────┐  │
│ │ Community Plugins             │  │
│ │ - Discover & Install          │  │
│ │ - Contribute New               │  │
│ │ - Share Patterns              │  │
│ └───────────────────────────────┘  │
│                                     │
└─────────────────────────────────────┘
```

## Learning Path

### Beginner (Use existing plugins)
1. ✅ Learn what plugins are (you're here)
2. ✅ Discover available plugins: `kit plugin list`
3. ✅ Install a plugin: `kit plugin install stripe/payments`
4. ⏳ Try 2-3 different plugins
5. ⏳ Read [Plugin Documentation](./PLUGIN_DOCUMENTATION_STANDARDS.md)

### Intermediate (Create your own)
1. ✅ Understand the ecosystem
2. ✅ Read [Plugin Development Guide](./PLUGIN_DEVELOPMENT.md)
3. ⏳ Create a plugin: `kit plugin scaffold my-plugin`
4. ⏳ Implement ServiceAdapter interface
5. ⏳ Write comprehensive tests
6. ⏳ Document your plugin
7. ⏳ Publish to npm

### Advanced (Advanced patterns)
1. ✅ Master basic plugin creation
2. ✅ Read [Advanced Patterns](./ADAPTER_PATTERNS.md)
3. ⏳ Create composite adapters
4. ⏳ Handle complex provisioning
5. ⏳ Build multi-service adapters
6. ⏳ Contribute to official plugins

## FAQ

### Q: Do I need to know TypeScript?

**A:** Yes, plugins are written in TypeScript. But:
- Scaffolding provides templates
- Official examples are well-documented
- TypeScript is straightforward for adapters

### Q: Can I publish my plugin to npm?

**A:** Yes! Any plugin can be published. Just:
1. Create `package.json` with your plugin info
2. Build and test
3. Run `npm publish`
4. Register with kit registry (optional but recommended)

### Q: What if my service isn't in the registry?

**A:** Create it! Plugins are community-driven:
1. Identify your service need
2. Create a plugin: `kit plugin scaffold service-name`
3. Implement the adapter
4. Test thoroughly
5. Publish to npm
6. Share with the community

### Q: How do I get help?

**A:** Resources available:
- [Plugin Development Guide](./PLUGIN_DEVELOPMENT.md)
- [Documentation Standards](./PLUGIN_DOCUMENTATION_STANDARDS.md)
- [Advanced Patterns](./ADAPTER_PATTERNS.md)
- GitHub Issues on specific plugins
- kit main repository issues

### Q: Can plugins have dependencies?

**A:** Yes. Plugins can depend on:
- npm packages (add to package.json)
- CLI tools (return from `getRequiredTools()`)
- Other kit plugins (document in README)

### Q: How do I handle authentication?

**A:** Store credentials in `.env.local`:
```bash
SERVICE_API_KEY=sk_...
SERVICE_TOKEN=token_...
```

Your adapter reads from `context.existingEnv`. Never hardcode!

### Q: What about testing plugins?

**A:** Use node:test built-in:
```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("My Plugin", () => {
  it("works correctly", async () => {
    // Test here
  });
});
```

## Next Steps

- **Create a Plugin**: `kit plugin scaffold my-plugin`
- **Read the Guide**: [Plugin Development Guide](./PLUGIN_DEVELOPMENT.md)
- **See Examples**: [Advanced Patterns](./ADAPTER_PATTERNS.md)
- **Understand Docs**: [Documentation Standards](./PLUGIN_DOCUMENTATION_STANDARDS.md)

## Community

- **Share Your Plugin**: Publish to npm with `kit-plugin` in keywords
- **Get Feedback**: Create issues on GitHub
- **Learn from Others**: Check out official plugins in `/src/adapters`
- **Contribute**: Submit PRs to the main repo

---

**Happy Building! 🚀**

Questions? Check [FAQ](#faq) or open an issue.
