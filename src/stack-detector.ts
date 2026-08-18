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
    // Both bun lockfiles: `bun.lockb` (binary, ≤1.1) and `bun.lock` (text, the
    // default since 1.2). Knowing only the old name made every current bun repo
    // look like npm.
    if (await fileExists(join(cwd, "bun.lockb"))) return "bun";
    if (await fileExists(join(cwd, "bun.lock"))) return "bun";
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

/** True when the repo is a Python PACKAGE that compiles a native (C/C++/Rust) extension as
 *  part of ITS OWN build — so Python is primary and the native code is the extension. Signal:
 *  a `setup.py`, or a pyproject build-backend that compiles native code (setuptools / maturin
 *  / scikit-build / meson-python / pybind). A poetry/flit/hatchling backend (pure-Python
 *  packaging) does NOT count — there the native code is a sibling project (llama.cpp). */
async function pythonBuildsNativeExtension(cwd: string): Promise<boolean> {
  if (await fileExists(join(cwd, "setup.py"))) return true;
  const pyproject = await readFile(join(cwd, "pyproject.toml"), "utf-8").catch(() => null);
  if (!pyproject) return false;
  const backend =
    pyproject.match(/build-backend\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? "";
  return /setuptools|maturin|scikit|mesonpy|meson_python|meson-python|pybind|cffi/.test(backend);
}

async function detectFromPython(cwd: string): Promise<DetectedStack | null> {
  const hasRequirements = await fileExists(join(cwd, "requirements.txt"));
  const hasPyproject = await fileExists(join(cwd, "pyproject.toml"));
  // setup.py / setup.cfg are the legacy Python package markers — a repo can ship them with
  // no requirements.txt/pyproject (older libs, or native-extension packages).
  const hasSetup =
    (await fileExists(join(cwd, "setup.py"))) || (await fileExists(join(cwd, "setup.cfg")));
  if (!hasRequirements && !hasPyproject && !hasSetup) return null;

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

  // A composer.json alone can be a Packagist mirror of a JS lib (chart.js). Real .php
  // sources (or a framework) make it a genuine PHP project — bump confidence so the
  // selection logic treats it as a STRONG backend that beats an asset package.json
  // (phpmyadmin, filament), while a source-less mirror stays weak → JS.
  const hasPhpSources = await hasSourceExt(cwd, [".php"]);
  const services = await detectServices({ fileExists: (p) => fileExists(join(cwd, p)) });

  return {
    language: "php",
    framework,
    services,
    tools: { php: "8.3", composer: "latest" },
    confidence: framework ? 0.85 : hasPhpSources ? 0.8 : 0.6,
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

/** Shallow scan for source files with any of the given extensions, in cwd and cwd/src
 *  (one level each). Deterministic, bounded — never walks the whole tree. Used to tell
 *  siblings apart (C vs C++, Java vs Kotlin) without a full-repo crawl. */
async function hasSourceExt(cwd: string, exts: string[]): Promise<boolean> {
  const want = new Set(exts.map((e) => e.toLowerCase()));
  for (const dir of [cwd, join(cwd, "src")]) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const dot = e.name.lastIndexOf(".");
      if (dot >= 0 && want.has(e.name.slice(dot).toLowerCase())) return true;
    }
  }
  return false;
}

async function detectFromRuby(cwd: string): Promise<DetectedStack | null> {
  const gemfile = await readFile(join(cwd, "Gemfile"), "utf-8").catch(() => null);
  const hasGemspec = (await readdir(cwd).catch(() => [])).some((f) => f.endsWith(".gemspec"));
  // A bare Rakefile is NOT a Ruby signal — Go/C projects (fzf) ship one for build tasks.
  // Require a Gemfile or a .gemspec.
  if (gemfile === null && !hasGemspec) return null;

  const text = gemfile ?? "";
  let framework: string | undefined;
  if (/\brails\b/.test(text)) framework = "rails";
  else if (/\bsinatra\b/.test(text)) framework = "sinatra";
  else if (/\bjekyll\b/.test(text)) framework = "jekyll";

  const services = await detectServices({ fileExists: (p) => fileExists(join(cwd, p)) });
  return {
    language: "ruby",
    framework,
    services,
    tools: { ruby: "latest", bundler: "latest" },
    confidence: framework ? 0.85 : gemfile ? 0.75 : 0.6,
  };
}

async function detectFromDotnet(cwd: string): Promise<DetectedStack | null> {
  const entries = await readdir(cwd).catch(() => []);
  const srcEntries = await readdir(join(cwd, "src")).catch(() => []);
  const isProj = (f: string) => f.endsWith(".csproj") || f.endsWith(".sln") || f.endsWith(".slnf");
  const hasCs = entries.some(isProj) || srcEntries.some(isProj);
  const hasFs = entries.some((f) => f.endsWith(".fsproj"));
  // Big .NET repos (aspnetcore) keep their projects deep under src/, but always carry a
  // root .NET anchor — global.json / Directory.Build.props / NuGet.config.
  const hasAnchor =
    (await fileExists(join(cwd, "global.json"))) ||
    (await fileExists(join(cwd, "Directory.Build.props"))) ||
    (await fileExists(join(cwd, "NuGet.config"))) ||
    (await fileExists(join(cwd, "nuget.config")));
  if (!hasCs && !hasFs && !hasAnchor) return null;

  const services = await detectServices({ fileExists: (p) => fileExists(join(cwd, p)) });
  return {
    language: hasFs && !hasCs ? "fsharp" : "csharp",
    services,
    tools: { dotnet: "latest" },
    confidence: 0.8,
  };
}

async function detectFromJvm(cwd: string): Promise<DetectedStack | null> {
  const hasPom = await fileExists(join(cwd, "pom.xml"));
  const gradleKts = await readFile(join(cwd, "build.gradle.kts"), "utf-8").catch(() => null);
  const gradle =
    gradleKts ?? (await readFile(join(cwd, "build.gradle"), "utf-8").catch(() => null));
  const hasSettings =
    (await fileExists(join(cwd, "settings.gradle.kts"))) ||
    (await fileExists(join(cwd, "settings.gradle")));
  if (!hasPom && gradle === null && !hasSettings) return null;

  const gradleText = gradle ?? "";
  const androidPlugin = /com\.android\.(application|library)/.test(gradleText);
  // Language: Android defaults to Kotlin; otherwise pick Kotlin only on a real Kotlin
  // signal (a .kts build, the Kotlin Gradle plugin, or .kt sources) so a plain Java
  // Maven/Gradle project (spring-boot, guava, RxJava) is correctly labelled Java —
  // not Kotlin, the sibling it used to be conflated with.
  const kotlinSignal =
    gradleKts !== null ||
    /kotlin\("jvm"\)|org\.jetbrains\.kotlin|id\s+["']kotlin/.test(gradleText) ||
    (await fileExists(join(cwd, "src/main/kotlin"))) ||
    (await hasSourceExt(cwd, [".kt"]));
  const language = androidPlugin || kotlinSignal ? "kotlin" : "java";

  let framework: string | undefined;
  if (androidPlugin) framework = "android";
  else if (/org\.springframework\.boot|spring-boot/.test(gradleText)) framework = "spring";

  const tools: Record<string, string> =
    language === "kotlin" ? { kotlin: "latest" } : { java: "latest" };
  const services = await detectServices({ fileExists: (p) => fileExists(join(cwd, p)) });
  return {
    language,
    framework,
    services,
    tools,
    confidence: framework ? 0.85 : 0.7,
  };
}

async function detectFromCpp(cwd: string): Promise<DetectedStack | null> {
  // CMake/Meson are used almost exclusively for C/C++ — a definitive signal on their own,
  // even when sources live in non-standard dirs (obs-studio's libobs/, curl's lib/).
  const hasCmakeOrMeson =
    (await fileExists(join(cwd, "CMakeLists.txt"))) || (await fileExists(join(cwd, "meson.build")));
  const hasWeakBuild =
    (await fileExists(join(cwd, "Makefile"))) ||
    (await fileExists(join(cwd, "configure"))) ||
    (await fileExists(join(cwd, "configure.ac")));
  if (!hasCmakeOrMeson && !hasWeakBuild) return null;

  const isCpp = await hasSourceExt(cwd, [".cpp", ".cc", ".cxx", ".hpp", ".hh"]);
  const isC = await hasSourceExt(cwd, [".c", ".h"]);
  // A bare Makefile/configure is ambiguous (Go/asm/etc. use them too) — require actual
  // C/C++ sources. CMake/Meson stands alone; default to C++ when sources aren't at the
  // top level (CMake projects skew C++).
  if (!hasCmakeOrMeson && !isCpp && !isC) return null;

  const services = await detectServices({ fileExists: (p) => fileExists(join(cwd, p)) });
  return {
    language: isCpp ? "cpp" : isC ? "c" : "cpp",
    services,
    tools: {},
    confidence: 0.7,
  };
}

/** Lightweight manifest→language map for ecosystems kit doesn't set up deeply yet, so
 *  they detect correctly (a right answer + osv-scanner) instead of coming up `unknown`. */
const EXOTIC: { file: string; language: string }[] = [
  { file: "mix.exs", language: "elixir" },
  { file: "build.sbt", language: "scala" },
  { file: "build.zig", language: "zig" },
  { file: "v.mod", language: "v" },
  { file: "shard.yml", language: "crystal" },
  { file: "dune-project", language: "ocaml" },
  { file: "stack.yaml", language: "haskell" },
];

/** True if a real Zig SOURCE file exists (a `.zig` that isn't the `build.zig`/`build.zig.zon`
 *  build script) in cwd or cwd/src — so a C project that merely uses build.zig isn't Zig. */
async function hasZigSources(cwd: string): Promise<boolean> {
  for (const dir of [cwd, join(cwd, "src")]) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".zig") && e.name !== "build.zig") return true;
    }
  }
  return false;
}

