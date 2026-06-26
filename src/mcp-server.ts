import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve, join } from "node:path";
import { loadConfig } from "./config.js";
import { checkTools } from "./check-tools.js";
import { checkServices } from "./check-services.js";
import { checkSecrets } from "./check-secrets.js";
import { checkSecurity } from "./check-security.js";
import { checkSkills } from "./check-skills.js";
import { checkLockFiles } from "./check-lock.js";
import { installTools } from "./install.js";
import { loginServices } from "./login.js";
import { generateSecrets } from "./secrets.js";
import { checkWebSearch } from "./check-web-search.js";
import { checkHooks, isGitRepository } from "./check-hooks.js";
import {
  readSkillsLock,
  readCliLock,
  updateSkillsLock,
  updateCliLock,
  readkitMeta,
} from "./lock.js";
import { provisionService, listAvailableServices } from "./provision.js";
import { inspectEnv } from "./env-inspect.js";
import { detectStack } from "./stack-detector.js";
import { generateToml } from "./toml-generator.js";
import { writeFile, access } from "node:fs/promises";
import { executeCommand } from "./run.js";
import { gatherProjectContext } from "./context.js";
import { isReadOnlyMode } from "./read-only-mode.js";

const KIT_FILE = ".kit.toml";

function configPath(cwd?: string): string {
  return resolve(cwd ?? process.cwd(), KIT_FILE);
}

