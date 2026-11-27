/**
 * One list of package-runner launches, read by both twins of the pinned test: `kit agent-audit`
 * (`src/agent-audit-mcp-launch.ts`) and `kit triage skill` (`skills/triage/scripts/plugin_scan.py`).
 *
 * kit-research `auto-ontology-vs-kit`: both called a spec pinned when the text after its last `@`
 * started with a digit. `uvx --from auto-ontology-mcp==1.3.0` (an exact PyPI pin) read unpinned, a
 * git source pinned by a full commit that starts with a letter read unpinned, and a branch whose
 * name starts with a digit (`@2026-dev`) read pinned.
 *
 * Each case: command, args, and what the unpinned warning shows (`runner spec`), or null when the
 * launch is pinned.
 */
const SHA = "f3a9c1d2e4b5a6978877665544332211aabbccdd";

export const PIN_CASES: [string, string[], string | null][] = [
  // PyPI: `==` is an exact pin; `>=` and `~=` are ranges. `--from` names the package.
  ["uvx", ["--from", "auto-ontology-mcp==1.3.0", "auto-ontology-mcp"], null],
  ["uvx", ["--from=auto-ontology-mcp==1.3.0", "auto-ontology-mcp"], null],
  [
    "uvx",
    ["--from", "auto-ontology-mcp>=1.3.0", "auto-ontology-mcp"],
    "uvx auto-ontology-mcp>=1.3.0",
  ],
  ["uvx", ["--from", "x~=1.3", "x"], "uvx x~=1.3"],
  ["uvx", ["x@0.3.0"], null],
  ["uvx", ["x@latest"], "uvx x@latest"],
  ["uvx", ["--python", "3.12", "mcp-server-fetch"], "uvx mcp-server-fetch"],
  // git: only a full commit is a pin, whatever its first character.
  ["uvx", ["--from", `git+https://github.com/o/r.git@${SHA}`, "r"], null],
  [
    "uvx",
    ["--from", "git+https://github.com/o/r.git@2026-dev", "r"],
    "uvx git+https://github.com/o/r.git@2026-dev",
  ],
  [
    "uvx",
    ["--from", "git+https://github.com/o/r.git@1a2b3c4", "r"],
    "uvx git+https://github.com/o/r.git@1a2b3c4",
  ],
  ["npx", ["-y", `github:o/r#${SHA}`], null],
  ["npx", ["-y", "github:o/r#main"], "npx github:o/r#main"],
  // npm: an exact semver, not a range or a tag.
  ["npx", ["-y", "@scope/x@1.2.3"], null],
  ["npx", ["-p", "x@1.2.3", "x-cli"], null],
  ["npx", ["-y", "x@^1.2.3"], "npx x@^1.2.3"],
  ["npx", ["-y", "x@1"], "npx x@1"],
  ["npx", ["-y", "x@2026-dev"], "npx x@2026-dev"],
  ["npx", ["-y", "x@latest"], "npx x@latest"],
];
