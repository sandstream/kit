/**
 * kit-research read-where-agents-fail-vs-kit: `kit usage` counted refusals per gate only, so four
 * refusals with one cause (an unsigned scope) did not show as one wall.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { groupRefusals, reasonShape } from "./refusal-reasons.js";

describe("reasonShape", () => {
  it("reduces the reasons kit's gates write to their shape", () => {
    const cases: [string, string][] = [
      [
        "write to [REDACTED]/.claude/settings.json denied — no verified scope/RoE (unsigned, tampered, or missing); a wired fs-gate grants nothing",
        "write to <path> denied — no verified scope/RoE (…); a wired fs-gate grants nothing",
      ],
      [
        "plaintext secret (kv-secret, keyed-secret, url-query-token) written to .env",
        "plaintext secret (…) written to .env",
      ],
      [
        "host(s) outside the signed egress scope: evil.example, files.example.org",
        "host(…) outside the signed egress scope: <host>",
      ],
      [
        "cannot reduce to a triage target: indirect-bin:$pm — run `kit triage` manually, or install via `kit pkg` (fail-closed)",
        "cannot reduce to a triage target: <target> — run <…> manually, or install via <…> (…)",
      ],
    ];
    for (const [reason, shape] of cases) assert.equal(reasonShape(reason), shape, reason);
  });

  it("keeps file names, cuts at the first line, and caps the length", () => {
    assert.equal(reasonShape("blocked .kit.toml edit\nsecond line"), "blocked .kit.toml edit");
    assert.equal(reasonShape("x".repeat(300)).length, 160);
    assert.equal(reasonShape(""), "(no reason given)");
  });
});

describe("groupRefusals", () => {
  it("puts refusals that differ only in a path into one wall, most frequent first", () => {
    const fs = (path: string) => ({
      operation: "gate-fs",
      error: `write to ${path} denied — no verified scope/RoE (unsigned, tampered, or missing); a wired fs-gate grants nothing`,
    });
    const groups = groupRefusals([
      fs("/repo/.env"),
      fs("/repo/.mcp.json"),
      fs("[REDACTED]/.claude/skills/x/SKILL.md"),
      { operation: "gate-env", error: "plaintext secret (stripe-key) written to .env" },
      fs("/repo/a.ts"),
    ]);
    assert.deepEqual(
      groups.map((g) => [g.operation, g.count]),
      [
        ["gate-fs", 4],
        ["gate-env", 1],
      ],
    );
  });
});
