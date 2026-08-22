/**
 * Generate docs/CONFIGURATION.md from the declared configuration surface.
 *
 * The table in src/config-surface.ts is the single source; this script only renders it. Writing the
 * reference by hand is what produced the state this replaces — 23 sections, six with no description
 * anywhere, two mentioned in no document at all.
 *
 * Byte-idempotent by construction: running it twice, or running it after a no-op change, must
 * produce zero diff. A generated file whose regeneration is noisy is a file nobody regenerates, and
 * then it is a hardcoded table wearing a generator's hat (see scripts/derive-command-flags.mjs,
 * where that lesson cost a misread 512-line diff).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "CONFIGURATION.md");

/**
 * Read the section table out of the compiled surface.
 *
 * Importing the built module rather than parsing the TypeScript keeps this honest: the doc is
 * rendered from exactly what the CLI loads.
 */
async function sections() {
  const mod = await import(join(ROOT, "dist", "config-surface.js"));
  return mod.CONFIG_SECTIONS;
}

export async function render() {
  const table = await sections();
  const names = Object.keys(table).sort();

  const lines = [
    "# Configuration",
    "",
    "**GENERATED** from `src/config-surface.ts` — run `node scripts/gen-config-doc.mjs` after adding a",
    "section. `config-surface.test.ts` fails when a section exists in `kitConfig` and not in that table,",
    "and when the table describes a section kit no longer has, so this reference cannot drift from the",
    "code in either direction.",
    "",
    "Everything below lives in `.kit.toml` at the project root. `kit config sections` prints the same",
    "list in the terminal, marking which ones this repo already declares.",
    "",
    `kit accepts **${names.length} sections**.`,
    "",
    "| Section | What it configures | Set up with |",
    "| --- | --- | --- |",
  ];

  for (const name of names) {
    const s = table[name];
    // This file lives IN docs/, so a `docs/X.md` path is a sibling — not `../docs/X.md`.
    const rel = (p) => p.replace(/^docs\//, "");
    const setup = s.command ? "`" + s.command + "`" : s.docs ? `[docs](${rel(s.docs)})` : "—";
    lines.push(`| [\`[${name}]\`](#${name}) | ${s.purpose} | ${setup} |`);
  }

  for (const name of names) {
    const s = table[name];
    lines.push("", `## ${name}`, "", s.purpose, "", `**What it buys.** ${s.buys}`, "", "```toml");
    for (const line of s.example.split("\n")) lines.push(line);
    lines.push("```");
    const refs = [];
    if (s.command) refs.push("Set up with `" + s.command + "`.");
    if (s.docs) refs.push(`Fuller treatment: [\`${s.docs}\`](${s.docs.replace(/^docs\//, "")}).`);
    if (refs.length > 0) lines.push("", refs.join(" "));
  }

  lines.push("");
  return lines.join("\n");
}

async function main() {
  const text = await render();
  const previous = (() => {
    try {
      return readFileSync(OUT, "utf-8");
    } catch {
      return null;
    }
  })();
  if (previous === text) {
    console.log("docs/CONFIGURATION.md already current");
    return;
  }
  writeFileSync(OUT, text, "utf-8");
  console.log(`wrote docs/CONFIGURATION.md — ${Object.keys(await sections()).length} sections`);
}

if (process.argv[1] && process.argv[1].endsWith("gen-config-doc.mjs")) await main();