async function detectFromExotic(cwd: string): Promise<DetectedStack | null> {
  for (const { file, language } of EXOTIC) {
    if (!(await fileExists(join(cwd, file)))) continue;
    // `build.zig` is also used as a BUILD tool by C projects (neovim) — only call it Zig
    // when actual .zig SOURCES exist (a .zig file other than the build script itself), so
    // neovim falls through to C/C++.
    if (language === "zig" && !(await hasZigSources(cwd))) continue;
    const services = await detectServices({ fileExists: (p) => fileExists(join(cwd, p)) });
    return { language, services, tools: {}, confidence: 0.7 };
  }
  // Julia: Project.toml is also used elsewhere, so require a Julia source signal.
  if ((await fileExists(join(cwd, "Project.toml"))) && (await hasSourceExt(cwd, [".jl"]))) {
    const services = await detectServices({ fileExists: (p) => fileExists(join(cwd, p)) });
    return { language: "julia", services, tools: {}, confidence: 0.7 };
  }
  return null;
}

/** JS app frameworks that mean JavaScript/TypeScript is the PRIMARY app — as opposed
 *  to a bare `react`/`vue`/`express` dep, which routinely appears as the front-end of a
 *  Rails/Django/Laravel/.NET backend. When only the latter is present alongside a backend
 *  manifest, the backend is primary (fixes polyglot masking). */
