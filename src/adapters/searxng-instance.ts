import type { ServiceAdapter, AdapterContext, ProvisionResult } from "./types.js";
import { exec } from "../utils/exec.js";


/**
 * Helper to fetch with timeout using AbortController
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number = 5000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * SearXNG Instance Adapter
 * Sets up a self-hosted SearXNG search instance for agents
 */
export const searxngInstanceAdapter: ServiceAdapter = {
  name: "searxng/instance",
  description: "Self-hosted SearXNG search engine",

  getRequiredTools(): string[] {
    return ["docker"];
  },

  async check(context: AdapterContext): Promise<boolean> {
    try {
      // Check if SearXNG environment variables are configured
      if (context.existingEnv.SEARXNG_URL) {
        // Try to ping the health check endpoint
        try {
          const url = context.existingEnv.SEARXNG_URL;
          const response = await fetchWithTimeout(`${url}/health`);
          return response.ok;
        } catch {
          // URL exists but endpoint unreachable
          return false;
        }
      }

      // Check if SearXNG is running in Docker on localhost:8080
      try {
        const { stdout } = await exec("docker", [
          "ps",
          "--filter",
          "name=searxng",
          "--format",
          "{{.Status}}",
        ], {
          timeout: 10_000,
        });

        if (stdout.includes("Up")) {
          // Try to verify it's responding
          try {
            const response = await fetchWithTimeout("http://localhost:8080/health");
            return response.ok;
          } catch {
            return false;
          }
        }
      } catch {
        // Docker command failed
      }

      return false;
    } catch {
      return false;
    }
  },

  async provision(context: AdapterContext): Promise<ProvisionResult> {
    try {
      // Check if Docker is installed
      try {
        await exec("docker", ["--version"], { timeout: 10_000 });
      } catch {
        return {
          success: false,
          error: "Docker not installed",
          message: "SearXNG requires Docker. Please install Docker and try again.",
        };
      }

      // Check if SearXNG container already exists and is running
      try {
        const { stdout } = await exec("docker", [
          "ps",
          "-a",
          "--filter",
          "name=searxng",
          "--format",
          "{{.Names}}",
        ], {
          timeout: 10_000,
        });

        if (stdout.includes("searxng")) {
          // Container exists, check if it's running
          const { stdout: statusOutput } = await exec("docker", [
            "ps",
            "--filter",
            "name=searxng",
            "--format",
            "{{.Status}}",
          ], {
            timeout: 10_000,
          });

          if (statusOutput.includes("Up")) {
            // Already running, verify it's healthy
            try {
              const response = await fetchWithTimeout("http://localhost:8080/health");
              if (response.ok) {
                return {
                  success: true,
                  message: "SearXNG is already running",
                  secrets: {
                    SEARXNG_URL: "http://localhost:8080",
                  },
                  config: {
                    service: "searxng/instance",
                    container: "searxng",
                    port: 8080,
                  },
                };
              }
            } catch {
              // Container is running but not responding, will restart below
            }
          }

          // Container exists but not running, start it
          try {
            await exec("docker", ["start", "searxng"], {
              timeout: 30_000,
            });

            // Wait a bit for container to start
            await new Promise((resolve) => setTimeout(resolve, 2000));

            // Verify it's responding
            try {
              const response = await fetchWithTimeout("http://localhost:8080/health");
              if (response.ok) {
                return {
                  success: true,
                  message: "SearXNG container started successfully",
                  secrets: {
                    SEARXNG_URL: "http://localhost:8080",
                  },
                  config: {
                    service: "searxng/instance",
                    container: "searxng",
                    port: 8080,
                  },
                };
              }
            } catch (e) {
              return {
                success: false,
                error: "SearXNG container started but health check failed",
                message: "Container is running but not responding to health checks",
              };
            }
          } catch (e) {
            return {
              success: false,
              error: e instanceof Error ? e.message : "Failed to start container",
              message: "Could not start existing SearXNG container",
            };
          }
        }
      } catch {
        // Container doesn't exist, continue to creation
      }

      // Create and start SearXNG container
      try {
        await exec("docker", [
          "run",
          "-d",
          "--name",
          "searxng",
          "-p",
          "8080:8080",
          "-e",
          "SEARXNG_PORT=8080",
          "searxng/searxng:latest",
        ], {
          timeout: 120_000, // 2 minutes for image pull and container creation
        });

        // Wait for container to be healthy
        let attempts = 0;
        const maxAttempts = 30;
        while (attempts < maxAttempts) {
          try {
            const response = await fetchWithTimeout("http://localhost:8080/health");
            if (response.ok) {
              return {
                success: true,
                message: "SearXNG container created and started successfully",
                secrets: {
                  SEARXNG_URL: "http://localhost:8080",
                },
                config: {
                  service: "searxng/instance",
                  container: "searxng",
                  port: 8080,
                },
              };
            }
          } catch {
            // Not ready yet, wait and retry
            await new Promise((resolve) => setTimeout(resolve, 1000));
            attempts++;
          }
        }

        return {
          success: false,
          error: "SearXNG container started but health check failed after timeout",
          message: "Container started but did not become healthy within timeout period",
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          message: "Failed to create and start SearXNG container",
        };
      }
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        message: "Failed to provision SearXNG instance",
      };
    }
  },
};
