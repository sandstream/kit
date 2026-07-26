import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve, join, relative } from "node:path";
import { loadConfig } from "./config.js";
import { checkTools } from "./check-tools.js";
import { checkServices } from "./check-services.js";
import { checkSecrets } from "./check-secrets.js";
import { checkSecurity } from "./check-security.js";
import { checkSkills } from "./check-skills.js";
import { checkLockFiles } from "./check-lock.js";
import { checkTests } from "./check-tests.js";
import { loadBaselineForGate, baselineGet, BASELINE_FILE } from "./baseline.js";
import { computeCheckVerdict } from "./check-verdict.js";
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
import { mapReport } from "./commands/repomap.js";
import { isReadOnlyMode } from "./read-only-mode.js";
import { escapeWorkflowCmd } from "./utils/ci-escape.js";
import { runGovernedBrokered } from "./governance-middleware.js";
import type { kitConfig } from "./config.js";
import { runTriage, type TriageType } from "./triage.js";
import { recordTriageRun } from "./commands/triage.js";
import { openMemoryDb, searchMessages, getMemoryDbPath, recordQuery } from "./memory/db.js";
import { searchShared } from "./memory/shared.js";
import { getCurrentProjectRoot } from "./memory/project.js";
import { existsSync } from "node:fs";

const KIT_FILE = ".kit.toml";

// Canonical, frozen list of MCP tool names kit exposes over stdio. This is part
// of kit's public surface (contracts/public-surface.json) and is kept in lockstep
// with the register_kit_* calls in createMcpServer below. A listTools()-vs-this
// guard in mcp-server.test.ts fails if a tool is added/removed without updating
// this list, so the snapshot can never silently drift.
export const KIT_MCP_TOOLS: readonly string[] = [
  "kit_check",
  "kit_standards",
  "kit_install",
  "kit_login",
  "kit_secrets",
  "kit_fix",
  "kit_add",
  "kit_env",
  "kit_init",
  "kit_ci",
  "kit_run",
  "kit_context",
  "kit_map",
  "kit_triage",
  "kit_memory",
];

/**
 * Server-level instructions (MCP `initialize` result). Clients like Claude Code
 * surface this to route tool selection, so it carries the one decision that
 * matters most for context economy: an agent WITH shell access should prefer the
 * CLI (zero standing context cost, `--help` self-documents all 68 commands);
 * these MCP tools exist for shell-less clients. Kept well under the ~2KB
 * truncation limit clients apply.
 */
const KIT_MCP_INSTRUCTIONS = `kit is a deterministic, local-first dev-environment manager and fail-closed security gate (zero LLM calls).

If you have shell access, prefer running \`kit <command>\` directly — the CLI covers far more than these tools and \`kit <command> --help\` documents everything. These MCP tools exist for shell-less clients.

Typical loop: kit_check (verify env + security) → kit_fix (auto-repair) → kit_triage (REQUIRED before installing any package kit's gate has not already cleared — the gate blocks untriaged installs) → kit_memory (recall prior cross-session decisions before answering project-specific questions) → kit_run (escape hatch for any other kit command).`;

// Deprecation prefix for tools scheduled for removal from the MCP surface in
// kit 6.0 (the MCP surface is "Evolving" per docs/API_STABILITY_AND_VERSIONING.md
// — removal requires notice, so they are marked, not dropped). Rationale: setup-
// time and CI commands are shell contexts by definition; a shell-less MCP client
// is never the thing provisioning services or running CI. kit_run remains the
// escape hatch for all of them.
const DEPRECATED_6_0 = "DEPRECATED — scheduled for removal from the MCP surface in kit 6.0";

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

/** Refusal result for a mutating tool blocked by the governance floor (revocation,
 *  budget, permission/approval, expired secrets). Mirrors the CLI's fail-closed deny. */
function governanceRefusal(reason: string): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: false, governance: "denied", error: reason }, null, 2),
      },
    ],
    isError: true,
  };
}

/** Load config for governance; a missing/invalid .kit.toml yields an empty config
 *  (governance disabled by default) so a governed tool still runs where it always did. */
