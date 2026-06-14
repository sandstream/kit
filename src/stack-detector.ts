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

async function detectFromPackageJson(cwd: string): Promise<DetectedStack | null> {
  const pkg = await readJson<PackageJson>(join(cwd, "package.json"));
  if (!pkg) return null;

  const node = nodeVersion(pkg);
  const pm = await detectPackageManager(pkg, cwd);
  const tools: Record<string, string> = { node };
  if (pm !== "npm") tools[pm] = "latest";

  const services: string[] = [];

  // Detect services by dependencies
  if (hasDep(pkg, "stripe")) services.push("stripe");
  if (hasDep(pkg, "@supabase/supabase-js") || (await fileExists(join(cwd, "supabase")))) {
    services.push("supabase");
  }
  if (hasDep(pkg, "prisma") || hasDep(pkg, "@prisma/client")) {
    services.push("prisma");
  }
  if (hasDep(pkg, "resend")) services.push("resend");
  if (hasDep(pkg, "@clerk/nextjs") || hasDep(pkg, "@clerk/clerk-react")) {
    services.push("clerk");
  }
  if (hasDep(pkg, "drizzle-orm")) services.push("drizzle");
  if (hasDep(pkg, "liveblocks") || hasDep(pkg, "@liveblocks/client")) {
    services.push("liveblocks");
  }
  if (hasDep(pkg, "@trigger.dev/sdk") || hasDep(pkg, "trigger.dev")) {
    services.push("trigger");
  }
  if (hasDep(pkg, "inngest")) services.push("inngest");
  if (
    hasDep(pkg, "@vercel/analytics") ||
    hasDep(pkg, "vercel") ||
    (await fileExists(join(cwd, "vercel.json")))
  ) {
    services.push("vercel");
  }
  if (await fileExists(join(cwd, ".expo"))) services.push("expo");

  // Sentry — any @sentry/* package
  if (
    hasDep(pkg, "@sentry/nextjs") ||
    hasDep(pkg, "@sentry/node") ||
    hasDep(pkg, "@sentry/react") ||
    hasDep(pkg, "@sentry/svelte") ||
    hasDep(pkg, "@sentry/astro") ||
    hasDep(pkg, "@sentry/remix")
  ) {
    services.push("sentry");
  }

  // NestJS specific: TypeORM, Mongoose
  if (hasDep(pkg, "typeorm") || hasDep(pkg, "@nestjs/typeorm")) {
    services.push("typeorm");
  }
  if (hasDep(pkg, "mongoose") || hasDep(pkg, "@nestjs/mongoose")) {
    services.push("mongoose");
  }

  // Netlify / Cloudflare Pages via config files
  if (await fileExists(join(cwd, "netlify.toml"))) services.push("netlify");
  if (await fileExists(join(cwd, "wrangler.toml"))) services.push("cloudflare-pages");

  // Detect framework
  let framework: string | undefined;
  if (hasDep(pkg, "next")) {
    framework = "nextjs";
  } else if (hasDep(pkg, "@remix-run/node") || hasDep(pkg, "@remix-run/react")) {
    framework = "remix";
  } else if (hasDep(pkg, "astro")) {
    framework = "astro";
  } else if (hasDep(pkg, "@sveltejs/kit")) {
    framework = "sveltekit";
  } else if (hasDep(pkg, "@nestjs/core")) {
    framework = "nestjs";
  } else if (hasDep(pkg, "express")) {
    framework = "express";
  } else if (hasDep(pkg, "react")) {
    framework = "react";
  } else if (hasDep(pkg, "vue")) {
    framework = "vue";
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
