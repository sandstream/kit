# kit Plugin Example: Stripe Payments

> Stripe payment processing adapter for kit

## Overview

This is an example plugin showing best-practice documentation for kit adapters. It implements the `ServiceAdapter` interface to automatically provision Stripe payment processing in development and production environments.

Stripe enables:
- Payment processing and billing
- Subscription management  
- PCI compliance
- Webhook handling
- Multi-currency support

**When to use:** Any application that needs to accept payments or manage subscriptions.

**Not suitable for:** Internal-only applications or those using different payment providers.

## Quick Start

```bash
# Discover and install the plugin
kit plugin search stripe
kit plugin info stripe/payments
kit plugin install stripe/payments
```

### Minimal Setup

```typescript
import { stripeAdapter } from "@kit/plugins/stripe";

const result = await stripeAdapter.provision({
  projectPath: process.cwd(),
  existingEnv: process.env,
});

if (result.success) {
  console.log("Stripe ready! API Key:", result.secrets.STRIPE_SECRET_KEY);
}
```

## Features

- **Easy Setup**: One command to configure Stripe API keys
- **Production Ready**: Supports both test and live keys
- **Webhook Support**: Automatic webhook secret configuration
- **Key Reuse**: Doesn't re-request if already configured
- **Multi-Key**: Configure publishable and secret keys separately
- **Type Safe**: Full TypeScript support

## Installation

### Via kit CLI

```bash
kit plugin install stripe/payments
```

### Via npm

```bash
npm install @kit/plugins/stripe
```

### Manual Setup

1. Create `src/adapters/stripe.ts`:
```typescript
import type { ServiceAdapter } from "sandstream-kit-adapter-sdk";

export const stripeAdapter: ServiceAdapter = {
  name: "stripe/payments",
  description: "Stripe payment processing",
  getRequiredTools: () => [],
  async check(ctx) {
    return !!ctx.existingEnv["STRIPE_SECRET_KEY"];
  },
  async provision(ctx) {
    const key = ctx.existingEnv["STRIPE_SECRET_KEY"];
    if (key) {
      return {
        success: true,
        message: "Stripe already configured",
        secrets: { STRIPE_SECRET_KEY: key },
      };
    }
    return {
      success: false,
      error: "missing_key",
      message: `Set up Stripe:\n1. Visit https://dashboard.stripe.com/apikeys\n2. Copy Secret Key\n3. Set: STRIPE_SECRET_KEY=sk_live_...`,
    };
  },
};
```

2. Register in `.kit.toml`:
```toml
[adapters]
payments = "stripe/payments"
```

## Configuration

### Required Environment Variables

| Variable | Description | Where to Find |
|----------|-------------|---------------|
| `STRIPE_SECRET_KEY` | Secret API key | https://dashboard.stripe.com/apikeys |
| `STRIPE_PUBLISHABLE_KEY` | Publishable API key | https://dashboard.stripe.com/apikeys |

### Optional Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret | (none) |
| `STRIPE_API_VERSION` | API version | Latest |
| `STRIPE_MAX_RETRIES` | Retry attempts | 3 |

### Setup Instructions

#### For Development (Test Keys)

1. Go to [Stripe Dashboard](https://dashboard.stripe.com)
2. Create a free account or sign in
3. Go to Settings → API Keys
4. Copy the **Test Secret Key** (starts with `sk_test_`)
5. Add to `.env.local`:
   ```
   STRIPE_SECRET_KEY=sk_test_YOUR_KEY_HERE
   STRIPE_PUBLISHABLE_KEY=pk_test_YOUR_KEY_HERE
   ```
6. Set up webhooks (optional):
   - Go to Webhooks section
   - Add endpoint: `https://localhost:3000/api/webhooks/stripe`
   - Select events: `payment_intent.succeeded`, `payment_intent.payment_failed`
   - Copy signing secret to `STRIPE_WEBHOOK_SECRET`

#### For Production (Live Keys)

Same as above, but use **Live Keys** (start with `sk_live_` and `pk_live_`).

**IMPORTANT:** Never commit live keys to version control!

## Usage Examples

### Basic Payment Processing

```typescript
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// Create a payment intent
const paymentIntent = await stripe.paymentIntents.create({
  amount: 2000, // $20.00 in cents
  currency: "usd",
  payment_method_types: ["card"],
});

console.log("Payment Intent:", paymentIntent.id);
console.log("Client Secret:", paymentIntent.client_secret);
```

### Handling Webhooks

```typescript
import { Request, Response } from "express";

export async function handleStripeWebhook(req: Request, res: Response) {
  const sig = req.headers["stripe-signature"] as string;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      webhookSecret
    );

    switch (event.type) {
      case "payment_intent.succeeded":
        console.log("Payment succeeded:", event.data.object);
        // Handle successful payment
        break;
      case "payment_intent.payment_failed":
        console.log("Payment failed:", event.data.object);
        // Handle failed payment
        break;
    }

    res.json({ received: true });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(400).send(`Webhook error: ${error.message}`);
  }
}
```

### Subscription Management

```typescript
// Create a subscription
const subscription = await stripe.subscriptions.create({
  customer: customerId,
  items: [{ price: "price_YOUR_PRICE_ID" }],
  payment_behavior: "default_incomplete",
  expand: ["latest_invoice.payment_intent"],
});

// List customer subscriptions
const subscriptions = await stripe.subscriptions.list({
  customer: customerId,
});

// Cancel subscription
await stripe.subscriptions.del(subscriptionId);
```

