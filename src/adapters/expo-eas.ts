import type { ServiceAdapter, AdapterContext, ProvisionResult } from "./types.js";
import { exec } from "../utils/exec.js";


/**
 * Expo EAS Adapter
 * Sets up Expo Application Services with robot account authentication
 */
export const expoEasAdapter: ServiceAdapter = {
  name: "expo/eas",
  description: "Expo Application Services (EAS) with robot account authentication",
  
  getRequiredTools(): string[] {
    return ["eas"];
  },
  
  async check(context: AdapterContext): Promise<boolean> {
    try {
      // Check if EXPO_TOKEN exists in env
      if (context.existingEnv.EXPO_TOKEN) {
        // Verify the token is valid
        try {
          await exec("eas", ["whoami"], {
            timeout: 10_000,
            env: { ...process.env, EXPO_TOKEN: context.existingEnv.EXPO_TOKEN },
          });
          return true;
        } catch {
          // Token exists but is invalid
          return false;
        }
      }
      
      return false;
    } catch {
      return false;
    }
  },
  
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    try {
      // Step 1: Check if EAS CLI is installed
      try {
        await exec("eas", ["--version"], {
          timeout: 5_000,
        });
      } catch {
        return {
          success: false,
          error: "EAS CLI not installed",
          message: "Install EAS CLI: npm install -g eas-cli",
        };
      }
      
      // Step 2: Check if EXPO_TOKEN is already set
      const expoToken = context.existingEnv.EXPO_TOKEN;
      
      if (!expoToken) {
        return {
          success: false,
          error: "EXPO_TOKEN not configured",
          message: `To provision EAS:
1. Create a robot account at https://expo.dev/settings/accounts
2. Generate an access token for the robot account
3. Set EXPO_TOKEN=<your_token> and run 'kit add expo/eas' again
Or provide EXPO_TOKEN in .env.local`,
        };
      }
      
      // Step 3: Verify the token by running 'eas whoami'
      try {
        const { stdout: whoamiOutput } = await exec("eas", ["whoami"], {
          timeout: 10_000,
          env: { ...process.env, EXPO_TOKEN: expoToken },
        });
        
        if (!whoamiOutput || whoamiOutput.includes("Not authenticated")) {
          return {
            success: false,
            error: "EXPO_TOKEN is invalid or expired",
            message: "The provided EXPO_TOKEN does not authenticate successfully. Generate a new token.",
          };
        }
      } catch (error) {
        return {
          success: false,
          error: "Failed to verify EXPO_TOKEN",
          message: `Error: ${error instanceof Error ? error.message : "Unknown error"}. Ensure EXPO_TOKEN is valid.`,
        };
      }
      
      // Step 4: Check project credentials
      try {
        await exec("eas", ["credentials"], {
          cwd: context.projectPath,
          timeout: 15_000,
          env: { ...process.env, EXPO_TOKEN: expoToken },
        });
      } catch {
        // Credentials check may fail for new projects, that's OK
        // The project will use provisioning certificates if available
      }
      
      // Step 5: Verify project structure (optional but helpful)
      try {
        await exec("eas", ["build", "--list", "--limit", "1"], {
          cwd: context.projectPath,
          timeout: 15_000,
          env: { ...process.env, EXPO_TOKEN: expoToken },
        });
      } catch {
        // Project may have no builds yet, that's fine
      }
      
      return {
        success: true,
        message: "Expo EAS provisioned successfully with robot account token",
        secrets: {
          EXPO_TOKEN: expoToken,
        },
        config: {
          service: "expo/eas",
          authenticated: true,
          robotAccount: true,
        },
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        message: "Failed to provision Expo EAS",
      };
    }
  },
};
