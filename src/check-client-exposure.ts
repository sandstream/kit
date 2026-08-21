/**
 * What reaches the browser, checked deterministically.
 *
 * kit covers credentials that were **committed** (trufflehog over history, the staged-file scan)
 * and `.env` hygiene. Neither sees the failure mode that costs the most: a `VITE_*` or
 * `NEXT_PUBLIC_*` variable holding a real secret is inlined into `dist/` at build time and then
 * sits in every visitor's browser — without ever being committed. `.gitignore` does not protect
 * against it, history scanning cannot see it, and the value is public the moment the site deploys.
 *
 * Two checks, deliberately deterministic rather than clever:
 *
 *   1. **By name.** A client-exposed prefix plus a secret-shaped name is a leak by construction:
 *      the framework will inline it, so the only question is whether the value was meant to be
 *      public. Conventionally-public names are known and excluded (a Stripe publishable key, a
 *      Supabase anon key, a reCAPTCHA site key, a Sentry DSN); anything else needs an explicit
 *      allowlist entry in `.kit.toml` carrying the reason.
 *
 *   2. **By content.** The built output is scanned for real credential shapes. This catches the
 *      case the name check cannot: a key hardcoded in source, which never went through env at all.
 *      The scanner for this already existed (`scanBuildArtifacts`, reachable from
 *      `kit security scan-build`) and was not part of any automatic verdict — so `kit check` never
 *      looked at build output, which is where the leak actually lands.
 *
 * Only names are read from `.env*` files. A check that reports on secrets must not handle their
 * values, and it does not need them: the prefix decides exposure, not the content.
 */

import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";

import type { SecurityCheckResult } from "./check-security.js";

/**
 * Prefixes whose variables the framework inlines into the client bundle. Each is a documented
 * build-time convention, not a guess: Vite (`VITE_`), Next.js (`NEXT_PUBLIC_`), Astro/SvelteKit
 * (`PUBLIC_`), Create React App (`REACT_APP_`), Expo (`EXPO_PUBLIC_`), Nuxt (`NUXT_PUBLIC_`),
 * Gatsby (`GATSBY_`), Vue CLI (`VUE_APP_`), Storybook (`STORYBOOK_`).
 */
export const CLIENT_PREFIXES = [
  "VITE_",
  "NEXT_PUBLIC_",
  "PUBLIC_",
  "REACT_APP_",
  "EXPO_PUBLIC_",
  "NUXT_PUBLIC_",
  "GATSBY_",
  "VUE_APP_",
  "STORYBOOK_",
] as const;

/** Words that make a name secret-shaped. `_KEY` is included; see CONVENTIONALLY_PUBLIC for why that alone is not enough. */
const SENSITIVE_WORD = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|_KEY\b|APIKEY|API_KEY)/;

/**
 * Names that are secret-shaped and genuinely public by design.
 *
 * This list is the difference between a check people keep and a check people disable. `KEY` alone
 * matches `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` — the two most
 * common client env vars in existence, both meant to be public. Flagging those on day one is how a
 * security check gets switched off before it ever catches the real leak.
 */
const CONVENTIONALLY_PUBLIC =
  /(PUBLISHABLE|ANON_KEY|SITE_KEY|_DSN\b|CLIENT_ID|MEASUREMENT_ID|PUBLIC_KEY|VAPID_PUBLIC|APP_ID)/;

export type NameVerdict = "leak" | "public-by-convention" | "not-client-exposed";

/** Classify one env var NAME. No value is read, and none is needed. */
export function classifyClientName(name: string): NameVerdict {
  const upper = name.toUpperCase();
  if (!CLIENT_PREFIXES.some((p) => upper.startsWith(p))) return "not-client-exposed";
  if (!SENSITIVE_WORD.test(upper)) return "not-client-exposed";
  if (CONVENTIONALLY_PUBLIC.test(upper)) return "public-by-convention";
  return "leak";
}

/**
 * Env var names declared anywhere in the repo's `.env*` files.
 *
 * `.env.example` counts: a placeholder named `VITE_STRIPE_SECRET_KEY` is a template telling the
 * next developer to put a secret somewhere the browser will read it. The name is the defect.
 */
export async function collectEnvNames(root: string): Promise<Map<string, string[]>> {
  const byName = new Map<string, string[]>();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return byName;
  }
  for (const file of entries.filter((f) => f === ".env" || f.startsWith(".env."))) {
    let text: string;
    try {
      text = await readFile(join(root, file), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      // The name only. Everything right of `=` is deliberately dropped, here, at the parse.
      const name = trimmed
        .slice(0, eq)
        .replace(/^export\s+/, "")
        .trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      byName.set(name, [...(byName.get(name) ?? []), file]);
    }
  }
  return byName;
}

const NAME_CHECK = "client-exposed env names";

