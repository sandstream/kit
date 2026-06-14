import type { ServiceAdapter, AdapterContext, ProvisionResult } from "./types.js";
import { exec } from "../utils/exec.js";


/**
 * Supabase Database Adapter
 * Sets up Supabase project with database and auth
 */
export const supabaseDbAdapter: ServiceAdapter = {
  name: "supabase/db",
  description: "Supabase database and authentication",
  
  getRequiredTools(): string[] {
    return ["supabase"];
  },
  
  async check(context: AdapterContext): Promise<boolean> {
    try {
      // Check if Supabase URL and keys exist in env
      if (
        context.existingEnv.SUPABASE_URL &&
        context.existingEnv.SUPABASE_ANON_KEY
      ) {
        return true;
      }
      
      // Check if supabase is linked
      const { stdout } = await exec("supabase", ["status"], {
        cwd: context.projectPath,
        timeout: 10_000,
      });
      
      return stdout.includes("API URL") || stdout.includes("supabase_url");
    } catch {
      return false;
    }
  },
  
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    try {
      // Step 1: Check if supabase CLI is installed and authenticated
      try {
        await exec("supabase", ["--version"], {
          timeout: 5_000,
        });
      } catch {
        return {
          success: false,
          error: "Supabase CLI not installed",
          message: "Install Supabase CLI: brew install supabase/tap/supabase",
        };
      }
      
      // Step 2: Check if already initialized
      try {
        await exec("supabase", ["status"], {
          cwd: context.projectPath,
          timeout: 10_000,
        });
        
        // Already initialized, get existing credentials
        const { stdout: statusOutput } = await exec("supabase", ["status", "--output", "json"], {
          cwd: context.projectPath,
          timeout: 10_000,
        });
        
        try {
          const status = JSON.parse(statusOutput);
          
          if (status.API_URL && status.ANON_KEY) {
            return {
              success: true,
              message: "Using existing Supabase project",
              secrets: {
                SUPABASE_URL: status.API_URL,
                SUPABASE_ANON_KEY: status.ANON_KEY,
                SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY || "",
              },
              config: {
                service: "supabase/db",
                existing: true,
              },
            };
          }
        } catch {
          // JSON parse failed, continue with linking
        }
      } catch {
        // Not initialized yet
      }
      
      // Step 3: Initialize Supabase if not already done
      try {
        await exec("supabase", ["init"], {
          cwd: context.projectPath,
          timeout: 10_000,
        });
      } catch {
        // Init might fail if already initialized, that's OK
      }
      
      // Step 4: Start local Supabase (for development)
      const { stdout: startOutput } = await exec("supabase", ["start"], {
        cwd: context.projectPath,
        timeout: 120_000, // Starting Supabase can take a while
      });
      
      // Step 5: Extract credentials from output
      const urlMatch = startOutput.match(/API URL: (http:\/\/[^\s]+)/);
      const anonKeyMatch = startOutput.match(/anon key: ([^\s]+)/);
      const serviceKeyMatch = startOutput.match(/service_role key: ([^\s]+)/);
      
      if (!urlMatch || !anonKeyMatch) {
        return {
          success: false,
          error: "Could not extract Supabase credentials from output",
          message: "Supabase started but failed to parse credentials",
        };
      }
      
      return {
        success: true,
        message: "Supabase database configured successfully (local development)",
        secrets: {
          SUPABASE_URL: urlMatch[1],
          SUPABASE_ANON_KEY: anonKeyMatch[1],
          SUPABASE_SERVICE_ROLE_KEY: serviceKeyMatch?.[1] || "",
        },
        config: {
          service: "supabase/db",
          mode: "local",
        },
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        message: "Failed to provision Supabase database",
      };
    }
  },
};
