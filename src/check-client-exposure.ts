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

/**
 * A `@sensitive` annotation in a `.env*` comment, borrowed from varlock's `.env.schema`
 * decorators (`@sensitive`, `@sensitive=false`).
 *
 * WHY THIS EXISTS. `SENSITIVE_WORD` above INFERS sensitivity from the identifier, and a name is
 * not a declaration. Measured against the built classifier, three real client-exposed credentials
 * come back `not-client-exposed` purely because of how they were spelled:
 *
 *     VITE_TWILIO_AUTH        no listed word ("AUTH" is not in SENSITIVE_WORD)
 *     VITE_OPENAI_SK          abbreviated
 *     NEXT_PUBLIC_DB_DSN      `_DSN` is in CONVENTIONALLY_PUBLIC (Sentry's public DSN), but a
 *                             database DSN carries a password
 *
 * Those are FALSE NEGATIVES in a security check — the direction that matters. The heuristic stays
 * as the floor for repos that annotate nothing; a declaration, where present, wins over it.
 */
const SENSITIVE_ANNOTATION = /@sensitive(?:\s*=\s*(true|false))?\b/i;

/**
 * Read a `@sensitive` annotation out of one comment or trailing comment.
 * `@sensitive` / `@sensitive=true` -> true, `@sensitive=false` -> false, absent -> undefined.
 * Pure.
 */
export function parseSensitiveAnnotation(text: string): boolean | undefined {
  const m = SENSITIVE_ANNOTATION.exec(text);
  if (!m) return undefined;
  return m[1] === undefined ? true : m[1].toLowerCase() === "true";
}

/**
 * Classify one env var NAME. No value is read, and none is needed.
 *
 * `declaredSensitive` is the author's `@sensitive` annotation when they wrote one. Declared beats
 * inferred; inferred beats nothing:
 *   - `true`      -> `leak` on a client-prefixed name, whatever it is called. Catches the three
 *                    false negatives above.
 *   - `false`     -> `public-by-convention`. An explicit, greppable, reviewable opt-out, which is
 *                    strictly better than the same var passing silently because of its spelling.
 *   - `undefined` -> the name heuristic, unchanged. Nothing regresses for repos that annotate
 *                    nothing.
 *
 * A name with no client prefix is still `not-client-exposed` even when declared sensitive: a
 * server-side secret is not a bundle leak, and this check is only about the bundle.
 */
export function classifyClientName(name: string, declaredSensitive?: boolean): NameVerdict {
  const upper = name.toUpperCase();
  if (!CLIENT_PREFIXES.some((p) => upper.startsWith(p))) return "not-client-exposed";
  if (declaredSensitive !== undefined) return declaredSensitive ? "leak" : "public-by-convention";
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
  const decls = await collectEnvDeclarations(root);
  return new Map([...decls].map(([name, d]) => [name, d.sources]));
}

/** One declared env var: where it was seen, and the author's `@sensitive` annotation if any. */
export interface EnvDeclaration {
  /** The `.env*` files that declare this name, in read order. */
  sources: string[];
  /** The author's `@sensitive` annotation. `undefined` when they wrote none. */
  sensitive?: boolean;
}

interface ParsedEnvDeclarationLine {
  pending?: boolean;
  name?: string;
  sensitive?: boolean;
}

function parseEnvDeclarationLine(line: string, pending?: boolean): ParsedEnvDeclarationLine {
  const trimmed = line.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("#")) {
    return { pending: parseSensitiveAnnotation(trimmed) ?? pending };
  }
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return {};
  const name = trimmed
    .slice(0, eq)
    .replace(/^export\s+/, "")
    .trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return {};
  const hash = trimmed.indexOf("#", eq);
  const trailing = hash >= 0 ? parseSensitiveAnnotation(trimmed.slice(hash)) : undefined;
  return { name, sensitive: trailing ?? pending };
}

function collectDeclarationsFromText(
  byName: Map<string, EnvDeclaration>,
  file: string,
  text: string,
): void {
  let pending: boolean | undefined;
  for (const line of text.split("\n")) {
    const parsed = parseEnvDeclarationLine(line, pending);
    pending = parsed.pending;
    if (!parsed.name) continue;
    const prev = byName.get(parsed.name);
    byName.set(parsed.name, {
      sources: [...(prev?.sources ?? []), file],
      sensitive: prev?.sensitive ?? parsed.sensitive,
    });
  }
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Env var names declared anywhere in the repo's `.env*` files, with any `@sensitive` annotation.
 *
 * An annotation attaches to a var when it is written on the preceding comment line(s) or trailing
 * the declaration itself — both forms people actually use:
 *
 *     # @sensitive
 *     VITE_TWILIO_AUTH=
 *     VITE_OPENAI_SK=          # @sensitive
 *     NEXT_PUBLIC_MAP_STYLE=   # @sensitive=false
 *
 * Values are still never read: the trailing form is parsed from the comment, and the annotation is
 * a boolean, not content. The first annotation wins if a name is declared in several files, so a
 * later `.env.local` cannot silently downgrade one declared sensitive in `.env.example`.
 */
export async function collectEnvDeclarations(root: string): Promise<Map<string, EnvDeclaration>> {
  const byName = new Map<string, EnvDeclaration>();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return byName;
  }
  for (const file of entries.filter((f) => f === ".env" || f.startsWith(".env."))) {
    const text = await readOptionalText(join(root, file));
    if (text !== undefined) collectDeclarationsFromText(byName, file, text);
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

  const declared = await collectEnvDeclarations(root);
  for (const name of extraNames)
    if (!declared.has(name)) declared.set(name, { sources: ["[secrets] in .kit.toml"] });

  if (declared.size === 0) {
    return {
      ...base,
      status: "skip",
      detail: "no .env* files or declared keys to read names from",
    };
  }

  const leaks: string[] = [];
  const allowedWithoutReason: string[] = [];
  for (const [name, { sources, sensitive }] of declared) {
    if (classifyClientName(name, sensitive) !== "leak") continue;
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

  const exposed = [...declared].filter(
    ([n, d]) => classifyClientName(n, d.sensitive) === "public-by-convention",
  );
  // Say what the green covers. Un-annotated names are judged by SPELLING, so a pass is a
  // statement about names, not about values — the same honesty `tierNotice` adds to `kit check`.
  const annotated = [...declared.values()].filter((d) => d.sensitive !== undefined).length;
  const scope =
    annotated === declared.size
      ? "every name carries a @sensitive annotation"
      : `${declared.size - annotated} judged by name only — add \`# @sensitive\` to declare rather than infer`;
  return {
    ...base,
    status: "pass",
    detail:
      exposed.length > 0
        ? `${declared.size} declared name(s); ${exposed.length} client-exposed and public by convention (${scope})`
        : `${declared.size} declared name(s), none client-exposed with a secret-shaped name (${scope})`,
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