/**
 * A client-exposed variable whose name says "secret" fails.
 *
 * `fail`, not `warn`: the framework will inline it, so this is not a posture question. The escape
 * hatch is an allowlist entry that must carry a reason — an allowlist without one is itself
 * reported, because "someone allowed this once" is not a reason anybody can audit later.
 */
export async function checkClientExposedNames(
  root: string,
  allow: Record<string, string> = {},
  extraNames: string[] = [],
): Promise<SecurityCheckResult> {
  const base: Omit<SecurityCheckResult, "status" | "detail"> = {
    category: "exposure",
    name: NAME_CHECK,
  };

  const declared = await collectEnvNames(root);
  for (const name of extraNames)
    if (!declared.has(name)) declared.set(name, ["[secrets] in .kit.toml"]);

  if (declared.size === 0) {
    return {
      ...base,
      status: "skip",
      detail: "no .env* files or declared keys to read names from",
    };
  }

  const leaks: string[] = [];
  const allowedWithoutReason: string[] = [];
  for (const [name, sources] of declared) {
    if (classifyClientName(name) !== "leak") continue;
    const reason = allow[name];
    if (reason === undefined) {
      leaks.push(`${name} (${sources.join(", ")})`);
    } else if (reason.trim().length === 0) {
      allowedWithoutReason.push(name);
    }
  }

  if (leaks.length > 0) {
    return {
      ...base,
      status: "fail",
      severity: "high",
      detail: `${leaks.length} client-exposed name(s) declare a secret: ${leaks.slice(0, 3).join("; ")}${leaks.length > 3 ? `; +${leaks.length - 3}` : ""} — a build inlines these into the bundle`,
      suggestion:
        "Rename to drop the client prefix and read it server-side, or — if the value really is public — allow it with the reason:\n" +
        "  [scan.client_exposed_allow]\n" +
        `  ${leaks[0].split(" ")[0]} = "why this is safe to publish"`,
    };
  }

  if (allowedWithoutReason.length > 0) {
    return {
      ...base,
      status: "warn",
      severity: "low",
      detail: `${allowedWithoutReason.length} allowlisted name(s) carry no reason: ${allowedWithoutReason.join(", ")}`,
      suggestion: "Give each entry a sentence saying why the value is safe to publish.",
    };
  }

  const exposed = [...declared.keys()].filter(
    (n) => classifyClientName(n) === "public-by-convention",
  );
  return {
    ...base,
    status: "pass",
    detail:
      exposed.length > 0
        ? `${declared.size} declared name(s); ${exposed.length} client-exposed and public by convention`
        : `${declared.size} declared name(s), none client-exposed with a secret-shaped name`,
  };
}

const BUNDLE_CHECK = "built bundle secrets";

/**
 * Packages whose presence means this project builds something a browser downloads.
 *
 * The gate matters: kit's own `dist/` is a compiled Node CLI, and scanning it produced 73
 * "credential shapes" — every one a test fixture or one of kit's own detection patterns. A check
 * that fails on the repo that ships it is a check nobody keeps. `webpack` is deliberately absent:
 * plenty of server bundles use it, and the frameworks below are unambiguous.
 */
const CLIENT_FRAMEWORKS = [
  "next",
  "vite",
  "react-scripts",
  "@sveltejs/kit",
  "nuxt",
  "astro",
  "expo",
  "gatsby",
  "@vue/cli-service",
  "@angular/core",
  "@remix-run/react",
  "parcel",
];

async function frameworkIn(dir: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    return CLIENT_FRAMEWORKS.find((f) => declared.has(f)) ?? null;
  } catch {
    return null;
  }
}

/** A place in this repo that builds something a browser downloads. `dir` is relative to the root. */
export interface ClientBuild {
  framework: string;
  dir: string;
}

/**
 * Every client build in the repo, including the ones in workspace packages.
 *
 * The root manifest is not where the framework lives in a monorepo. Measured on a real repo: the
 * root declares workspaces and no framework, `apps/web` declares vite and holds the `dist/` that
 * ships — so a root-only check reported "nothing here builds for a browser" about a repo that
 * builds for a browser. That is the same false green as scanning the wrong directory, one level in.
 */
export async function detectClientBuilds(root: string): Promise<ClientBuild[]> {
  const builds: ClientBuild[] = [];
  const atRoot = await frameworkIn(root);
  if (atRoot) builds.push({ framework: atRoot, dir: "" });

  for (const rel of await candidatePackageDirs(root)) {
    const framework = await frameworkIn(join(root, rel));
    if (framework) builds.push({ framework, dir: rel });
  }
  return builds;
}

