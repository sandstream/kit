import { spawn } from "node:child_process";
import { platform } from "node:os";
import { isNonInteractive } from "./environment.js";

export interface ServiceDashboard {
  name: string;
  label: string;
  docUrl: string;
  dashboardUrl: (env: Record<string, string>) => string | null;
}

/** Known service dashboard mappings */
const SERVICES: ServiceDashboard[] = [
  {
    name: "stripe",
    label: "Stripe Dashboard",
    docUrl: "https://stripe.com/docs",
    dashboardUrl: () => "https://dashboard.stripe.com",
  },
  {
    name: "supabase",
    label: "Supabase Studio",
    docUrl: "https://supabase.com/docs",
    dashboardUrl: (env) => {
      const ref = env.SUPABASE_PROJECT_REF;
      return ref ? `https://supabase.com/dashboard/project/${ref}` : "https://supabase.com/dashboard";
    },
  },
  {
    name: "vercel",
    label: "Vercel Dashboard",
    docUrl: "https://vercel.com/docs",
    dashboardUrl: () => "https://vercel.com/dashboard",
  },
  {
    name: "railway",
    label: "Railway Dashboard",
    docUrl: "https://docs.railway.app",
    dashboardUrl: () => "https://railway.app/dashboard",
  },
  {
    name: "sentry",
    label: "Sentry Dashboard",
    docUrl: "https://docs.sentry.io",
    dashboardUrl: () => "https://sentry.io",
  },
  {
    name: "posthog",
    label: "PostHog Dashboard",
    docUrl: "https://posthog.com/docs",
    dashboardUrl: () => "https://app.posthog.com",
  },
  {
    name: "neon",
    label: "Neon Postgres Console",
    docUrl: "https://neon.tech/docs",
    dashboardUrl: () => "https://console.neon.tech",
  },
  {
    name: "github",
    label: "GitHub",
    docUrl: "https://docs.github.com",
    dashboardUrl: () => "https://github.com",
  },
  {
    name: "aws",
    label: "AWS Console",
    docUrl: "https://docs.aws.amazon.com",
    dashboardUrl: () => "https://console.aws.amazon.com",
  },
  {
    name: "gcp",
    label: "Google Cloud Console",
    docUrl: "https://cloud.google.com/docs",
    dashboardUrl: () => "https://console.cloud.google.com",
  },
  {
    name: "azure",
    label: "Azure Portal",
    docUrl: "https://docs.microsoft.com/azure",
    dashboardUrl: () => "https://portal.azure.com",
  },
  {
    name: "docs",
    label: "kit Documentation",
    docUrl: "https://github.com/sandstream/kit",
    dashboardUrl: () => "https://github.com/sandstream/kit",
  },
];

export function listServices(): ServiceDashboard[] {
  return SERVICES;
}

export function findService(name: string): ServiceDashboard | undefined {
  return SERVICES.find((s) => s.name.toLowerCase() === name.toLowerCase());
}

/**
 * Get the dashboard URL for a service.
 * Returns null if no URL is available.
 */
export function getServiceUrl(name: string, env: Record<string, string>): string | null {
  const service = findService(name);
  if (!service) return null;
  return service.dashboardUrl(env);
}

/**
 * Open a URL in the default browser.
 * Falls back to printing the URL if opening fails.
 */
export async function openInBrowser(url: string): Promise<{ success: boolean; message: string }> {
  // Never spawn a browser in automation/CI/tests — print the URL instead. This
  // mirrors login.ts's runInteractive guard and keeps `npm test` hermetic
  // (no service's dashboard, e.g. Stripe's, pops a window during the suite).
  if (isNonInteractive()) {
    return { success: true, message: `Non-interactive — visit: ${url}` };
  }

  // Determine the open command based on platform
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";

  return new Promise((resolve) => {
    const child = spawn(cmd, [url], { stdio: "pipe" });

    // Set a timeout to consider it successful if no error within 100ms
    const timeout = setTimeout(() => {
      resolve({
        success: true,
        message: `Opened in browser: ${url}`,
      });
    }, 100);

    child.on("error", () => {
      clearTimeout(timeout);
      resolve({
        success: false,
        message: `Could not open in browser. Visit: ${url}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({
          success: true,
          message: `Opened in browser: ${url}`,
        });
      } else {
        resolve({
          success: false,
          message: `Could not open in browser. Visit: ${url}`,
        });
      }
    });
  });
}

/**
 * Open a service dashboard or documentation.
 * If url is "docs", opens documentation instead of dashboard.
 */
export async function openService(
  serviceName: string,
  env: Record<string, string>,
  preferDocs = false
): Promise<{ success: boolean; message: string; url: string }> {
  const service = findService(serviceName);

  if (!service) {
    return {
      success: false,
      message: `Unknown service: ${serviceName}`,
      url: "",
    };
  }

  const urlToOpen = preferDocs ? service.docUrl : getServiceUrl(serviceName, env);

  if (!urlToOpen) {
    return {
      success: false,
      message: `No URL available for ${service.label}`,
      url: "",
    };
  }

  const result = await openInBrowser(urlToOpen);

  return {
    success: result.success,
    message: result.message,
    url: urlToOpen,
  };
}
