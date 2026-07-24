// Extract one version's section from CHANGELOG.md, for use as GitHub release
// notes (#385). The publish workflow pipes this into `gh release create`, so a
// release always carries the real changelog rather than the bare tag message.
//
// Usage: node scripts/changelog-section.mjs 5.10.0 [path/to/CHANGELOG.md]
//
// Exits non-zero when the version has no section — a release with empty notes is
// a silent documentation hole, so the workflow should fail loudly instead.
import { readFileSync } from "node:fs";

const HEADING = /^## \[?(\d+\.\d+\.\d+[^\]\s]*)\]?/;

/**
 * Return the body of `version`'s section: everything after its heading, up to
 * (not including) the next version heading. Trailing blank lines are trimmed.
 */
export function extractSection(changelog, version) {
  const lines = changelog.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]);
    if (!m) continue;
    if (start === -1) {
      if (m[1] === version) start = i + 1;
      continue;
    }
    // First heading after ours closes the section.
    return lines.slice(start, i).join("\n").trim();
  }
  if (start === -1) return null;
  return lines.slice(start).join("\n").trim();
}

/** Release notes = the section plus verification pointers. */
export function renderNotes(section, tag) {
  return [
    section,
    "",
    "---",
    "",
    `Full changelog: https://github.com/sandstream/kit/blob/${tag}/CHANGELOG.md`,
    "",
    "Verify this release:",
    "```",
    `git tag -v ${tag}`,
    "npm audit signatures",
    "```",
    "",
  ].join("\n");
}

// Only run as a CLI when invoked directly, so the test can import the helpers.
if (process.argv[1] && process.argv[1].endsWith("changelog-section.mjs")) {
  const version = process.argv[2];
  const path = process.argv[3] ?? "CHANGELOG.md";
  if (!version) {
    console.error("usage: node scripts/changelog-section.mjs <version> [changelog]");
    process.exit(2);
  }
  const section = extractSection(readFileSync(path, "utf8"), version);
  if (!section) {
    console.error(`no CHANGELOG section found for ${version} in ${path}`);
    process.exit(1);
  }
  process.stdout.write(renderNotes(section, `v${version}`));
}
