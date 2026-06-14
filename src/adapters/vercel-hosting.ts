import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ServiceAdapter, AdapterContext, ProvisionResult } from "./types.js";
import { exec } from "../utils/exec.js";


/**
 * Vercel Hosting Adapter
 * Links repository to Vercel and sets up deployment
 */
export const vercelHostingAdapter: ServiceAdapter = {
  name: "vercel/hosting",
  description: "Vercel hosting and deployment",
  
  getRequiredTools(): string[] {
    return ["vercel"];
  },
  
  async check(context: AdapterContext): Promise<boolean> {
    try {
      // Check if .vercel directory exists (indicates project is linked)
      await readFile(resolve(context.projectPath, ".vercel", "project.json"), "utf-8");
      return true;
    } catch {
      return false;
    }
  },
  
  async provision(context: AdapterContext): Promise<ProvisionResult> {
    try {
      // Step 1: Check if Vercel CLI is installed
      try {
        await exec("vercel", ["--version"], {
          timeout: 5_000,
        });
      } catch {
        return {
          success: false,
          error: "Vercel CLI not installed",
          message: "Install Vercel CLI: npm install -g vercel",
        };
      }
      
      // Step 2: Check authentication
      try {
        const { stdout: whoamiOutput } = await exec("vercel", ["whoami"], {
          timeout: 10_000,
        });
        
        if (!whoamiOutput.trim() || whoamiOutput.includes("Error")) {
          return {
            success: false,
            error: "Vercel CLI not authenticated",
            message: "Authenticate with Vercel: vercel login",
          };
        }
      } catch {
        return {
          success: false,
          error: "Vercel CLI not authenticated",
          message: "Authenticate with Vercel: vercel login",
        };
      }
      
      // Step 3: Link project (interactive, will ask for project details)
      await exec("vercel", ["link", "--yes"], {
        cwd: context.projectPath,
        timeout: 30_000,
      });
      
      // Step 4: Get project info
      const { stdout: projectInfo } = await exec("vercel", ["project", "ls", "--json"], {
        timeout: 10_000,
      });
      
      let projectData: any = {};
      try {
        const projects = JSON.parse(projectInfo);
        if (projects && projects.length > 0) {
          projectData = projects[0];
        }
      } catch {
        // JSON parse failed
      }
      
      // Step 5: Get environment variables if project is linked
      let secrets: Record<string, string> = {};
      
      try {
        // Read .vercel/project.json to get project ID
        const vercelConfig = await readFile(
          resolve(context.projectPath, ".vercel", "project.json"),
          "utf-8"
        );
        const config = JSON.parse(vercelConfig);
        
        secrets = {
          VERCEL_PROJECT_ID: config.projectId || "",
          VERCEL_ORG_ID: config.orgId || "",
        };
      } catch {
        // Could not read vercel config
      }
      
      return {
        success: true,
        message: "Vercel hosting configured successfully",
        secrets,
        config: {
          service: "vercel/hosting",
          linked: true,
          projectName: projectData.name || context.projectName,
        },
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        message: "Failed to provision Vercel hosting",
      };
    }
  },
};
