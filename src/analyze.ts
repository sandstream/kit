import { readFile, readdir, access, stat } from "node:fs/promises";
import { join } from "node:path";
import { detectStack, type DetectedStack } from "./stack-detector.js";
import { exec } from "./utils/exec.js";


export interface AnalysisReport {
  stack: DetectedStack;
  commitPrefixes: Array<{ prefix: string; count: number }>;
  testRunners: string[];
  ciFiles: string[];
  deployTargets: string[];
  databaseClients: string[];
  hasClaudeMd: boolean;
  hasRulesMd: boolean;
  fileCount: number;
  scriptCount: number;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function gitCommitPrefixes(
  cwd: string,
  limit = 200,
): Promise<Array<{ prefix: string; count: number }>> {
  try {
    const { stdout } = await exec(
      "git",
      ["log", `--max-count=${limit}`, "--pretty=%s"],
      { cwd, timeout: 5000 },
    );
    const counts = new Map<string, number>();
    for (const line of stdout.split("\n")) {
      // Conventional-commit prefix: word, optional scope, then `:`
      const m = line.match(/^([a-z]+)(\([^)]+\))?:/i);
      if (m) {
        const key = m[1].toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([prefix, count]) => ({ prefix, count }));
  } catch {
    return [];
  }
}

async function detectTestRunners(cwd: string): Promise<string[]> {
  const runners: string[] = [];
  const pkgPath = join(cwd, "package.json");
  if (await fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const all = { ...pkg.dependencies, ...pkg.devDependencies };
      if (all["vitest"]) runners.push("vitest");
      if (all["jest"]) runners.push("jest");
      if (all["@playwright/test"] || all["playwright"]) runners.push("playwright");
      if (all["cypress"]) runners.push("cypress");
      if (all["mocha"]) runners.push("mocha");
      if (all["ava"]) runners.push("ava");
    } catch {
      // ignore
    }
  }
  if (await fileExists(join(cwd, "pytest.ini"))) runners.push("pytest");
  if (await fileExists(join(cwd, "pyproject.toml"))) {
    try {
      const txt = await readFile(join(cwd, "pyproject.toml"), "utf-8");
      if (/pytest/.test(txt)) runners.push("pytest");
    } catch {
      // ignore
    }
  }
  if (await fileExists(join(cwd, "Cargo.toml"))) runners.push("cargo-test");
  if (await fileExists(join(cwd, "go.mod"))) runners.push("go-test");
  return runners;
}

async function detectCiFiles(cwd: string): Promise<string[]> {
  const ci: string[] = [];
  const ghDir = join(cwd, ".github", "workflows");
  if (await fileExists(ghDir)) {
    try {
      const entries = await readdir(ghDir);
      for (const e of entries) {
        if (e.endsWith(".yml") || e.endsWith(".yaml")) {
          ci.push(`.github/workflows/${e}`);
        }
      }
    } catch {
      // ignore
    }
  }
  if (await fileExists(join(cwd, ".gitlab-ci.yml"))) ci.push(".gitlab-ci.yml");
  if (await fileExists(join(cwd, "circleci", "config.yml")))
    ci.push("circleci/config.yml");
  return ci;
}

async function detectDeployTargets(cwd: string): Promise<string[]> {
  const targets: string[] = [];
  if (await fileExists(join(cwd, "vercel.json"))) targets.push("vercel");
  if (await fileExists(join(cwd, ".vercel"))) targets.push("vercel");
  if (await fileExists(join(cwd, "netlify.toml"))) targets.push("netlify");
  if (await fileExists(join(cwd, "fly.toml"))) targets.push("fly");
  if (await fileExists(join(cwd, "railway.toml"))) targets.push("railway");
  if (await fileExists(join(cwd, "render.yaml"))) targets.push("render");
  if (await fileExists(join(cwd, "wrangler.toml")) || await fileExists(join(cwd, "wrangler.jsonc")))
    targets.push("cloudflare-workers");
  if (await fileExists(join(cwd, "Dockerfile"))) targets.push("docker");
  if (await fileExists(join(cwd, "amplify.yml"))) targets.push("aws-amplify");
  if (await fileExists(join(cwd, "sst.config.ts")) || await fileExists(join(cwd, "sst.config.js")))
    targets.push("sst");
  return [...new Set(targets)];
}