const JS_APP_FRAMEWORKS = new Set([
  "nextjs",
  "remix",
  "sveltekit",
  "astro",
  "nestjs",
  "react-native",
]);

/** Source-file extension → language, for the census fallback. JS/TS kept separate but folded
 *  via JS_FAMILY. `.h` → C (C/C++ share the family anyway). Ambiguous extensions (`.v`, `.m`,
 *  `.sc`) are omitted rather than risk a wrong call. */
const EXT_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".cs": "csharp",
  ".fs": "fsharp",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".swift": "swift",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".scala": "scala",
  ".zig": "zig",
  ".cr": "crystal",
  ".ml": "ocaml",
  ".hs": "haskell",
  ".jl": "julia",
  ".lua": "lua",
};
const JS_FAMILY = new Set(["javascript", "typescript"]);
/** Dirs that are vendored / generated / not the project's own source — excluded from the census
 *  so a JS app's `node_modules` or a Rails app's `vendor/` can't skew the language count. */
const CENSUS_SKIP = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".git",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  "third_party",
  "deps",
  ".cache",
  "coverage",
  "bin",
  "obj",
  "tmp",
  "testdata",
  "test-data",
  "fixtures",
  "__fixtures__",
  ".idea",
  ".vscode",
  "Pods",
]);