/** Directories that never hold a package of the operator's own. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  ".venv",
  "target",
  "vendor",
]);

/**
 * Where a workspace package might live: the `workspaces` globs first, since they are the repo's own
 * declaration, then immediate child directories as a fallback for repos that lay packages out
 * without declaring them. Only `dir/*` globs are expanded — that is the shape npm/yarn/pnpm
 * workspaces actually use, and a full glob engine here would be more machinery than the question
 * deserves.
 */
async function candidatePackageDirs(root: string): Promise<string[]> {
  const dirs = new Set<string>();

  let globs: string[] = [];
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8")) as {
      workspaces?: string[] | { packages?: string[] };
    };
    globs = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
  } catch {
    /* no manifest, or not JSON */
  }

  for (const glob of globs) {
    if (!glob.includes("*")) {
      dirs.add(glob.replace(/\/+$/, ""));
      continue;
    }
    const parent = glob.slice(0, glob.indexOf("*")).replace(/\/+$/, "");
    try {
      for (const e of await readdir(join(root, parent), { withFileTypes: true })) {
        if (e.isDirectory() && !IGNORED_DIRS.has(e.name)) {
          dirs.add(parent ? `${parent}/${e.name}` : e.name);
        }
      }
    } catch {
      /* declared but absent */
    }
  }

  try {
    for (const e of await readdir(root, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".") && !IGNORED_DIRS.has(e.name)) dirs.add(e.name);
    }
  } catch {
    /* unreadable root */
  }

  return [...dirs].sort();
}

/**
 * Compiled tests and mocks are not shipped credentials.
 *
 * A fixture that contains `ghp_1234…` exists precisely so a scanner can be tested against it, and
 * flagging it teaches the operator that the check cries wolf.
 */
export function isTestArtifact(file: string): boolean {
  return (
    /(^|[\\/])(__tests__|__mocks__|fixtures)[\\/]/.test(file) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
  );
}

/** Build-output directories worth scanning, matching what the bundlers actually emit. */
const BUILD_DIRS = [
  ".next",
  "dist",
  "build",
  "out",
  ".vercel/output",
  ".svelte-kit",
  ".nuxt",
  ".output",
];

/**
 * Scan the built output for credential shapes.
 *
 * When there is no build output, this is a `skip` that says so — a build that has not run is not a
 * clean bundle, and reporting it as a pass would be the false green this whole area keeps producing.
 */
export async function checkBuiltBundleSecrets(root: string): Promise<SecurityCheckResult> {
  const base: Omit<SecurityCheckResult, "status" | "detail"> = {
    category: "exposure",
    name: BUNDLE_CHECK,
  };

  const builds = await detectClientBuilds(root);
  if (builds.length === 0) {
    return {
      ...base,
      status: "skip",
      detail:
        "no client framework in package.json (or its workspaces) — nothing builds for a browser",
    };
  }
  const framework = [...new Set(builds.map((b) => b.framework))].join("+");

  const present: string[] = [];
  for (const build of builds) {
    for (const dir of BUILD_DIRS) {
      const rel = build.dir ? `${build.dir}/${dir}` : dir;
      try {
        await access(join(root, rel));
        present.push(rel);
      } catch {
        /* not built here */
      }
    }
  }
  if (present.length === 0) {
    return {
      ...base,
      status: "skip",
      detail: `${framework} project(s) present but not built (no dist/, .next/, …) — run the build, then re-check`,
    };
  }

  const { scanBuildArtifacts } = await import("./scan-build.js");
  let hits: Awaited<ReturnType<typeof scanBuildArtifacts>>;
  try {
    hits = await scanBuildArtifacts(root, present);
  } catch (e) {
    // A scan that crashed is not a clean scan: didNotRun makes the CI gate treat it as such.
    return {
      ...base,
      status: "fail",
      severity: "medium",
      didNotRun: true,
      detail: `bundle scan could not run: ${(e as Error).message.slice(0, 80)}`,
    };
  }

  const shipped = hits.filter((h) => !isTestArtifact(h.file));
  const excluded = hits.length - shipped.length;
  const aside = excluded > 0 ? ` (${excluded} test fixture(s) not counted)` : "";

  if (shipped.length === 0) {
    return {
      ...base,
      status: "pass",
      detail: `no credential shapes in ${present.join(", ")} [${framework}]${aside}`,
    };
  }

  hits = shipped;
  const total = hits.reduce((n, h) => n + h.findings.length, 0);
  return {
    ...base,
    status: "fail",
    severity: "critical",
    detail: `${total} credential shape(s) in built output [${framework}]${aside}: ${hits
      .slice(0, 3)
      .map((h) => h.file)
      .join(", ")}${hits.length > 3 ? `; +${hits.length - 3} file(s)` : ""}`,
    files: hits.map((h) => h.file),
    suggestion:
      "Anything in the bundle is public. Rotate the credential, then move the read server-side — removing it from the build is not enough once it has shipped.",
  };
}
