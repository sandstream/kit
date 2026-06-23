import { readFile, access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { detectServices } from "./service-registry.js";

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
  workspaces?: string[] | { packages?: string[] };
  volta?: { node?: string };
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

/** Expand a workspace glob. Supports exact paths and a single trailing `/*`
 *  (one directory level) — covers the common `apps/*` / `packages/*` layouts;
 *  deeper globs are rare for stack detection and fall back to no match. */
async function expandWorkspaceGlob(cwd: string, pattern: string): Promise<string[]> {
  if (!pattern.includes("*")) return [pattern];
  const base = pattern.replace(/\/?\*+$/, "");
  try {
    const entries = await readdir(join(cwd, base), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => (base ? `${base}/${e.name}` : e.name));
  } catch {
    return [];
  }
}

/** Monorepo support: union the dependencies of every workspace member so a
 *  turborepo whose `next`/`stripe`/etc. live in `apps/*` is detected from the
 *  root, instead of coming up empty. Reads `package.json#workspaces` and
 *  `pnpm-workspace.yaml`. Returns [] for a non-workspace repo. */
async function collectWorkspaceDeps(cwd: string, pkg: PackageJson): Promise<string[]> {
  const globs: string[] = [];
  if (Array.isArray(pkg.workspaces)) globs.push(...pkg.workspaces);
  else if (pkg.workspaces?.packages) globs.push(...pkg.workspaces.packages);

  const pnpmWs = await readFile(join(cwd, "pnpm-workspace.yaml"), "utf-8").catch(() => null);
  if (pnpmWs) {
    for (const m of pnpmWs.matchAll(/^\s*-\s*['"]?([^'"\n]+?)['"]?\s*$/gm)) globs.push(m[1].trim());
  }
  if (globs.length === 0) return [];

  const deps = new Set<string>();
  for (const g of globs) {
    for (const dir of await expandWorkspaceGlob(cwd, g)) {
      const member = await readJson<PackageJson>(join(cwd, dir, "package.json"));
      if (member) {
        for (const k of Object.keys({ ...member.dependencies, ...member.devDependencies }))
          deps.add(k);
      }
    }
  }
  return [...deps];
}

/** Resolve the Node major to pin, respecting the repo's existing truth.
 *  Precedence: .tool-versions > Volta > .node-version / .nvmrc > engines.node > 22.
 *  (Respecting these avoids installing the wrong runtime, the #1 brownfield trap.) */
async function resolveNodeVersion(cwd: string, pkg: PackageJson): Promise<string> {
  const toolVersions = await readFile(join(cwd, ".tool-versions"), "utf-8").catch(() => null);
  if (toolVersions) {
    const m = toolVersions.match(/^\s*nodejs?\s+v?(\d+)/m);
    if (m) return m[1];
  }
  if (pkg.volta?.node) {
    const m = pkg.volta.node.match(/(\d+)/);
    if (m) return m[1];
  }
  for (const f of [".node-version", ".nvmrc"]) {
    const c = await readFile(join(cwd, f), "utf-8").catch(() => null);
    if (c) {
      const m = c.match(/v?(\d+)/);
      if (m) return m[1];
    }
  }
  if (pkg.engines?.node) {
    const m = pkg.engines.node.match(/(\d+)/);
    if (m) return m[1];
  }
  return "22";
}

/** Resolve the Python minor to pin: .python-version > .tool-versions > 3.12. */
async function resolvePythonVersion(cwd: string): Promise<string> {
  const pv = await readFile(join(cwd, ".python-version"), "utf-8").catch(() => null);
  if (pv) {
    const m = pv.match(/(\d+\.\d+)/);
    if (m) return m[1];
  }
  const tv = await readFile(join(cwd, ".tool-versions"), "utf-8").catch(() => null);
  if (tv) {
    const m = tv.match(/^\s*python\s+v?(\d+\.\d+)/m);
    if (m) return m[1];
  }
  return "3.12";
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

// Service detection now lives in the data-driven SERVICE_REGISTRY (service-registry.ts),
// shared with the generator and matched across languages via detectServices().

// Framework = first match wins (priority order: meta-frameworks before their base).
const FRAMEWORK_DETECTORS: { framework: string; deps: string[] }[] = [
  { framework: "nextjs", deps: ["next"] },
  { framework: "remix", deps: ["@remix-run/node", "@remix-run/react"] },
  { framework: "astro", deps: ["astro"] },
  { framework: "sveltekit", deps: ["@sveltejs/kit"] },
  { framework: "nestjs", deps: ["@nestjs/core"] },
  { framework: "express", deps: ["express"] },
  // react-native before react: an RN app depends on both, RN is the real story.
  { framework: "react-native", deps: ["react-native"] },
  { framework: "react", deps: ["react"] },
  { framework: "vue", deps: ["vue"] },
];

async function detectFromPackageJson(cwd: string): Promise<DetectedStack | null> {
  const pkg = await readJson<PackageJson>(join(cwd, "package.json"));
  if (!pkg) return null;

  const node = await resolveNodeVersion(cwd, pkg);
  const pm = await detectPackageManager(pkg, cwd);
  const tools: Record<string, string> = { node };
  if (pm !== "npm") tools[pm] = "latest";

  // Union root deps with workspace-member deps so monorepos (turborepo, pnpm
  // workspaces) whose framework/services live in apps/* or packages/* are not
  // detected as an empty root.
  const rootDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const deps = [...new Set([...rootDeps, ...(await collectWorkspaceDeps(cwd, pkg))])];
  const services = await detectServices({
    deps,
    fileExists: (p) => fileExists(join(cwd, p)),
  });

  // Framework — first match wins (priority order in FRAMEWORK_DETECTORS).
  let framework: string | undefined;
  for (const fw of FRAMEWORK_DETECTORS) {
    if (fw.deps.some((dep) => deps.includes(dep))) {
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

  const services = await detectServices({
    pyText: contents,
    fileExists: (p) => fileExists(join(cwd, p)),
  });

  return {
    language: "python",
    framework,
    services,
    tools: { python: await resolvePythonVersion(cwd), uv: "latest" },
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

  const services = await detectServices({
    goMod,
    fileExists: (p) => fileExists(join(cwd, p)),
  });

  return {
    language: "go",
    framework,
    services,
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

  const services = await detectServices({ fileExists: (p) => fileExists(join(cwd, p)) });

  return {
    language: "rust",
    framework,
    services,
    tools: { rust: "latest" },
    confidence: framework ? 0.85 : 0.7,
  };
}

async function detectFromPhp(cwd: string): Promise<DetectedStack | null> {
  const composer = await readJson<{ require?: Record<string, string> }>(join(cwd, "composer.json"));
  if (!composer) return null;

  let framework: string | undefined;
  if (composer.require?.["laravel/framework"]) framework = "laravel";
  else if (composer.require?.["symfony/framework-bundle"]) framework = "symfony";

  const services = await detectServices({ fileExists: (p) => fileExists(join(cwd, p)) });

  return {
    language: "php",
    framework,
    services,
    tools: { php: "8.3", composer: "latest" },
    confidence: framework ? 0.85 : 0.6,
  };
}

async function detectFromFlutter(cwd: string): Promise<DetectedStack | null> {
  const pubspec = await readFile(join(cwd, "pubspec.yaml"), "utf-8").catch(() => null);
  if (pubspec === null) return null;

  // pubspec.yaml is also used by pure-Dart packages; "flutter:" / sdk: flutter
  // marks an actual Flutter app.
  const framework = /flutter/i.test(pubspec) ? "flutter" : undefined;
  const services = await detectServices({ fileExists: (p) => fileExists(join(cwd, p)) });

  return {
    language: "dart",
    framework,
    services,
    tools: {},
    confidence: framework ? 0.9 : 0.7,
  };
}

async function detectFromSwift(cwd: string): Promise<DetectedStack | null> {
  const hasPackage = await fileExists(join(cwd, "Package.swift"));
  const hasPodfile = await fileExists(join(cwd, "Podfile"));
  if (!hasPackage && !hasPodfile) return null;

  // Podfile (CocoaPods) is an iOS-app signal; bare Package.swift can also be
  // server-side Swift (Vapor), so it stays framework-less.
  const framework = hasPodfile ? "ios" : undefined;
  const services = await detectServices({ fileExists: (p) => fileExists(join(cwd, p)) });

  return {
    language: "swift",
    framework,
    services,
    tools: {},
    confidence: hasPodfile ? 0.85 : 0.7,
  };
}

async function detectFromAndroid(cwd: string): Promise<DetectedStack | null> {
  const gradle =
    (await readFile(join(cwd, "build.gradle.kts"), "utf-8").catch(() => null)) ??
    (await readFile(join(cwd, "build.gradle"), "utf-8").catch(() => null));
  const hasSettings =
    (await fileExists(join(cwd, "settings.gradle.kts"))) ||
    (await fileExists(join(cwd, "settings.gradle")));
  if (gradle === null && !hasSettings) return null;

  // Only call it Android when the Android Gradle plugin is applied; otherwise
  // it's a generic JVM/Gradle project (label the language, not a mobile framework).
  const framework =
    gradle && /com\.android\.(application|library)/.test(gradle) ? "android" : undefined;
  const services = await detectServices({ fileExists: (p) => fileExists(join(cwd, p)) });

  return {
    language: "kotlin",
    framework,
    services,
    tools: {},
    confidence: framework ? 0.85 : 0.6,
  };
}

/**
 * Detect the project stack from files in the given directory.
 * Returns null only if no recognizable project files are found.
 */
export async function detectStack(cwd: string): Promise<DetectedStack> {
  // Try detection in priority order — first match wins. Node first (RN/Expo apps
  // carry package.json); native-mobile detectors are reached only when none of
  // the language manifests above them matched.
  const result =
    (await detectFromPackageJson(cwd)) ??
    (await detectFromPython(cwd)) ??
    (await detectFromGo(cwd)) ??
    (await detectFromRust(cwd)) ??
    (await detectFromPhp(cwd)) ??
    (await detectFromFlutter(cwd)) ??
    (await detectFromSwift(cwd)) ??
    (await detectFromAndroid(cwd));

  if (result) return result;

  // Unknown project — return minimal fallback
  return {
    language: "unknown",
    services: [],
    tools: {},
    confidence: 0.0,
  };
}
