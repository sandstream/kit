/**
 * Service provisioning adapters registry
 */

import type { AdapterRegistry } from "./types.js";
import { stripePaymentsAdapter } from "./stripe-payments.js";
import { supabaseDbAdapter } from "./supabase-db.js";
import { vercelHostingAdapter } from "./vercel-hosting.js";
import { expoEasAdapter } from "./expo-eas.js";
import { neonDbAdapter } from "./neon-db.js";
import { clerkAuthAdapter } from "./clerk-auth.js";
import { upstashRedisAdapter } from "./upstash-redis.js";
import { cloudflareR2Adapter } from "./cloudflare-r2.js";
import { resendEmailAdapter } from "./resend-email.js";
import { planetscaleDbAdapter } from "./planetscale-db.js";
import { loopsEmailAdapter } from "./loops-email.js";
import { liveblocksRealtimeAdapter } from "./liveblocks-realtime.js";
import { triggerBackgroundAdapter } from "./trigger-background.js";
import { inngestBackgroundAdapter } from "./inngest-background.js";
import { flagsmithFlagsAdapter } from "./flagsmith-flags.js";
import { sentryMonitoringAdapter } from "./sentry-monitoring.js";
import { tinybirdAnalyticsAdapter } from "./tinybird-analytics.js";
import { posthogAnalyticsAdapter } from "./posthog-analytics.js";
import { railwayHostingAdapter } from "./railway-hosting.js";
import { flyioHostingAdapter } from "./flyio-hosting.js";

export const adapters: AdapterRegistry = {
  "stripe/payments": stripePaymentsAdapter,
  "supabase/db": supabaseDbAdapter,
  "vercel/hosting": vercelHostingAdapter,
  "expo/eas": expoEasAdapter,
  "neon/db": neonDbAdapter,
  "clerk/auth": clerkAuthAdapter,
  "upstash/redis": upstashRedisAdapter,
  "cloudflare/r2": cloudflareR2Adapter,
  "resend/email": resendEmailAdapter,
  "planetscale/db": planetscaleDbAdapter,
  "loops/email": loopsEmailAdapter,
  "liveblocks/realtime": liveblocksRealtimeAdapter,
  "trigger/background": triggerBackgroundAdapter,
  "inngest/background": inngestBackgroundAdapter,
  "flagsmith/flags": flagsmithFlagsAdapter,
  "sentry/monitoring": sentryMonitoringAdapter,
  "tinybird/analytics": tinybirdAnalyticsAdapter,
  "posthog/analytics": posthogAnalyticsAdapter,
  "railway/hosting": railwayHostingAdapter,
  "flyio/hosting": flyioHostingAdapter,
};

export { type ServiceAdapter, type ProvisionResult, type AdapterContext } from "./types.js";