async function loadConfigForGovernance(cwd?: string): Promise<kitConfig> {
  try {
    return await loadConfig(configPath(cwd));
  } catch {
    return {} as kitConfig;
  }
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "kit", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: KIT_MCP_INSTRUCTIONS },
  );

  // One registrar per tool — keeps this composition flat (was a 774-line
  // function). Each register_* attaches its tool to the server.
  register_kit_check(server);
  register_kit_standards(server);
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
  register_kit_map(server);
  register_kit_triage(server);
  register_kit_memory(server);

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
        // Include test-coverage in the verdict — the CLI does, and omitting it here
        // was one half of the CLI-vs-MCP divergence. Baseline-aware, same as `kit check`.
        const { baseline, ignored: baselineIgnored } = await loadBaselineForGate();
        if (baselineIgnored) {
          // Same fail-closed baseline handling as `kit check` — parity so the two
          // surfaces never disagree on the verdict.
          securityResults.push({
            category: "secrets",
            name: "baseline integrity",
            status: "warn",
            severity: "low",
            detail: `${BASELINE_FILE} ignored (${baselineIgnored}) — gating on all findings; re-freeze with 'kit baseline freeze'`,
          });
        }
        const testResults = await checkTests({
          baseline: baselineGet(baseline, "tests", "untested_files"),
        });

        // The SAME verdict rule `kit check` uses (scanner-health-strict security via
        // gateStatus, informational-service exemption, tests) — no second, divergent
        // definition of "green" on the MCP surface.
        const verdict = computeCheckVerdict(
          {
            tools: toolResults,
            services: serviceResults,
            secrets: secretResults.keys,
            skills: skillResults,
            hooks: hookResults,
            security: securityResults,
            tests: testResults,
            locks: lockResults,
          },
          {},
        );
        const ok = verdict.ok;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok,
                  dimensions: verdict.dimensions,
                  failed: verdict.failed,
                  tools: toolResults,
                  services: serviceResults,
                  secrets: secretResults.keys,
                  skills: skillResults,
                  hooks: hookResults,
                  webSearch: webSearchResult,
                  security: securityResults,
                  tests: testResults,
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