/**
 * Linguist-style source census: a BOUNDED walk of the tree counting source files per language,
 * so detection can weigh actual code volume — the way past the manifest-detection ceiling for
 * genuinely polyglot repos. File-count (not byte) for speed; vendored/generated dirs excluded;
 * capped at 6000 files / depth 10 so a giant monorepo stays fast. Returns the dominant language
 * + its share, or null if no source files were found.
 */
async function sourceCensus(cwd: string): Promise<{ top: string; share: number } | null> {
  const counts: Record<string, number> = {};
  let total = 0;
  let scanned = 0;
  const stack: { dir: string; depth: number }[] = [{ dir: cwd, depth: 0 }];
  while (stack.length > 0 && scanned < 6000) {
    const { dir, depth } = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.isDirectory()) continue;
      if (e.isDirectory()) {
        if (!CENSUS_SKIP.has(e.name) && depth < 10)
          stack.push({ dir: join(dir, e.name), depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      scanned++;
      const dot = e.name.lastIndexOf(".");
      if (dot < 0) continue;
      const lang = EXT_LANG[e.name.slice(dot).toLowerCase()];
      if (!lang) continue;
      counts[lang] = (counts[lang] ?? 0) + 1;
      total++;
    }
  }
  if (total === 0) return null;
  // Fold JS+TS so a TS app with a few .js configs isn't split under its own dominance.
  const folded: Record<string, number> = {};
  for (const [lang, n] of Object.entries(counts)) {
    const key = JS_FAMILY.has(lang) ? "typescript" : lang;
    folded[key] = (folded[key] ?? 0) + n;
  }
  let top = "";
  let topN = 0;
  for (const [lang, n] of Object.entries(folded)) {
    if (n > topN) {
      top = lang;
      topN = n;
    }
  }
  return { top, share: topN / total };
}

/** A backend signal strong enough to override a co-present `package.json`. Deliberately
 *  excludes Go/Rust/C-C++/JVM/exotic/mobile: those appear as secondary manifests inside JS
 *  projects (native addons, build tools, Packagist mirrors) too often to outrank an app's
 *  own package.json. PHP counts with a framework OR real .php sources (confidence ≥ 0.8) —
 *  a source-less composer.json (Packagist mirror of a JS lib) stays weak → JS. */
function isStrongBackend(s: DetectedStack): boolean {
  if (["python", "ruby", "csharp", "fsharp", "elixir"].includes(s.language)) return true;
  if (s.language === "php") return !!s.framework || s.confidence >= 0.8;
  return false;
}

/**
 * Detect the project stack. Multi-ecosystem aware: a repo often ships a front-end
 * `package.json` alongside its real backend (Django/Rails/Laravel/.NET), so a bare
 * package.json no longer wins by default — a STRONG backend signal takes primary unless
 * the JS side declares a real app framework. Returns `unknown` only when nothing
 * recognizable is found.
 */
export async function detectStack(cwd: string): Promise<DetectedStack> {
  const js = await detectFromPackageJson(cwd);

  // Backends in priority order — first present wins as primary among backends (matters only
  // when a repo has NO package.json but several backend manifests). Ordering principle:
  // COMPILED / systems languages first, SCRIPTING/tooling languages last — because Python
  // (build scripts + requirements.txt) and Ruby (a Rakefile/Gemfile) routinely ride along
  // inside a C/C++/Go/Rust/JVM/Scala project as tooling, not as the primary language. So:
  //  - cpp before rust  → git (Cargo.toml + a few .rs, but 200+ .c) reads as C, not Rust
  //  - cpp before dotnet → protobuf/rocksdb (CMake + a C#-bindings dir) read as C++, not C#
  //  - cpp/jvm/exotic before python → llama.cpp→C++, spark→JVM (not their Python build scripts)
  // A detector only fires on a REAL signal (cpp needs C/C++ sources or CMake; rust needs
  // Cargo), so a pure Python/Ruby repo still wins — the compiled detectors simply decline.
  const backends = (
    await Promise.all([
      detectFromGo(cwd),
      detectFromJvm(cwd),
      detectFromExotic(cwd),
      detectFromCpp(cwd),
      detectFromRust(cwd),
      detectFromDotnet(cwd),
      detectFromPython(cwd),
      detectFromPhp(cwd),
      detectFromRuby(cwd),
      detectFromFlutter(cwd),
      detectFromSwift(cwd),
    ])
  ).filter((s): s is DetectedStack => s !== null);

  // Native-Python-extension override. The compiled-first ordering above correctly reads a
  // C++/Rust project that merely ships Python *scripts* (llama.cpp) as C++. But a Python
  // *package that compiles a native extension* (Pillow, matplotlib, pyca/cryptography) is
  // Python-primary — the C/Rust is the extension, not the product. Tell them apart by the
  // Python build system: a native build backend (setup.py / setuptools / maturin /
  // scikit-build / meson-python) means "this Python package builds the native code", whereas
  // llama.cpp's poetry/flit backend packages a pure-Python sibling and CMake builds the C++.
  const pyIdx = backends.findIndex((b) => b.language === "python");
  if (pyIdx > 0 && ["c", "cpp", "rust"].includes(backends[0].language)) {
    if (await pythonBuildsNativeExtension(cwd)) {
      const [py] = backends.splice(pyIdx, 1);
      backends.unshift(py);
    }
  }

  if (js) {
    // JS is primary when it's a real app (meta-framework). Otherwise a co-present backend
    // wins ONLY if it's a STRONG signal — a real backend app, not a secondary manifest a
    // JS project routinely carries (a Packagist `composer.json`, a native-addon `Cargo.toml`,
    // a tooling `go.mod`). Strong = Python/Ruby/.NET/Elixir, or PHP with a framework
    // (Laravel/Symfony ⇒ artisan). This fixes django/rails/laravel/aspnetcore without
    // regressing chart.js (composer mirror) or pnpm (Rust addon) → both stay JS.
    if (js.framework && JS_APP_FRAMEWORKS.has(js.framework)) return js;
    const strong = backends.find(isStrongBackend);
    if (strong) return strong;
    // No strong backend and not a JS app framework: the package.json may be an asset/tooling
    // manifest of a repo whose real code (and manifest) live in subdirs (a Ruby/Rails monorepo
    // like spree). Consult a source census — if another language clearly dominates the actual
    // code, trust that over the bare package.json. (chart.js / pnpm: JS dominates → stays JS.)
    const census = await sourceCensus(cwd);
    if (census && !JS_FAMILY.has(census.top) && census.share >= 0.5) {
      return { language: census.top, services: js.services, tools: {}, confidence: 0.6 };
    }
    return js;
  }
  if (backends.length > 0) return backends[0];

  // No recognized manifest at all — fall back to a source census (fixes manifest-less repos
  // like a classic no-composer WordPress tree). Any real language beats `unknown`.
  const census = await sourceCensus(cwd);
  if (census) return { language: census.top, services: [], tools: {}, confidence: 0.55 };

  return { language: "unknown", services: [], tools: {}, confidence: 0.0 };
}
