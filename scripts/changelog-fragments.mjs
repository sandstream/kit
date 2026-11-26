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
//
// A patch release is bug fixes only (CHANGELOG.md, "Semantic Versioning"). `assemble` refuses to
// put an `### Added` entry under [Unreleased] while package.json names a patch version, and
// `check --none-left`, which the publish job runs before `npm publish`, refuses a patch version
// whose `## [X.Y.Z]` section has `### Added`. Only the version being released is checked, so
// patch sections already published keep their history.
import { readdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fixOfFixLine } from "./fix-of-fix.mjs";

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

const PATCH_VERSION = /^\d+\.\d+\.[1-9]\d*$/;

/** True for a plain X.Y.Z with Z > 0. A prerelease (`-rc.1`) or an X.Y.0 is not a patch. */
export function isPatchVersion(version) {
  return PATCH_VERSION.test(version);
}

/** The `### <Section>` headings under `## [name]` in `changelog`, or null when it has no such section. */
export function sectionHeadings(changelog, name) {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${name}]`));
  if (start === -1) return null;
  const headings = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    const m = SECTION_HEADING.exec(line);
    if (m) headings.push(m[1]);
  }
  return headings;
}

/** Why `version` may not ship notes with these headings, or null when it may. */
export function patchAddsFeatures(version, headings) {
  if (!isPatchVersion(version) || !headings.includes("Added")) return null;
  return (
    `${version} is a patch release, and a patch release is bug fixes only (CHANGELOG.md, ` +
    `"Semantic Versioning"), but its notes have "### Added". Bump the minor version in ` +
    `package.json, or leave the feature's fragment under changes/ for the next minor release.`
  );
}

/** package.json's version, or "" when there is no package.json (no rule to apply). */
function packageVersion() {
  if (!existsSync("package.json")) return "";
  return String(JSON.parse(readFileSync("package.json", "utf8")).version ?? "");
}

function checkReleaseSection() {
  const version = packageVersion();
  const headings = sectionHeadings(readFileSync("CHANGELOG.md", "utf8"), version);
  const refusal = headings && patchAddsFeatures(version, headings);
  if (refusal) console.error(refusal);
  return refusal ? 1 : 0;
}

function assembleCommand(dir, fragments) {
  const path = "CHANGELOG.md";
  const next = assemble(readFileSync(path, "utf8"), fragments);
  const refusal = patchAddsFeatures(packageVersion(), sectionHeadings(next, "Unreleased") ?? []);
  if (refusal) {
    console.error(`not assembled: ${refusal}`);
    return 1;
  }
  writeFileSync(path, next);
  for (const { name } of fragments) unlinkSync(join(dir, name));
  console.log(`assembled ${fragments.length} fragment(s) into ${path}`);
  console.log(fixOfFixLine("."));
  return 0;
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
    if (rest.includes("--none-left") && checkReleaseSection() !== 0) return 1;
    console.log(`${fragments.length} changelog fragment(s) valid`);
    return 0;
  }
  if (command === "assemble") return assembleCommand(dir, fragments);
  console.error("usage: node scripts/changelog-fragments.mjs check [--none-left] | assemble");
  return 2;
}

// Only run as a CLI when invoked directly, so the test can import the helpers.
if (process.argv[1] && process.argv[1].endsWith("changelog-fragments.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
