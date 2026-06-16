import type { WebSearchConfig } from "./config.js";

/**
 * Helper to fetch with timeout using AbortController
 */
async function fetchWithTimeout(
  url: string,
  init?: RequestInit & { timeout?: number },
): Promise<Response> {
  const { timeout: timeoutMs = 5000, ...fetchInit } = init || {};
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...fetchInit, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface WebSearchStatus {
  provider: string;
  configured: boolean;
  healthy: boolean;
  url?: string;
  error?: string;
}

/**
 * Check the status of a web search provider
 */
export async function checkWebSearch(config?: WebSearchConfig): Promise<WebSearchStatus> {
  if (!config || !config.provider) {
    return {
      provider: "none",
      configured: false,
      healthy: false,
      error: "No web search provider configured",
    };
  }

  const provider = config.provider;
  const url = config.url;

  // Check provider-specific requirements
  switch (provider) {
    case "searxng":
      if (!url) {
        return {
          provider,
          configured: false,
          healthy: false,
          error: "SearXNG URL not configured (web.search.url required)",
        };
      }

      try {
        // SearXNG doesn't have a /health endpoint, so check the root
        const response = await fetchWithTimeout(url);
        if (response.ok) {
          return {
            provider,
            configured: true,
            healthy: true,
            url,
          };
        }
        return {
          provider,
          configured: true,
          healthy: false,
          url,
          error: `Server returned status ${response.status}`,
        };
      } catch (err) {
        return {
          provider,
          configured: true,
          healthy: false,
          url,
          error: err instanceof Error ? err.message : "Server unreachable",
        };
      }

    case "brave":
      if (!config.apiKey) {
        return {
          provider,
          configured: false,
          healthy: false,
          error: "Brave Search API key not configured (web.search.apiKey required)",
        };
      }

      try {
        // Test Brave Search API
        const response = await fetchWithTimeout(
          "https://api.search.brave.com/res/v1/web/search?q=test",
          {
            headers: {
              "Accept": "application/json",
              "X-Subscription-Token": config.apiKey,
            },
          } as RequestInit,
        );

        if (response.ok) {
          return {
            provider,
            configured: true,
            healthy: true,
          };
        }
        if (response.status === 401 || response.status === 403) {
          return {
            provider,
            configured: true,
            healthy: false,
            error: "Invalid Brave Search API key (authentication failed)",
          };
        }
        return {
          provider,
          configured: true,
          healthy: false,
          error: `API returned status ${response.status}`,
        };
      } catch (err) {
        return {
          provider,
          configured: true,
          healthy: false,
          error: err instanceof Error ? err.message : "API check failed",
        };
      }

    case "google":
      if (!config.apiKey || !config.cx) {
        return {
          provider,
          configured: false,
          healthy: false,
          error: "Google Custom Search needs web.search.apiKey + web.search.cx (Programmable Search engine id)",
        };
      }
      try {
        // Custom Search JSON API — key + cx are query params by design.
        const response = await fetchWithTimeout(
          `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(config.apiKey)}&cx=${encodeURIComponent(config.cx)}&q=test&num=1`,
        );
        if (response.ok) {
          return { provider, configured: true, healthy: true };
        }
        if (response.status === 400 || response.status === 401 || response.status === 403) {
          return {
            provider,
            configured: true,
            healthy: false,
            error: "Invalid Google API key or cx (request rejected)",
          };
        }
        return {
          provider,
          configured: true,
          healthy: false,
          error: `API returned status ${response.status}`,
        };
      } catch (err) {
        return {
          provider,
          configured: true,
          healthy: false,
          error: err instanceof Error ? err.message : "API check failed",
        };
      }

    case "custom":
      if (!url) {
        return {
          provider,
          configured: false,
          healthy: false,
          error: "Custom search URL not configured (web.search.url required)",
        };
      }

      try {
        const response = await fetchWithTimeout(url);
        if (response.ok || response.status === 404) {
          // 404 is OK for custom URLs that might not have a health endpoint
          return {
            provider,
            configured: true,
            healthy: true,
            url,
          };
        }
        return {
          provider,
          configured: true,
          healthy: false,
          url,
          error: `URL returned status ${response.status}`,
        };
      } catch (err) {
        return {
          provider,
          configured: true,
          healthy: false,
          url,
          error: err instanceof Error ? err.message : "URL check failed",
        };
      }

    default:
      return {
        provider,
        configured: false,
        healthy: false,
        error: `Unknown provider: ${provider}`,
      };
  }
}
