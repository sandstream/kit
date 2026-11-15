// Changelog fragments: one file per change under `changes/`, assembled into CHANGELOG.md at
// release. Every pull request used to append to the same `## [Unreleased]` lines, so each merge
// gave every other open branch a CHANGELOG conflict and a full CI rerun. A fragment is a file of
// its own, so two pull requests never touch the same lines.
//
// A fragment is `changes/<name>.md`. It holds one or more Keep a Changelog sections, each opened
// by its heading, exactly as it will appear under `## [Unreleased]`:
//
//   ### Fixed
//
//   - **What changed.** Why, and what a reader should know.
//
// Usage:
//   node scripts/changelog-fragments.mjs check              validate every fragment
//   node scripts/changelog-fragments.mjs check --none-left  also fail if any fragment is left
//   node scripts/changelog-fragments.mjs assemble           merge fragments into [Unreleased]
//                                                           and delete them
import { readdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Keep a Changelog section order. A fragment may use only these headings. */
export const SECTIONS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

const NAME = /^[a-z0-9][a-z0-9-]*\.md$/;
const SECTION_HEADING = /^### (.+)$/;

/**
 * Parse one fragment into `{ section: body }`. Throws with a message a contributor can act on
 * when the fragment has text before its first heading, an unknown heading, or an empty section.
 */
export function parseFragment(name, text) {
  if (!NAME.test(name)) {
    throw new Error(`${name}: name must be lowercase letters, digits and dashes, ending in .md`);
  }
  const out = {};
  let current = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const m = SECTION_HEADING.exec(line);
    if (m) {
      if (!SECTIONS.includes(m[1])) {
        throw new Error(`${name}: unknown section "### ${m[1]}" (use one of ${SECTIONS.join(", ")})`);
      }
      current = m[1];
      out[current] = out[current] ?? [];
      continue;
    }
    if (current === null) {
      if (line.trim() !== "") throw new Error(`${name}: text before the first "### <Section>" heading`);
      continue;
    }
    out[current].push(line);
  }
  const sections = Object.keys(out);
  if (sections.length === 0) throw new Error(`${name}: no "### <Section>" heading`);
  const result = {};
  for (const section of sections) {
    const body = out[section].join("\n").trim();
    if (body === "") throw new Error(`${name}: section "### ${section}" is empty`);
    result[section] = body;
  }
  return result;
}

/** Read and parse every fragment in `dir`, sorted by name. A missing directory has none. */
export function readFragments(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .sort()
    .map((name) => ({ name, sections: parseFragment(name, readFileSync(join(dir, name), "utf8")) }));
}

/** Split the `## [Unreleased]` block into its preamble and `{ section: body }`. */
function splitUnreleased(block) {
  const lines = block.split("\n");
  const sections = {};
  const order = [];
  const preamble = [];
  let current = null;
  for (const line of lines) {
    const m = SECTION_HEADING.exec(line);
    if (m) {
      current = m[1];
      if (!(current in sections)) {
        sections[current] = [];
        order.push(current);
      }
      continue;
    }
    if (current === null) preamble.push(line);
    else sections[current].push(line);
  }
  return { preamble: preamble.join("\n").trim(), sections, order };
}

/**
 * Merge fragments into the `## [Unreleased]` section of `changelog`. Entries are appended to the
 * matching `### <Section>` (created in Keep a Changelog order if absent), in fragment-name order.
 */
export function assemble(changelog, fragments) {
  // A Windows checkout may have CRLF line endings; work on LF and write back what was there.
  const eol = changelog.includes("\r\n") ? "\r\n" : "\n";
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^## \[Unreleased\]/.test(l));
  if (start === -1) throw new Error("CHANGELOG.md has no `## [Unreleased]` section");
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  const { preamble, sections, order } = splitUnreleased(lines.slice(start + 1, end).join("\n"));
  const merged = {};
  for (const name of order) merged[name] = sections[name].join("\n").trim();
  for (const { sections: fragmentSections } of fragments) {
    for (const [section, body] of Object.entries(fragmentSections)) {
      merged[section] = merged[section] ? `${merged[section]}\n\n${body}` : body;
    }
  }
  const known = SECTIONS.filter((s) => s in merged);
  const unknown = order.filter((s) => !SECTIONS.includes(s));
  const blocks = [...known, ...unknown]
    .filter((s) => merged[s] !== "")
    .map((s) => `### ${s}\n\n${merged[s]}`);
  const body = [preamble, ...blocks].filter((part) => part !== "").join("\n\n");
  const rebuilt = [lines[start], "", ...(body ? [body, ""] : [])];
  return [...lines.slice(0, start), ...rebuilt, ...lines.slice(end)].join("\n").replace(/\n/g, eol);
}

function main(argv) {
  const [command, ...rest] = argv;
  const dir = "changes";
  let fragments;
  try {
    fragments = readFragments(dir);
  } catch (err) {
    console.error(`changelog fragment: ${err.message}`);
    return 1;
  }
  if (command === "check") {
    if (rest.includes("--none-left") && fragments.length > 0) {
      console.error(
        `${fragments.length} changelog fragment(s) not assembled into CHANGELOG.md: ` +
          `${fragments.map((f) => f.name).join(", ")}. Run \`node scripts/changelog-fragments.mjs assemble\`.`,
      );
      return 1;
    }
    console.log(`${fragments.length} changelog fragment(s) valid`);
    return 0;
  }
  if (command === "assemble") {
    const path = "CHANGELOG.md";
    writeFileSync(path, assemble(readFileSync(path, "utf8"), fragments));
    for (const { name } of fragments) unlinkSync(join(dir, name));
    console.log(`assembled ${fragments.length} fragment(s) into ${path}`);
    return 0;
  }
  console.error("usage: node scripts/changelog-fragments.mjs check [--none-left] | assemble");
  return 2;
}

// Only run as a CLI when invoked directly, so the test can import the helpers.
if (process.argv[1] && process.argv[1].endsWith("changelog-fragments.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