function register_kit_standards(server: McpServer): void {
  // kit_standards — run the dev-standards gate (general + per-language + plugins +
  // platform) and return the SAME { ok, checks, summary } envelope as `kit standards`.
  // Read-only: no writes, so no governance/read-only gating.
  server.tool(
    "kit_standards",
    "Run kit standards (deterministic dev-standards gate: complexity/duplication/size + per-language linters + user plugins + container) and return structured findings. Read-only.",
    {
      cwd: z.string().optional().describe("Working directory (defaults to process.cwd())"),
      enforce: z
        .boolean()
        .optional()
        .describe("Fail on net-new findings AND setup gaps (CI posture)"),
      category: z
        .string()
        .optional()
        .describe("Scope: general | specific | plugins | platform | <language>"),
    },
    async ({ cwd, enforce, category }) => {
      try {
        const { runStandardsGate } = await import("./standards-run.js");
        const { ok, checks, summary, baselineIgnored } = await runStandardsGate({
          cwd,
          enforce,
          category,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok, checks, summary, baselineIgnored }, null, 2),
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
    `${DEPRECATED_6_0}; setup-time provisioning happens in a shell — use \`kit install\` there, or kit_run. Install missing tools defined in .kit.toml using mise.`,
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

        const gov = await runGovernedBrokered(
          config,
          {
            operation: "tools.install",
            operationType: "write",
            metadata: { tools: Object.keys(config.tools) },
            // Infrastructure: mise installs to $HOME + fetches from tool hosts by design — not an
            // agent project action the [scope] RoE governs. Allowed but audited as an exemption.
            infrastructure: true,
          },
          () => installTools(config.tools!),
          { cwd: cwd ?? process.cwd() },
        );
        if (!gov.ok) return governanceRefusal(gov.reason ?? "denied");
        const results = gov.result!;
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
    `${DEPRECATED_6_0}; service auth is interactive/setup-time — use \`kit login\` in a shell. Attempt to log in to services defined in .kit.toml. Runs in non-interactive mode — services requiring interactive auth will be skipped.`,
    { cwd: z.string().optional().describe("Working directory") },
    async ({ cwd }) => {
      if (isReadOnlyMode()) return readOnlyRefusal("kit_login");
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

        const envLocalPath = join(cwd ?? process.cwd(), ".env.local");
        const gov = await runGovernedBrokered(
          config,
          {
            operation: "secrets.generate",
            operationType: "write",
            metadata: {},
            // Honest effect declaration (MCP-runtime adoption step 2): kit's OWN direct effect is
            // the .env.local write. The configured vault CLI resolves secrets in ITS OWN
            // subprocess, whose network I/O is the CLI's — not kit's — and thus out of the
            // exec-broker's reach (a documented limit, like kit_run's command). So fs is the
            // declarable effect here; egress/env are not kit's to claim.
            fsWrites: [envLocalPath],
          },
          () => generateSecrets(config.secrets!, envLocalPath),
          { cwd: cwd ?? process.cwd() },
        );
        if (!gov.ok) return governanceRefusal(gov.reason ?? "denied");
        const { results, written } = gov.result!;
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

        const gov = await runGovernedBrokered(
          config,
          {
            operation: "fix",
            operationType: "write",
            metadata: {},
            // Infrastructure: fix installs tools (mise → $HOME) and writes lock files as kit's own
            // provisioning — not an agent project action the [scope] RoE governs. Audited exemption.
            infrastructure: true,
          },
          async () => {
            const actions: Array<{ name: string; action: string; detail: string }> = [];

            // Fix missing tools (inside the governed closure)
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
              await updateSkillsLock(
                skills,
                meta?.name ? `${meta.name}@${meta.version}` : undefined,
              );
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

            return actions;
          },
          { cwd: cwd ?? process.cwd() },
        );
        if (!gov.ok) return governanceRefusal(gov.reason ?? "denied");
        const actions = gov.result!;
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
    `${DEPRECATED_6_0}; provisioning is setup-time shell work — use \`kit add\` there, or kit_run. Provision a service integration for the project. Available services: ${listAvailableServices().join(", ")}. Writes generated secrets to .env.local and returns provisioning result.`,
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
    `${DEPRECATED_6_0}; kit_context includes environment status — prefer it. Inspect environment variables from .env.local. Returns each key's set/missing status. Values are redacted by default.`,
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
    `${DEPRECATED_6_0}; CI runners always have a shell — run \`kit ci\` there. Run kit CI checks and return structured results. Use before deploying or merging to validate the environment is correctly configured. Returns pass/fail/warn status for tools, services, secrets, lock files, and security.`,
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
            // Escape config-controlled category/name/detail before interpolating into
            // a GitHub workflow command — raw CR/LF would let a crafted detail string
            // forge or hide annotation lines (same class escapeWorkflowCmd prevents).
            const msg = escapeWorkflowCmd(`${c.category}/${c.name}: ${c.detail}`);
            if (c.status === "fail") lines.push(`::error::${msg}`);
            else if (c.status === "warn") lines.push(`::warning::${msg}`);
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
        // Tokenize like a shell (respecting quotes) — a naive whitespace split turns
        // `git commit -m "a b"` into the wrong argv and silently runs a different
        // command. An unterminated quote throws → we refuse rather than mis-split.
        const { shellSplit } = await import("./utils/shellSplit.js");
        const commandArgs = shellSplit(command);

        // Per-command egress extraction (MCP-runtime adoption step 4): kit_run executes an
        // ARBITRARY command, so its effects can't be fully declared — but the explicit http(s)
        // URLs in the command text CAN be, using the same conservative extractor the PreToolUse
        // egress-gate uses. Under [scope].enforce_runtime those hosts are gated against
        // [scope].egress before the command spawns. Honest limits (documented, not false-greened):
        // a command that reaches the network without an explicit URL is out of the extractor's
        // reach, and fs/env are NOT declarable from an arbitrary command (the command inherits env
        // by design) — those remain un-mediated here; the PreToolUse fs-gate covers Write/Edit.
        const { extractHostsFromCommand } = await import("./broker/extract.js");
        const egressTargets = extractHostsFromCommand(command);

        // kit_run inherits the secret-loaded env and executes an arbitrary command,
        // so it must pass the same governance floor as a CLI write (revocation,
        // budget, permission, expired-secret block) and be audited — not just gated
        // by read-only mode.
        const config = await loadConfigForGovernance(cwd);
        const gov = await runGovernedBrokered(
          config,
          {
            operation: "run",
            operationType: "write",
            metadata: { command, mediation: "egress-only (arbitrary command; fs/env un-mediated)" },
            egressTargets,
          },
          () =>
            executeCommand({
              commandArgs,
              cwd: workDir,
              inheritEnv: true,
            }),
          { cwd: workDir },
        );
        if (!gov.ok) return governanceRefusal(gov.reason ?? "denied");
        const result = gov.result!;

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

function register_kit_map(server: McpServer): void {
  // kit_map — deterministic repo-map: the relevant slice around a seed file (read-only). Shares the
  // exact core (mapReport) with the `kit map` CLI, so the two surfaces can't disagree.
  server.tool(
    "kit_map",
    "Deterministic, zero-LLM repo-map: given seed file path(s), return the relevant SLICE of the codebase — files connected within N import hops (both directions) + external packages, each attributed to its owner (CODEOWNERS or git-blame). Optionally budget the slice to the N nearest files and add historical co-change coupling. Use it to load only the part of a growing repo that matters to a task, instead of the whole tree.",
    {
      paths: z
        .array(z.string())
        .min(1)
        .describe("Seed file path(s) to map around (repo-relative or absolute)"),
      depth: z.number().int().min(0).optional().describe("Import hops from the seed (default 1)"),
      budget: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Keep only the N nearest-to-seed files (0 = unbounded); drops are reported"),
      co_change: z
        .boolean()
        .optional()
        .describe("Add files that historically change WITH each seed (git history)"),
      cwd: z.string().optional().describe("Working directory (defaults to process.cwd())"),
    },
    async ({ paths, depth, budget, co_change, cwd }) => {
      try {
        const root = cwd ?? process.cwd();
        const seeds = paths.map((s) => relative(root, resolve(root, s)).split("\\").join("/"));
        const report = mapReport(root, seeds, {
          depth: depth ?? 1,
          budget: budget ?? 0,
          coChange: co_change ?? false,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}

function register_kit_triage(server: McpServer): void {
  // kit_triage — security-evaluate a package/image/repo/skill BEFORE it is
  // installed. This closes a dead end: the install gate blocks untriaged
  // packages with the instruction "run kit triage first", which a shell-less
  // MCP client could not previously follow. A PASS is recorded through the SAME
  // triage-log path the CLI uses, so the pre-commit and install gates recognize
  // an MCP-run triage identically.
  server.tool(
    "kit_triage",
    "Security-triage a dependency BEFORE installing it (registry reputation, repo health, known-compromise catalogs). Required by kit's install gate for anything it has not already cleared. A pass is recorded in the triage log the gates read. Deterministic, zero-LLM.",
    {
      type: z
        .enum(["npm", "pip", "docker", "brew", "repo", "skill"])
        .describe(
          "Target kind: npm/pip package, docker image, brew formula, GitHub repo, or agent skill",
        ),
      target: z.string().describe("Package name, image ref, owner/repo, or skill path"),
      cwd: z
        .string()
        .optional()
        .describe(
          "Working directory (defaults to process.cwd()) — where the triage log is written",
        ),
    },
    async ({ type, target, cwd }) => {
      // Appends to .kit-triage.jsonl on PASS, so read-only mode refuses it —
      // an unrecordable pass could not satisfy the gates anyway (fail-closed).
      if (isReadOnlyMode()) return readOnlyRefusal("kit_triage");
      try {
        const result = await runTriage(type as TriageType, target);
        if (result.passed && target) {
          await recordTriageRun(type, target, false, false, cwd);
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  passed: result.passed,
                  type: result.type,
                  target: result.target,
                  verdict: result.passed
                    ? "TRIAGE PASSED — recorded in the triage log; the install gate will now allow this target"
                    : "TRIAGE FAILED — do not install; inspect the output below",
                  output: result.output,
                },
                null,
                2,
              ),
            },
          ],
          isError: !result.passed,
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

function register_kit_memory(server: McpServer): void {
  // kit_memory — search cross-session conversation memory (and the curated
  // shared tier that travels with the repo). Search-only by design: writes to
  // the trusted store stay on the CLI/indexer path, so an MCP client can never
  // inject foreign text into recall. Quarantined (injection-flagged) rows are
  // excluded, matching the CLI default.
  server.tool(
    "kit_memory",
    "Search kit's local cross-session conversation memory plus the repo's curated shared decisions. Use before answering project-specific questions to recall what was actually said/decided. Read-only search; quarantined rows excluded.",
    {
      query: z.string().describe("Search terms"),
      limit: z.number().int().min(1).max(100).optional().describe("Max raw hits (default 20)"),
      global: z
        .boolean()
        .optional()
        .describe("Search across all projects instead of only the current one"),
      cwd: z.string().optional().describe("Project directory (defaults to process.cwd())"),
    },
    async ({ query, limit, global: searchGlobal, cwd }) => {
      try {
        const root = getCurrentProjectRoot(cwd ?? process.cwd());
        // No store on this machine → empty result, NOT a freshly-created store:
        // openMemoryDb would otherwise migrate a new db into existence as a
        // side effect of a read — wrong for a search tool.
        if (!existsSync(getMemoryDbPath())) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    messages: [],
                    shared: [],
                    note: "no memory store on this machine — run `kit memory index` to build one",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const db = openMemoryDb();
        let hits;
        try {
          hits = searchMessages(db, query, {
            limit: limit ?? 20,
            projectPath: searchGlobal ? undefined : root,
          });
          // Same best-effort recall logging as the CLI (adoption metrics read
          // it); skipped in read-only mode so the tool stays a pure read there.
          if (!isReadOnlyMode()) {
            try {
              recordQuery(db, {
                query,
                hitCount: hits.length,
                projectPath: searchGlobal ? undefined : root,
              });
            } catch {
              // logging is non-critical
            }
          }
        } finally {
          db.close();
        }
        // Curated shared tier — always project-local, best-effort (parity with CLI).
        let shared: unknown[] = [];
        try {
          shared = searchShared(root, query);
        } catch {
          // shared tier never gates raw recall
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ messages: hits, shared }, null, 2),
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