See [docs/EXAMPLES.md](../PLUGIN_DOCUMENTATION_STANDARDS.md#4-docsexamplesmd) for more examples.

## API Reference

### stripeAdapter.name
- **Type:** string
- **Value:** `"stripe/payments"`
- **Purpose:** Unique identifier in the plugin registry

### stripeAdapter.check(context)

Verifies if Stripe is already configured.

**Parameters:**
- `context.existingEnv.STRIPE_SECRET_KEY` - Required secret key

**Returns:**
- `true` if STRIPE_SECRET_KEY is set
- `false` otherwise

**Example:**
```typescript
const isConfigured = await stripeAdapter.check({
  projectPath: "/app",
  existingEnv: process.env,
});
console.log(isConfigured); // true if API key is set
```

### stripeAdapter.provision(context)

Configures Stripe credentials.

**Parameters:**
- `context.existingEnv` - Environment variables including STRIPE_SECRET_KEY

**Returns:** `ProvisionResult` with:
- `success: true` if STRIPE_SECRET_KEY is present
- `secrets.STRIPE_SECRET_KEY` - The configured API key
- Error message with setup instructions if missing

**Example:**
```typescript
const result = await stripeAdapter.provision({
  projectPath: "/app",
  existingEnv: process.env,
});

if (result.success) {
  console.log("Configured:", result.secrets.STRIPE_SECRET_KEY);
} else {
  console.error("Setup needed:", result.message);
}
```

### stripeAdapter.getRequiredTools()

Returns required CLI tools.

**Returns:** `[]` (empty array - Stripe is API-based)

For more details, see [docs/API.md](../PLUGIN_DOCUMENTATION_STANDARDS.md#2-docsapimmd).

## Testing

### Running Tests

```bash
npm test
```

Expected output:
```
# tests 8
# pass 8
# fail 0
```

### Test Examples

```typescript
import assert from "node:assert/strict";
import { stripeAdapter } from "./stripe.js";

describe("Stripe Adapter", () => {
  it("check returns false when API key missing", async () => {
    const result = await stripeAdapter.check({
      projectPath: "/tmp",
      existingEnv: {},
    });
    assert.equal(result, false);
  });

  it("check returns true when API key present", async () => {
    const result = await stripeAdapter.check({
      projectPath: "/tmp",
      existingEnv: { STRIPE_SECRET_KEY: "sk_test_123" },
    });
    assert.equal(result, true);
  });

  it("provision returns error with setup instructions", async () => {
    const result = await stripeAdapter.provision({
      projectPath: "/tmp",
      existingEnv: {},
    });
    assert.equal(result.success, false);
    assert.match(result.message, /dashboard\.stripe\.com/i);
  });

  it("provision returns key when already configured", async () => {
    const result = await stripeAdapter.provision({
      projectPath: "/tmp",
      existingEnv: { STRIPE_SECRET_KEY: "sk_test_abc" },
    });
    assert.equal(result.success, true);
    assert.equal(result.secrets.STRIPE_SECRET_KEY, "sk_test_abc");
  });
});
```

For testing guidelines, see [docs/TESTING.md](../PLUGIN_DOCUMENTATION_STANDARDS.md#5-docstestingmd).

## Troubleshooting

### "API Key not provided" Error

**Problem:** Getting "Could not find API key" error when running code.

**Solution:**
1. Check `.env.local` has `STRIPE_SECRET_KEY=sk_...`
2. Verify you're using the **secret key**, not publishable key
3. Ensure the key is for the correct environment (test vs. live)
4. Restart your development server

### "Invalid API Key" Error

**Problem:** "Invalid API Key provided" error.

**Solution:**
1. Verify the key hasn't been rotated in the Stripe dashboard
2. Try regenerating the API key in Settings → API Keys
3. Copy the entire key without extra spaces
4. Check you're using a valid test key format: `sk_test_...`

### Webhooks Not Triggering

**Problem:** Webhooks aren't received by your endpoint.

**Solution:**
1. Verify `STRIPE_WEBHOOK_SECRET` is set correctly
2. Check endpoint URL is publicly accessible (ngrok for local dev)
3. Verify events are enabled for your endpoint in Stripe dashboard
4. Check server logs for webhook delivery errors

### "Unauthorized" on API Calls

**Problem:** 401 error when making Stripe API calls.

**Solution:**
1. Confirm API key is from the same Stripe account you're testing against
2. Check the key hasn't been revoked
3. Use test keys for development, live keys for production
4. If using Node.js library, verify you've initialized with the key

For more troubleshooting, see [docs/TROUBLESHOOTING.md](../PLUGIN_DOCUMENTATION_STANDARDS.md#troubleshooting).

## Support

- **GitHub Issues:** [kit-stripe/issues](https://github.com/kit-community/kit-stripe/issues)
- **Stripe Docs:** [stripe.com/docs](https://stripe.com/docs)
- **kit Guide:** [Plugin Development Guide](../PLUGIN_DEVELOPMENT.md)
- **Patterns:** [Advanced Patterns](../ADAPTER_PATTERNS.md)

## Version History

See [CHANGELOG.md](./CHANGELOG.md) for version history and breaking changes.

Current version: **1.0.0**

### Recent Updates

- 1.0.0: Initial release with full Stripe API support
- Earlier versions: See CHANGELOG.md

## License

MIT - See LICENSE file for details

## Contributing

Contributions welcome! See CONTRIBUTING.md for guidelines.

---

**Last Updated:** 2026-04-15  
**Maintainer:** Stripe Community  
**Registry:** [@kit/plugins/stripe](https://github.com/sandstream/kit
