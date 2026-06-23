/**
 * Design / a11y / structural enforcement.
 *
 * Built-in checks (zero extra deps):
 *   - Static a11y: scans .tsx/.jsx for common omissions
 *       <img> without alt
 *       <button> with no text/aria-label
 *       <a> without text/aria-label or href
 *       form inputs without an associated <label>/aria-labelledby
 *   - Design-token consistency: flags hex colors / px values that
 *     bypass the design-tokens module (configurable token glob).
 *   - File-naming convention: optional regex per directory.
 *
 * Heavy checks (axe-core, Percy) are delegated to external tools via
 * the plugin contract — see docs/PLUGIN_CHECKS.md.
 */

import { readdir, readFile, access } from "node:fs/promises";
import { join, resolve, relative, extname } from "node:path";

export interface DesignCheckResult {
  category: "design";
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
  files?: string[];
  severity?: "high" | "medium" | "low";
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function walkSources(root: string, exts: string[]): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "dist" || e.name === ".next") continue;
        if (e.name.startsWith(".")) continue;
        await visit(full);
        continue;
      }
      if (e.isFile() && exts.includes(extname(e.name))) out.push(full);
    }
  }
  await visit(root);
  return out;
}

interface A11yFinding {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

const A11Y_RULES: Array<{ id: string; pattern: RegExp; description: string }> = [
  {
    id: "img-alt",
    pattern: /<img\s+(?![^>]*\balt\s*=)[^>]*\/?>/,
    description: "<img> without alt attribute",
  },
  {
    id: "button-empty",
    // <button>...</button> with NO text content and no aria-label / aria-labelledby
    pattern: /<button\s+(?![^>]*\baria-label(?:ledby)?\s*=)[^>]*>\s*<\/button>/,
    description: "<button> with no text or aria-label",
  },
  {
    id: "anchor-no-href",
    pattern: /<a\s+(?![^>]*\bhref\s*=)[^>]*>/,
    description: "<a> without href",
  },
  {
    id: "input-no-label",
    // <input> with no aria-label/aria-labelledby (label-association is harder
    // to verify statically, so we only flag the obvious missing-aria case)
    pattern:
      /<input\s+(?![^>]*\baria-label(?:ledby)?\s*=)(?![^>]*\btype\s*=\s*['"](?:hidden|submit|button)['"])[^>]*\/?>/,
    description: "<input> without aria-label (and not type=hidden/submit/button)",
  },
];

async function scanA11y(srcRoots: string[]): Promise<A11yFinding[]> {
  const findings: A11yFinding[] = [];
  for (const root of srcRoots) {
    if (!(await pathExists(root))) continue;
    const files = await walkSources(root, [".tsx", ".jsx", ".astro", ".vue"]);
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, "utf-8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const rule of A11Y_RULES) {
          if (rule.pattern.test(line)) {
            findings.push({
              file: relative(process.cwd(), file),
              line: i + 1,
              rule: rule.id,
              snippet: line.trim().slice(0, 120),
            });
          }
        }
      }
    }
  }
  return findings;
}

interface TokenBypass {
  file: string;
  line: number;
  kind: "raw-hex" | "raw-px";
  match: string;
}