async function detectDatabaseClients(cwd: string): Promise<string[]> {
  const clients: string[] = [];
  const pkgPath = join(cwd, "package.json");
  if (await fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const all = { ...pkg.dependencies, ...pkg.devDependencies };
      if (all["@prisma/client"] || all["prisma"]) clients.push("prisma");
      if (all["drizzle-orm"]) clients.push("drizzle");
      if (all["@supabase/supabase-js"]) clients.push("supabase");
      if (all["pg"] || all["postgres"]) clients.push("postgres");
      if (all["mongoose"] || all["mongodb"]) clients.push("mongodb");
      if (all["typeorm"]) clients.push("typeorm");
      if (all["kysely"]) clients.push("kysely");
    } catch {
      // ignore
    }
  }
  return [...new Set(clients)];
}

async function countFiles(cwd: string): Promise<number> {
  try {
    const { stdout } = await exec(
      "git",
      ["ls-files"],
      { cwd, timeout: 5000 },
    );
    return stdout.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function countScripts(cwd: string): Promise<number> {
  const scriptsDir = join(cwd, "scripts");
  try {
    await access(scriptsDir);
    const entries = await readdir(scriptsDir);
    let count = 0;
    for (const e of entries) {
      const st = await stat(join(scriptsDir, e));
      if (st.isFile()) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

export async function analyzeRepo(cwd: string = process.cwd()): Promise<AnalysisReport> {
  const [
    stack,
    commitPrefixes,
    testRunners,
    ciFiles,
    deployTargets,
    databaseClients,
    hasClaudeMd,
    hasRulesMd,
    fileCount,
    scriptCount,
  ] = await Promise.all([
    detectStack(cwd),
    gitCommitPrefixes(cwd),
    detectTestRunners(cwd),
    detectCiFiles(cwd),
    detectDeployTargets(cwd),
    detectDatabaseClients(cwd),
    fileExists(join(cwd, "CLAUDE.md")),
    fileExists(join(cwd, "RULES.md")),
    countFiles(cwd),
    countScripts(cwd),
  ]);

  return {
    stack,
    commitPrefixes,
    testRunners,
    ciFiles,
    deployTargets,
    databaseClients,
    hasClaudeMd,
    hasRulesMd,
    fileCount,
    scriptCount,
  };
}

export function renderClaudeMd(report: AnalysisReport): string {
  const { stack, testRunners, deployTargets, databaseClients, scriptCount } = report;
  const lines: string[] = [
    "# CLAUDE.md",
    "",
    "Project context for Claude Code and other AI coding agents.",
    "",
    "## Stack",
    "",
  ];

  const stackBits: string[] = [];
  if (stack.language !== "unknown") stackBits.push(`- **Language**: ${stack.language}`);
  if (stack.framework) stackBits.push(`- **Framework**: ${stack.framework}`);
  if (databaseClients.length) stackBits.push(`- **Database clients**: ${databaseClients.join(", ")}`);
  if (stack.services.length) stackBits.push(`- **Services**: ${stack.services.join(", ")}`);
  if (testRunners.length) stackBits.push(`- **Tests**: ${testRunners.join(", ")}`);
  if (deployTargets.length) stackBits.push(`- **Deploy**: ${deployTargets.join(", ")}`);
  lines.push(...stackBits);

  lines.push("", "## Development", "");
  const pkgManager = stack.tools["pnpm"] ? "pnpm"
    : stack.tools["yarn"] ? "yarn"
    : stack.tools["bun"] ? "bun"
    : "npm";
  lines.push(`- Install deps: \`${pkgManager} install\``);
  if (testRunners.length) {
    lines.push(`- Run tests: \`${pkgManager} test\``);
  }
  if (stack.framework === "nextjs") {
    lines.push(`- Dev server: \`${pkgManager} dev\``);
    lines.push(`- Build: \`${pkgManager} run build\``);
  }
  if (scriptCount > 0) {
    lines.push(`- Custom scripts: see \`scripts/\` (${scriptCount} file(s))`);
  }

  lines.push("", "## Conventions", "");
  if (report.commitPrefixes.length > 0) {
    lines.push("Recent commit-message prefixes (top in this repo):");
    lines.push("");
    for (const { prefix, count } of report.commitPrefixes.slice(0, 5)) {
      lines.push(`- \`${prefix}\` (${count}×)`);
    }
    lines.push("");
    lines.push(
      "Match the existing pattern when writing commit messages.",
    );
  } else {
    lines.push(
      "No conventional-commit prefixes detected. Pick a style and document it here.",
    );
  }

  lines.push("", "## Secrets & env", "");
  lines.push(
    "- Configured via `.kit.toml` (see `kit check`).",
    "- Regenerate `.env.local` with `kit secrets`.",
    "- Never commit `.env*` files; only `.env.template` is tracked.",
  );

  lines.push("", "## CI", "");
  if (report.ciFiles.length) {
    lines.push("Active workflows:");
    lines.push("");
    for (const f of report.ciFiles) lines.push(`- \`${f}\``);
  } else {
    lines.push("No CI workflows detected.");
  }

  lines.push(
    "",
    "---",
    "_Generated by `kit analyze` — edit freely; the generator only writes a draft._",
    "",
  );
  return lines.join("\n");
}

export function renderRulesMd(report: AnalysisReport): string {
  const { stack, testRunners, deployTargets } = report;
  const lines: string[] = [
    "# RULES.md",
    "",
    "Hard rules for this codebase. Agents and contributors must follow these.",
    "",
    "## Always",
    "",
    "- Run tests before committing (`kit check` runs the suite).",
    "- Use the package manager already in use; don't switch lock files.",
    "- Keep `.env*` out of git. Use `kit secrets` to materialize them locally.",
  ];
  if (deployTargets.includes("vercel")) {
    lines.push("- Production env vars live in Vercel; never hard-code keys in code.");
  }
  if (deployTargets.includes("fly") || deployTargets.includes("railway")) {
    lines.push("- Deployment platform secrets are the source of truth — sync via `kit secrets sync`.");
  }
  if (stack.framework === "nextjs") {
    lines.push("- Server-only env vars must NOT have a `NEXT_PUBLIC_` prefix.");
  }
  if (stack.services.includes("supabase")) {
    lines.push("- All Postgres tables require RLS policies. Never disable RLS.");
    lines.push("- The `service_role` key must NEVER reach the browser.");
  }
  if (stack.services.includes("stripe")) {
    lines.push("- Use test-mode keys in development; only Vercel/production has live keys.");
    lines.push("- Webhook handlers must verify the `Stripe-Signature` header.");
  }

  lines.push("", "## Never", "");
  lines.push(
    "- Commit plaintext API keys, tokens, or `.env.local`.",
    "- `git push --force` against the default branch.",
    "- Skip pre-commit hooks (`--no-verify`) unless explicitly approved.",
    "- Run destructive SQL (`DROP TABLE`, unbounded `DELETE`) without an approval gate.",
  );
  if (testRunners.length) {
    lines.push(
      "- Mark a task complete with failing tests — `" + testRunners[0] + "` must be green.",
    );
  }

  lines.push("", "## When in doubt", "");
  lines.push(
    "- Run `kit check` for a complete posture overview.",
    "- Open an issue rather than committing speculative work.",
  );

  lines.push(
    "",
    "---",
    "_Generated by `kit analyze` — edit to match team policy._",
    "",
  );
  return lines.join("\n");
}