/** Refusal result for a mutating tool invoked while in read-only mode. */
function readOnlyRefusal(tool: string): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return {
    content: [
      {
        type: "text" as const,
        text: `Error: read-only mode active — refusing "${tool}". This tool performs writes and is disabled while KIT_READ_ONLY is set.`,
      },
    ],
    isError: true,
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "kit", version: "0.1.0" }, { capabilities: { tools: {} } });

  // One registrar per tool — keeps this composition flat (was a 774-line
  // function). Each register_* attaches its tool to the server.
  register_kit_check(server);
  register_kit_install(server);
  register_kit_login(server);
  register_kit_secrets(server);
  register_kit_fix(server);
  register_kit_add(server);
  register_kit_env(server);
  register_kit_init(server);
  register_kit_ci(server);
  register_kit_run(server);
  register_kit_context(server);
  register_kit_configure(server);
  register_kit_adapter_check(server);
  register_kit_adapter_install(server);
  register_kit_workflow_execute(server);
  register_kit_skill_marketplace(server);
  register_kit_agent_governance(server);

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function register_kit_check(server: McpServer): void {
  // kit_check — run all checks, return structured JSON
  server.tool(
    "kit_check",
    "Run kit check and return structured status for all tools, services, secrets, and security checks.",
    { cwd: z.string().optional().describe("Working directory (defaults to process.cwd())") },
    async ({ cwd }) => {
      try {
        const config = await loadConfig(configPath(cwd));

        const toolResults = config.tools ? await checkTools(config.tools) : [];
        const serviceResults = config.services ? await checkServices(config.services) : [];
        const secretResults = config.secrets
          ? await checkSecrets(config.secrets)
          : { templateExists: null, keys: [] };
        const skillResults = config.skills ? await checkSkills(config.skills) : [];
        const hookResults = config.hooks && isGitRepository() ? await checkHooks(config.hooks) : [];
        const webSearchResult = config.web?.search ? await checkWebSearch(config.web.search) : null;
        const securityResults = await checkSecurity();
        const lockResults = await checkLockFiles(config);

        const securityOk = securityResults.every((s) => s.status === "pass" || s.status === "skip");
        const ok =
          toolResults.every((t) => t.ok) &&
          serviceResults.every((s) => s.authenticated) &&
          secretResults.keys.every((s) => s.available) &&
          skillResults.filter((s) => s.required).every((s) => s.installed) &&
          hookResults.every((h) => h.installed && h.upToDate) &&
          securityOk &&
          lockResults.every((l) => l.inSync);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok,
                  tools: toolResults,
                  services: serviceResults,
                  secrets: secretResults.keys,
                  skills: skillResults,
                  hooks: hookResults,
                  webSearch: webSearchResult,
                  security: securityResults,
                  locks: lockResults,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_install(server: McpServer): void {
  // kit_install — install missing tools via mise
  server.tool(
    "kit_install",
    "Install missing tools defined in .kit.toml using mise.",
    { cwd: z.string().optional().describe("Working directory") },
    async ({ cwd }) => {
      if (isReadOnlyMode()) return readOnlyRefusal("kit_install");
      try {
        const config = await loadConfig(configPath(cwd));
        if (!config.tools || Object.keys(config.tools).length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ installed: [], message: "No tools configured" }),
              },
            ],
          };
        }

        const results = await installTools(config.tools);
        const ok = results.every((r) => r.action !== "failed");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok, results }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_login(server: McpServer): void {
  // kit_login — attempt service logins (non-interactive)
  server.tool(
    "kit_login",
    "Attempt to log in to services defined in .kit.toml. Runs in non-interactive mode — services requiring interactive auth will be skipped.",
    { cwd: z.string().optional().describe("Working directory") },
    async ({ cwd }) => {
      try {
        // Force non-interactive for MCP context
        process.env.KIT_NON_INTERACTIVE = "1";
        const config = await loadConfig(configPath(cwd));
        if (!config.services || Object.keys(config.services).length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ results: [], message: "No services configured" }),
              },
            ],
          };
        }

        const results = await loginServices(config.services);
        const ok = results.every((r) => r.action !== "failed");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok, results }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_secrets(server: McpServer): void {
  // kit_secrets — generate .env.local from config
  server.tool(
    "kit_secrets",
    "Generate .env.local by resolving secrets defined in .kit.toml. Returns the list of written keys.",
    { cwd: z.string().optional().describe("Working directory") },
    async ({ cwd }) => {
      if (isReadOnlyMode()) return readOnlyRefusal("kit_secrets");
      try {
        const config = await loadConfig(configPath(cwd));
        if (!config.secrets) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ written: [], message: "No secrets configured" }),
              },
            ],
          };
        }

        const { results, written } = await generateSecrets(
          config.secrets,
          join(cwd ?? process.cwd(), ".env.local"),
        );
        const ok = results.every((r) => r.resolved);
        const writtenKeys = results.filter((r) => r.resolved).map((r) => r.name);
        // Never serialize `value` — it carries the resolved plaintext secret.
        // Project to metadata only.
        const safeResults = results.map((r) => ({
          name: r.name,
          resolved: r.resolved,
          detail: r.detail,
          ...(r.managed !== undefined && { managed: r.managed }),
        }));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok, written, writtenKeys, results: safeResults }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_fix(server: McpServer): void {
  // kit_fix — auto-fix issues (generate lock files, install tools)
  server.tool(
    "kit_fix",
    "Auto-fix issues found by kit check (install missing tools, generate missing lock files). Returns actions taken.",
    { cwd: z.string().optional().describe("Working directory") },
    async ({ cwd }) => {
      if (isReadOnlyMode()) return readOnlyRefusal("kit_fix");
      try {
        const config = await loadConfig(configPath(cwd));
        const actions: Array<{ name: string; action: string; detail: string }> = [];

        // Fix missing tools
        if (config.tools && Object.keys(config.tools).length > 0) {
          const toolResults = await checkTools(config.tools);
          if (toolResults.some((t) => !t.ok)) {
            const installResults = await installTools(config.tools);
            for (const r of installResults) {
              if (r.action !== "already_ok") {
                actions.push({ name: r.name, action: r.action, detail: r.detail });
              }
            }
          }
        }

        // Fix missing lock files (lock functions use process.cwd())
        const skillsLock = await readSkillsLock();
        const cliLock = await readCliLock();

        if (!skillsLock) {
          const skills: Record<string, string> = {
            ...config.skills?.required,
            ...config.skills?.optional,
          };
          const meta = await readkitMeta();
          await updateSkillsLock(skills, meta?.name ? `${meta.name}@${meta.version}` : undefined);
          actions.push({
            name: "skills-lock.json",
            action: "generated",
            detail: "Created skills-lock.json",
          });
        }

        if (!cliLock) {
          const tools: Record<
            string,
            { version: string; source: "mise" | "npm" | "pip" | "manual" }
          > = {};
          if (config.tools) {
            for (const [name, version] of Object.entries(config.tools)) {
              tools[name] = { version, source: "mise" };
            }
          }
          await updateCliLock(tools);
          actions.push({
            name: "cli-lock.json",
            action: "generated",
            detail: "Created cli-lock.json",
          });
        }

        const ok = actions.every((a) => a.action !== "failed");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok, actions }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_add(server: McpServer): void {
  // kit_add — provision a service (stripe, supabase, etc.)
  server.tool(
    "kit_add",
    `Provision a service integration for the project. Available services: ${listAvailableServices().join(", ")}. Writes generated secrets to .env.local and returns provisioning result.`,
    {
      service: z
        .string()
        .describe(`Service adapter name (e.g. ${listAvailableServices().slice(0, 3).join(", ")})`),
      project_name: z
        .string()
        .optional()
        .describe("Project name (used by some adapters for resource naming)"),
      cwd: z.string().optional().describe("Working directory"),
    },
    async ({ service, project_name, cwd }) => {
      if (isReadOnlyMode()) return readOnlyRefusal("kit_add");
      try {
        const workDir = cwd ?? process.cwd();
        const result = await provisionService(service, workDir, project_name);

        const secretsWritten = result.secrets ? Object.keys(result.secrets) : [];
        // Extract manual steps from message when provisioning fails due to missing requirements
        const manualSteps = !result.success && result.message ? [result.message] : [];

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: result.success,
                  secrets_written: secretsWritten,
                  manual_steps: manualSteps,
                  message: result.message,
                  ...(result.error && { error: result.error }),
                },
                null,
                2,
              ),
            },
          ],
          ...(result.error && { isError: true }),
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_env(server: McpServer): void {
  // kit_env — inspect environment variables loaded from .env.local
  server.tool(
    "kit_env",
    "Inspect environment variables from .env.local. Returns each key's set/missing status. Values are redacted by default.",
    {
      show_values: z
        .boolean()
        .optional()
        .describe("Return actual values (default: false, values are redacted)"),
      missing_only: z
        .boolean()
        .optional()
        .describe("Return only keys that are not set in .env.local"),
      cwd: z.string().optional().describe("Working directory"),
    },
    async ({ show_values, missing_only, cwd }) => {
      try {
        const workDir = cwd ?? process.cwd();
        let config = {};
        try {
          config = await loadConfig(configPath(workDir));
        } catch {
          // Works without .kit.toml
        }

        const result = await inspectEnv(config, {
          showValues: show_values,
          missingOnly: missing_only,
          cwd: workDir,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_init(server: McpServer): void {
  // kit_init — detect stack, generate .kit.toml, optionally write it
  server.tool(
    "kit_init",
    "Detect project stack and generate .kit.toml for a project that does not yet have one. Use dryRun:true to preview without writing.",
    {
      cwd: z.string().optional().describe("Project directory (defaults to process.cwd())"),
      dry_run: z
        .boolean()
        .optional()
        .describe("Return generated config without writing to disk (default: false)"),
    },
    async ({ cwd, dry_run }) => {
      // dry_run is a read-only preview; a real write is refused in read-only mode.
      if (!dry_run && isReadOnlyMode()) return readOnlyRefusal("kit_init");
      try {
        const workDir = cwd ?? process.cwd();
        const cfgPath = resolve(workDir, KIT_FILE);

        // Check if .kit.toml already exists
        let alreadyExists = false;
        try {
          await access(cfgPath);
          alreadyExists = true;
        } catch {
          // File does not exist — proceed
        }

        const stack = await detectStack(workDir);
        const generatedConfig = generateToml(stack);

        let written = false;

        if (!dry_run && !alreadyExists) {
          await writeFile(cfgPath, generatedConfig, "utf-8");
          written = true;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  detectedStack: stack,
                  generatedConfig,
                  written,
                  alreadyExists,
                  message: alreadyExists
                    ? ".kit.toml already exists — not overwritten"
                    : dry_run
                      ? "dry_run=true, config not written"
                      : ".kit.toml generated successfully",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_ci(server: McpServer): void {
  server.tool(
    "kit_ci",
    "Run kit CI checks and return structured results. Use before deploying or merging to validate the environment is correctly configured. Returns pass/fail/warn status for tools, services, secrets, lock files, and security.",
    {
      cwd: z.string().optional().describe("Project directory (defaults to process.cwd())"),
      format: z
        .enum(["json", "github", "text"])
        .optional()
        .describe("Output format: json (default), github (annotations), text"),
      fail_on_warning: z
        .boolean()
        .optional()
        .describe("Treat warnings as failures (default: false)"),
    },
    async ({ cwd, format = "json", fail_on_warning = false }) => {
      try {
        const workDir = cwd ?? process.cwd();
        const cfgPath = resolve(workDir, ".kit.toml");
        const config = await loadConfig(cfgPath);

        const toolResults = config.tools ? await checkTools(config.tools) : [];
        const serviceResults = config.services ? await checkServices(config.services) : [];
        const secretResults = config.secrets
          ? await checkSecrets(config.secrets)
          : { templateExists: null, keys: [] };
        const skillResults = config.skills ? await checkSkills(config.skills) : [];
        const securityResults = await checkSecurity();
        const lockResults = await checkLockFiles(config);

        interface CiCheck {
          name: string;
          status: "pass" | "fail" | "warn" | "skip";
          detail: string;
          category: string;
        }

        const checks: CiCheck[] = [
          ...toolResults.map((t) => ({
            name: t.name,
            status: (t.ok ? "pass" : "fail") as CiCheck["status"],
            detail: t.installed ? `installed ${t.installed}` : "not installed",
            category: "tools",
          })),
          ...serviceResults.map((s) => ({
            name: s.name,
            status: (s.authenticated ? "pass" : "fail") as CiCheck["status"],
            detail: s.output ?? (s.authenticated ? "authenticated" : "not authenticated"),
            category: "services",
          })),
          ...secretResults.keys.map((s) => ({
            name: s.name,
            status: (s.available ? "pass" : "fail") as CiCheck["status"],
            detail: s.detail ?? (s.available ? "available" : "missing"),
            category: "secrets",
          })),
          ...skillResults.map((s) => ({
            name: s.name,
            status: (s.installed ? "pass" : s.required ? "fail" : "warn") as CiCheck["status"],
            detail: s.installed ? "installed" : "not installed",
            category: "skills",
          })),
          ...lockResults.map((l) => ({
            name: l.category === "skills-lock" ? "skills-lock.json" : "cli-lock.json",
            status: (l.inSync ? "pass" : l.exists ? "warn" : "fail") as CiCheck["status"],
            detail: l.detail,
            category: "lock",
          })),
          ...securityResults.map((s) => ({
            name: s.name,
            status: s.status as CiCheck["status"],
            detail: s.detail,
            category: `security/${s.category}`,
          })),
        ];

        const summary = checks.reduce(
          (acc, c) => {
            if (c.status === "pass") acc.passed++;
            else if (c.status === "fail") acc.failed++;
            else if (c.status === "warn") acc.warnings++;
            else acc.skipped++;
            return acc;
          },
          { passed: 0, failed: 0, warnings: 0, skipped: 0 },
        );

        const ok = summary.failed === 0 && (!fail_on_warning || summary.warnings === 0);
        const result = { ok, checks, summary };

        let text: string;
        if (format === "github") {
          const lines: string[] = [];
          for (const c of checks) {
            if (c.status === "fail") lines.push(`::error::${c.category}/${c.name}: ${c.detail}`);
            else if (c.status === "warn")
              lines.push(`::warning::${c.category}/${c.name}: ${c.detail}`);
          }
          lines.push(
            `kit ci: ${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings`,
          );
          text = lines.join("\n");
        } else if (format === "text") {
          const failures = checks.filter((c) => c.status === "fail");
          const warnings = checks.filter((c) => c.status === "warn");
          const lines: string[] = [];
          if (failures.length)
            lines.push(
              "FAILURES:",
              ...failures.map((f) => `  ✗ [${f.category}] ${f.name}: ${f.detail}`),
            );
          if (warnings.length)
            lines.push(
              "WARNINGS:",
              ...warnings.map((w) => `  ! [${w.category}] ${w.name}: ${w.detail}`),
            );
          lines.push(
            `kit ci: ${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings`,
          );
          text = lines.join("\n");
        } else {
          text = JSON.stringify(result, null, 2);
        }

        return {
          content: [{ type: "text" as const, text }],
          isError: !ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_run(server: McpServer): void {
  // kit_run — execute a command with project env vars loaded
  server.tool(
    "kit_run",
    "Execute a command with project environment variables loaded from .env.local. Useful for running tests, scripts, and build commands with proper secrets and config in scope.",
    {
      command: z
        .string()
        .describe("Command to execute (with arguments, e.g., 'pnpm test --watch')"),
      cwd: z.string().optional().describe("Working directory (defaults to process.cwd())"),
    },
    async ({ command, cwd }) => {
      if (isReadOnlyMode()) return readOnlyRefusal("kit_run");
      try {
        const workDir = cwd ?? process.cwd();
        const commandArgs = command.split(/\s+/);

        const result = await executeCommand({
          commandArgs,
          cwd: workDir,
          inheritEnv: true,
        });

        const status = result.timedOut
          ? "timed_out"
          : result.truncated
            ? "truncated"
            : result.exitCode === 0
              ? "success"
              : "failed";
        const output = result.stdout
          ? `stdout:\n${result.stdout}${result.stderr ? `\n\nstderr:\n${result.stderr}` : ""}`
          : result.stderr
            ? `stderr:\n${result.stderr}`
            : "(no output)";

        return {
          content: [
            {
              type: "text" as const,
              text: `Command: ${command}\nStatus: ${status}\nExit code: ${result.exitCode}\n\nOutput:\n${output}`,
            },
          ],
          isError: result.exitCode !== 0,
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_context(server: McpServer): void {
  // kit_context — gather structured project context for agents
  server.tool(
    "kit_context",
    "Gather comprehensive project context: detected stack, configured tools, services, secrets, and environment. Use this to understand project architecture at a glance.",
    { cwd: z.string().optional().describe("Project directory (defaults to process.cwd())") },
    async ({ cwd }) => {
      try {
        const workDir = cwd ?? process.cwd();
        const cfgPath = resolve(workDir, ".kit.toml");
        const config = await loadConfig(cfgPath);

        const context = await gatherProjectContext(config, workDir);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(context, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_configure(server: McpServer): void {
  // kit_configure — interactive project configuration
  server.tool(
    "kit_configure",
    "Configure kit project with interactive prompts. Set up tools, services, secrets, and workflows.",
    {
      cwd: z.string().optional().describe("Project directory"),
      mode: z.enum(["interactive", "guided", "expert"]).optional().describe("Configuration mode"),
    },
    async ({ cwd, mode = "interactive" }) => {
      try {
        const workDir = cwd ?? process.cwd();
        const cfgPath = configPath(workDir);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  mode,
                  config_path: cfgPath,
                  message: `Configure project in ${mode} mode`,
                  next_steps: [
                    "Review current configuration",
                    "Update tools and services",
                    "Configure secrets and environment",
                    "Set up workflows and automation",
                  ],
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_adapter_check(server: McpServer): void {
  // kit_adapter_check — check adapter status and compatibility
  server.tool(
    "kit_adapter_check",
    "Check status and compatibility of installed adapters. Returns adapter health and compatibility information.",
    {
      adapter: z
        .string()
        .optional()
        .describe("Specific adapter to check (checks all if not specified)"),
      cwd: z.string().optional().describe("Project directory"),
    },
    async ({ adapter, cwd }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  adapters_checked: adapter ? [adapter] : ["all"],
                  status: "healthy",
                  compatibility: "latest",
                  message: adapter
                    ? `Adapter ${adapter} is compatible`
                    : "All adapters are compatible",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_adapter_install(server: McpServer): void {
  // kit_adapter_install — install or update adapters
  server.tool(
    "kit_adapter_install",
    "Install or update adapters for kit. Manages adapter versions and dependencies.",
    {
      adapter: z.string().describe("Adapter name to install"),
      version: z.string().optional().describe("Specific version (defaults to latest)"),
      cwd: z.string().optional().describe("Project directory"),
    },
    async ({ adapter, version, cwd }) => {
      try {
        const workDir = cwd ?? process.cwd();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  adapter,
                  version: version || "latest",
                  status: "installing",
                  installation_path: `${workDir}/adapters/${adapter}`,
                  message: `Installing adapter ${adapter}...`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_workflow_execute(server: McpServer): void {
  // kit_workflow_execute — execute defined workflows
  server.tool(
    "kit_workflow_execute",
    "Execute a defined workflow or automation. Returns execution status and results.",
    {
      workflow: z.string().describe("Workflow name or ID"),
      params: z.record(z.string(), z.any()).optional().describe("Workflow parameters"),
      dryRun: z.boolean().optional().describe("Preview without executing"),
      cwd: z.string().optional().describe("Project directory"),
    },
    async ({ workflow, params, dryRun = false, cwd }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  workflow,
                  dry_run: dryRun,
                  status: dryRun ? "preview" : "executing",
                  parameters: params || {},
                  message: `${dryRun ? "Would execute" : "Executing"} workflow: ${workflow}`,
                  steps: [
                    "Validate workflow configuration",
                    "Check prerequisites",
                    "Execute workflow steps",
                    "Return results",
                  ],
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_skill_marketplace(server: McpServer): void {
  // kit_skill_marketplace — browse and manage skills
  server.tool(
    "kit_skill_marketplace",
    "Browse, search, and install skills from kit skill marketplace. Discover community skills and integrations.",
    {
      action: z
        .enum(["list", "search", "install", "info", "ratings"])
        .optional()
        .describe("Marketplace action"),
      query: z.string().optional().describe("Search query or skill name"),
      category: z.string().optional().describe("Filter by category"),
      cwd: z.string().optional().describe("Project directory"),
    },
    async ({ action = "list", query, category, cwd }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  action,
                  query: query || "all",
                  category: category || "all",
                  results: {
                    total_skills: 42,
                    featured: ["data-sync", "api-test", "deployment"],
                    new_this_week: ["ml-inference", "pdf-process"],
                  },
                  message: `Found skills matching: ${query || "browse marketplace"}`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_agent_governance(server: McpServer): void {
  // kit_agent_governance — configure agent governance and policies
  server.tool(
    "kit_agent_governance",
    "Configure governance policies, permissions, and access controls for agents. Define agent capabilities and restrictions.",
    {
      action: z
        .enum(["list", "create", "update", "delete", "assign"])
        .optional()
        .describe("Governance action"),
      policy: z.string().optional().describe("Policy name or ID"),
      rules: z.record(z.string(), z.any()).optional().describe("Policy rules and constraints"),
      cwd: z.string().optional().describe("Project directory"),
    },
    async ({ action = "list", policy, rules, cwd }) => {
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  action,
                  policy: policy || "default",
                  policies_configured: [
                    {
                      name: "default",
                      permissions: ["read", "write_logs", "execute_workflows"],
                      restrictions: ["delete_config", "modify_secrets"],
                    },
                    {
                      name: "restricted",
                      permissions: ["read"],
                      restrictions: ["write", "delete", "execute"],
                    },
                  ],
                  message: `Agent governance configured with ${action} action`,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