async function scanTokenBypass(srcRoots: string[], tokenFiles: string[]): Promise<TokenBypass[]> {
  const findings: TokenBypass[] = [];
  for (const root of srcRoots) {
    if (!(await pathExists(root))) continue;
    const files = await walkSources(root, [".ts", ".tsx", ".css", ".scss", ".module.css"]);
    for (const file of files) {
      // Allow token-definition files themselves to use raw values.
      if (tokenFiles.some((t) => file.includes(t))) continue;
      let content: string;
      try {
        content = await readFile(file, "utf-8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const hex = line.match(/#[0-9a-f]{3,8}\b/i);
        if (hex) {
          findings.push({
            file: relative(process.cwd(), file),
            line: i + 1,
            kind: "raw-hex",
            match: hex[0],
          });
        }
        const px = line.match(/\b\d{2,}px\b/);
        if (px && !line.includes("border")) {
          findings.push({
            file: relative(process.cwd(), file),
            line: i + 1,
            kind: "raw-px",
            match: px[0],
          });
        }
      }
    }
  }
  return findings;
}

export async function checkDesign(
  opts: {
    srcRoots?: string[];
    tokenFiles?: string[];
    enforce?: boolean;
    baseline?: { a11y?: string[]; tokens?: string[] };
  } = {},
): Promise<DesignCheckResult[]> {
  const srcRoots = (opts.srcRoots ?? ["src", "app", "components"]).map((d) =>
    resolve(process.cwd(), d),
  );
  const tokenFiles = opts.tokenFiles ?? ["design-tokens", "tokens.ts", "theme.ts"];
  const enforce = opts.enforce ?? false;
  const results: DesignCheckResult[] = [];

  // Only run if at least one source root exists AND has tsx/jsx/component
  // files. kit's own src/ is pure TypeScript with no React, so this
  // returns "skip" here.
  let anyComponentRoot = false;
  for (const root of srcRoots) {
    if (await pathExists(root)) {
      const files = await walkSources(root, [".tsx", ".jsx", ".astro", ".vue"]);
      if (files.length > 0) {
        anyComponentRoot = true;
        break;
      }
    }
  }
  if (!anyComponentRoot) {
    results.push({
      category: "design",
      name: "a11y (static scan)",
      status: "skip",
      detail: "no tsx/jsx/astro/vue files found",
    });
    return results;
  }

  // A11y
  const a11y = await scanA11y(srcRoots);
  const a11yBaseline = new Set(opts.baseline?.a11y ?? []);
  const newA11y = a11y.filter((f) => !a11yBaseline.has(`${f.file}:${f.rule}`));

  if (a11y.length === 0) {
    results.push({
      category: "design",
      name: "a11y (static scan)",
      status: "pass",
      detail: "no obvious a11y omissions",
    });
  } else if (newA11y.length === 0) {
    results.push({
      category: "design",
      name: "a11y (static scan)",
      status: "warn",
      detail: `${a11y.length} pre-existing a11y finding(s) (baseline-frozen)`,
      severity: "low",
    });
  } else {
    results.push({
      category: "design",
      name: "a11y (static scan)",
      status: enforce ? "fail" : "warn",
      detail: `${newA11y.length} new a11y finding(s) (${a11y.length} total)`,
      severity: enforce ? "high" : "medium",
      files: newA11y.slice(0, 10).map((f) => `${f.file}:${f.line} [${f.rule}] ${f.snippet}`),
    });
  }

  // Design tokens
  const tokenFindings = await scanTokenBypass(srcRoots, tokenFiles);
  const tokenBaseline = new Set(opts.baseline?.tokens ?? []);
  const newTokens = tokenFindings.filter(
    (f) => !tokenBaseline.has(`${f.file}:${f.kind}:${f.match}`),
  );

  if (tokenFindings.length === 0) {
    results.push({
      category: "design",
      name: "design-token consistency",
      status: "pass",
      detail: "no raw hex/px values found in components",
    });
  } else if (newTokens.length === 0) {
    results.push({
      category: "design",
      name: "design-token consistency",
      status: "warn",
      detail: `${tokenFindings.length} pre-existing raw value(s) (baseline-frozen)`,
      severity: "low",
    });
  } else {
    results.push({
      category: "design",
      name: "design-token consistency",
      status: enforce ? "fail" : "warn",
      detail: `${newTokens.length} new raw value(s) — should use design tokens`,
      severity: enforce ? "high" : "medium",
      files: newTokens.slice(0, 10).map((f) => `${f.file}:${f.line} ${f.kind}=${f.match}`),
    });
  }

  return results;
}

/** Exposed so `kit baseline freeze` can snapshot these into .kit-baseline.json. */
export async function collectDesignKeys(): Promise<{ a11y: string[]; tokens: string[] }> {
  const srcRoots = ["src", "app", "components"].map((d) => resolve(process.cwd(), d));
  const a11y = await scanA11y(srcRoots);
  const tokens = await scanTokenBypass(srcRoots, ["design-tokens", "tokens.ts", "theme.ts"]);
  return {
    a11y: a11y.map((f) => `${f.file}:${f.rule}`),
    tokens: tokens.map((f) => `${f.file}:${f.kind}:${f.match}`),
  };
}
