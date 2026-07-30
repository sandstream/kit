import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve, join, relative } from "node:path";
import { loadConfig } from "./config.js";
import { checkTools } from "./check-tools.js";
import { runCheckGate } from "./check-run.js";
import { installTools } from "./install.js";
import { generateSecrets } from "./secrets.js";
import {
  readSkillsLock,
  readCliLock,
  updateSkillsLock,
  updateCliLock,
  readkitMeta,
} from "./lock.js";
import { detectStack } from "./stack-detector.js";
import { generateToml } from "./toml-generator.js";
import { writeFile, access } from "node:fs/promises";
import { executeCommand } from "./run.js";
import { gatherProjectContext } from "./context.js";
import { mapReport } from "./commands/repomap.js";
import { isReadOnlyMode } from "./read-only-mode.js";
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
  "kit_review",
  "kit_secrets",
  "kit_fix",
  "kit_init",
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

Typical loop: kit_check (verify env + security) → kit_fix (auto-repair) → kit_triage (REQUIRED before installing any package kit's gate has not already cleared — the gate blocks untriaged installs) → kit_memory (recall prior cross-session decisions before answering project-specific questions) → kit_review (full audit — check + design + standards + ADR — before merging) → kit_run (escape hatch for any other kit command).`;

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
  register_kit_review(server);
  register_kit_secrets(server);
  register_kit_fix(server);
  register_kit_init(server);
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
  // kit_check — run all checks, return structured JSON. Collection + verdict come
  // from the shared core (check-run.ts) — the SAME path `kit check` runs, so the
  // two surfaces can never disagree on what runs or what "green" means.
  server.tool(
    "kit_check",
    "Run kit check and return structured status for all tools, services, secrets, and security checks.",
    { cwd: z.string().optional().describe("Working directory (defaults to process.cwd())") },
    async ({ cwd }) => {
      try {
        const r = await runCheckGate({ cwd });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: r.ok,
                  dimensions: r.verdict.dimensions,
                  failed: r.verdict.failed,
                  tools: r.tools,
                  services: r.services,
                  secrets: r.secrets.keys,
                  skills: r.skills,
                  hooks: r.hooks,
                  webSearch: r.webSearch,
                  security: r.security,
                  tests: r.tests,
                  locks: r.locks,
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

function register_kit_review(server: McpServer): void {
  // kit_review — the full repo audit (check + design + standards + ADR) as ONE
  // structured report, via the same collectReview core `kit review` renders.
  // Replaces kit_standards on the MCP surface (that stage is one of its four).
  // Read-only: no writes, so no governance/read-only gating.
  server.tool(
    "kit_review",
    'Full repo audit in one shot — runs the check, design, standards, and ADR gates and returns one structured report ({ ok, failed, stages }). The same core `kit review` renders, so the surfaces cannot disagree. Read-only. Use stages to scope (e.g. ["standards"] for a fast lint loop — no full security scan), category to scope the standards stage, and concise:true to omit pass/skip rows (per-stage counts stay).',
    {
      cwd: z.string().optional().describe("Working directory (defaults to process.cwd())"),
      enforce: z
        .boolean()
        .optional()
        .describe("Fail on net-new design/standards findings AND setup gaps (CI posture)"),
      stages: z
        .array(z.enum(["check", "design", "standards", "adr"]))
        .nonempty()
        .optional()
        .describe(
          'Run only these stages (canonical order kept). Omit for the full audit. ["standards"] is the fast, read-only lint loop',
        ),
      category: z
        .string()
        .optional()
        .describe("Standards-stage scope: general | specific | plugins | platform | <language>"),
      concise: z
        .boolean()
        .optional()
        .describe(
          "Return only fail/warn findings; per-stage summary counts still cover everything",
        ),
    },
    async ({ cwd, enforce, stages, category, concise }) => {
      try {
        const { collectReview } = await import("./commands/review.js");
        const report = await collectReview({ cwd, enforce, stages, category });
        const payload = concise
          ? {
              ...report,
              stages: report.stages.map((s) => ({
                ...s,
                findings: s.findings.filter((f) => f.status === "fail" || f.status === "warn"),
              })),
            }
          : report;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
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

        // Same user-defaults merge as the CLI init flow (~/.kit/defaults.toml
        // [init] services) — the two surfaces must generate the same config.
        const { applyUserInitDefaults } = await import("./user-defaults.js");
        const detected = await detectStack(workDir);
        const {
          stack,
          applied: appliedDefaults,
          unknown: unknownDefaults,
        } = applyUserInitDefaults(detected);
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
                  appliedDefaults,
                  unknownDefaults,
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
