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

describe("reasonShape: a version is not a host", () => {
  // kit-research audit-year-evidence-vs-kit: `kit usage` printed npm's "version 1.3.0 is
  // DEPRECATED" refusal as "version <host> is DEPRECATED".
  it("shapes dotted version numbers as <version>", () => {
    assert.equal(
      reasonShape("left-pad: version 1.3.0 is DEPRECATED"),
      "left-pad: version <version> is DEPRECATED",
    );
    assert.equal(reasonShape("needs v2.1 or 1.0.0-beta.1"), "needs <version> or <version>");
    assert.equal(reasonShape("cooling: 16.0.0 was published"), "cooling: <version> was published");
  });

  it("still shapes IPv4 addresses and host names as <host>", () => {
    assert.equal(reasonShape("connect to 10.0.0.1:8080 refused"), "connect to <host>:<n> refused");
    assert.equal(reasonShape("egress to 192.168.1.255 denied"), "egress to <host> denied");
    assert.equal(reasonShape("egress to 10.0.0.1.nip.io denied"), "egress to <host> denied");
    assert.equal(reasonShape("egress to evil.example denied"), "egress to <host> denied");
    assert.equal(reasonShape("egress to api.v1.example.com denied"), "egress to <host> denied");
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
