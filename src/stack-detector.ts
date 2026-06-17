import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

export interface DetectedStack {
  language: string;
  framework?: string;
  services: string[];
  tools: Record<string, string>;
  confidence: number; // 0.0–1.0
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
  engines?: { node?: string };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, "utf-8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function hasDep(pkg: PackageJson, name: string): boolean {
  return !!(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
}

function nodeVersion(pkg: PackageJson): string {
  const engines = pkg.engines?.node;
  if (engines) {
    const match = engines.match(/(\d+)/);
    if (match) return match[1];
  }
  return "22";
}

function detectPackageManager(pkg: PackageJson, cwd: string): Promise<string> {
  if (pkg.packageManager?.startsWith("pnpm")) return Promise.resolve("pnpm");
  if (pkg.packageManager?.startsWith("yarn")) return Promise.resolve("yarn");
  if (pkg.packageManager?.startsWith("bun")) return Promise.resolve("bun");
  // Check for lockfiles
  return (async () => {
    if (await fileExists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
    if (await fileExists(join(cwd, "yarn.lock"))) return "yarn";
    if (await fileExists(join(cwd, "bun.lockb"))) return "bun";
    return "npm";
  })();
}

// Service = matched if any dep is present OR any marker file exists. Order here
// is the order services are reported. Adding a service is one row, not a new if.
const SERVICE_DETECTORS: { service: string; deps?: string[]; files?: string[] }[] = [
  { service: "stripe", deps: ["stripe"] },
  { service: "supabase", deps: ["@supabase/supabase-js"], files: ["supabase"] },
  { service: "prisma", deps: ["prisma", "@prisma/client"] },
  { service: "resend", deps: ["resend"] },
  { service: "clerk", deps: ["@clerk/nextjs", "@clerk/clerk-react"] },
  { service: "drizzle", deps: ["drizzle-orm"] },
  { service: "liveblocks", deps: ["liveblocks", "@liveblocks/client"] },
  { service: "trigger", deps: ["@trigger.dev/sdk", "trigger.dev"] },
  { service: "inngest", deps: ["inngest"] },
  { service: "vercel", deps: ["@vercel/analytics", "vercel"], files: ["vercel.json"] },
  { service: "expo", files: [".expo"] },
  {
    service: "sentry",
    deps: ["@sentry/nextjs", "@sentry/node", "@sentry/react", "@sentry/svelte", "@sentry/astro", "@sentry/remix"],
  },
  { service: "typeorm", deps: ["typeorm", "@nestjs/typeorm"] },
  { service: "mongoose", deps: ["mongoose", "@nestjs/mongoose"] },
  { service: "netlify", files: ["netlify.toml"] },
  { service: "cloudflare-pages", files: ["wrangler.toml"] },
];

// Framework = first match wins (priority order: meta-frameworks before their base).
const FRAMEWORK_DETECTORS: { framework: string; deps: string[] }[] = [
  { framework: "nextjs", deps: ["next"] },
  { framework: "remix", deps: ["@remix-run/node", "@remix-run/react"] },
  { framework: "astro", deps: ["astro"] },
  { framework: "sveltekit", deps: ["@sveltejs/kit"] },
  { framework: "nestjs", deps: ["@nestjs/core"] },
  { framework: "express", deps: ["express"] },
  { framework: "react", deps: ["react"] },
  { framework: "vue", deps: ["vue"] },
];

async function detectFromPackageJson(cwd: string): Promise<DetectedStack | null> {
  const pkg = await readJson<PackageJson>(join(cwd, "package.json"));
  if (!pkg) return null;

  const node = nodeVersion(pkg);
  const pm = await detectPackageManager(pkg, cwd);
  const tools: Record<string, string> = { node };
  if (pm !== "npm") tools[pm] = "latest";

  const services: string[] = [];

  // Detect services by dependency or marker file (table-driven; preserves order).
  for (const d of SERVICE_DETECTORS) {
    const byDep = d.deps?.some((dep) => hasDep(pkg, dep)) ?? false;
    let byFile = false;
    for (const file of d.files ?? []) {
      if (await fileExists(join(cwd, file))) {
        byFile = true;
        break;
      }
    }
    if (byDep || byFile) services.push(d.service);
  }

  // Framework — first match wins (priority order in FRAMEWORK_DETECTORS).
  let framework: string | undefined;
  for (const fw of FRAMEWORK_DETECTORS) {
    if (fw.deps.some((dep) => hasDep(pkg, dep))) {
      framework = fw.framework;
      break;
    }
  }

  const confidence = framework ? 0.9 : 0.6;

  return {
    language: "typescript",
    framework,
    services,
    tools,
    confidence,
  };
}

async function detectFromPython(cwd: string): Promise<DetectedStack | null> {
  const hasRequirements = await fileExists(join(cwd, "requirements.txt"));
  const hasPyproject = await fileExists(join(cwd, "pyproject.toml"));
  if (!hasRequirements && !hasPyproject) return null;

  let framework: string | undefined;
  let contents = "";

  if (hasRequirements) {
    contents = await readFile(join(cwd, "requirements.txt"), "utf-8").catch(() => "");
  }
  if (hasPyproject) {
    contents += await readFile(join(cwd, "pyproject.toml"), "utf-8").catch(() => "");
  }

  if (/fastapi/i.test(contents)) framework = "fastapi";
  else if (/django/i.test(contents)) framework = "django";
  else if (/flask/i.test(contents)) framework = "flask";

  return {
    language: "python",
    framework,
    services: [],
    tools: { python: "3.12", uv: "latest" },
    confidence: framework ? 0.85 : 0.5,
  };
}

async function detectFromGo(cwd: string): Promise<DetectedStack | null> {
  const goMod = await readFile(join(cwd, "go.mod"), "utf-8").catch(() => null);
  if (!goMod) return null;

  let framework: string | undefined;
  if (/github\.com\/gin-gonic\/gin/.test(goMod)) framework = "gin";
  else if (/github\.com\/labstack\/echo/.test(goMod)) framework = "echo";
  else if (/github\.com\/gofiber\/fiber/.test(goMod)) framework = "fiber";

  return {
    language: "go",
    framework,
    services: [],
    tools: { go: "1.22" },
    confidence: framework ? 0.85 : 0.7,
  };
}

async function detectFromRust(cwd: string): Promise<DetectedStack | null> {
  const cargoToml = await readFile(join(cwd, "Cargo.toml"), "utf-8").catch(() => null);
  if (!cargoToml) return null;

  let framework: string | undefined;
  if (/axum/.test(cargoToml)) framework = "axum";
  else if (/actix/.test(cargoToml)) framework = "actix";
  else if (/rocket/.test(cargoToml)) framework = "rocket";

  return {
    language: "rust",
    framework,
    services: [],
    tools: { rust: "latest" },
    confidence: framework ? 0.85 : 0.7,
  };
}

async function detectFromPhp(cwd: string): Promise<DetectedStack | null> {
  const composer = await readJson<{ require?: Record<string, string> }>(
    join(cwd, "composer.json")
  );
  if (!composer) return null;

  let framework: string | undefined;
  if (composer.require?.["laravel/framework"]) framework = "laravel";
  else if (composer.require?.["symfony/framework-bundle"]) framework = "symfony";

  return {
    language: "php",
    framework,
    services: [],
    tools: { php: "8.3", composer: "latest" },
    confidence: framework ? 0.85 : 0.6,
  };
}

/**
 * Detect the project stack from files in the given directory.
 * Returns null only if no recognizable project files are found.
 */
export async function detectStack(cwd: string): Promise<DetectedStack> {
  // Try detection in priority order — first match wins
  const result =
    (await detectFromPackageJson(cwd)) ??
    (await detectFromPython(cwd)) ??
    (await detectFromGo(cwd)) ??
    (await detectFromRust(cwd)) ??
    (await detectFromPhp(cwd));

  if (result) return result;

  // Unknown project — return minimal fallback
  return {
    language: "unknown",
    services: [],
    tools: {},
    confidence: 0.0,
  };
}
