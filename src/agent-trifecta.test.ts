import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legsOf, parseAgentTools, runAgentTrifecta, shown } from "./agent-trifecta.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

describe("legsOf", () => {
  it("a web tool is untrusted input and a way out", () => {
    const l = legsOf(["WebFetch"]);
    assert.ok(l.vector.length > 0 && l.egress.length > 0);
    assert.equal(l.payload.length, 0);
  });

  it("an unrestricted Bash holds all three legs", () => {
    for (const g of ["Bash", "Bash(*)", "*"]) {
      const l = legsOf([g]);
      assert.ok(l.vector.length && l.payload.length && l.egress.length, g);
    }
  });

  it("a narrow Bash grant holds none of them", () => {
    const l = legsOf(["Bash(git status)", "Bash(npm test)"]);
    assert.deepEqual([l.vector, l.payload, l.egress], [[], [], []]);
  });

  it("a network command in a Bash grant is a way out and a way in", () => {
    const l = legsOf(["Bash(curl https://example.com)"]);
    assert.ok(l.vector.length && l.egress.length);
  });

  it("reading files is private data only when it is not scoped to source", () => {
    assert.ok(legsOf(["Read"]).payload.length > 0);
    assert.ok(legsOf(["Read(./.env)"]).payload.length > 0);
    assert.equal(legsOf(["Read(./src/**)"]).payload.length, 0);
  });

  it("writing files alone is none of the three", () => {
    const l = legsOf(["Edit", "Write"]);
    assert.deepEqual([l.vector, l.payload, l.egress], [[], [], []]);
  });

  it("classifies MCP servers by family and lists the ones it cannot place", () => {
    assert.ok(legsOf(["mcp__slack__post_message"]).egress.length > 0);
    assert.ok(legsOf(["mcp__supabase__execute_sql"]).payload.length > 0);
    const l = legsOf(["mcp__frobnicator__run"]);
    assert.deepEqual(l.unknown, ["mcp__frobnicator__run"]);
    assert.deepEqual([l.vector, l.payload, l.egress], [[], [], []]);
  });
});

describe("parseAgentTools", () => {
  it("reads a comma list, a yaml list, and an absent field", () => {
    assert.deepEqual(parseAgentTools("---\nname: a\ntools: Read, Grep, WebFetch\n---\nbody"), [
      "Read",
      "Grep",
      "WebFetch",
    ]);
    assert.deepEqual(
      parseAgentTools("---\nname: a\ntools:\n  - Read\n  - Bash(git status)\n---\n"),
      ["Read", "Bash(git status)"],
    );
    assert.equal(parseAgentTools("---\nname: a\n---\nbody"), null);
    assert.equal(parseAgentTools("no frontmatter"), null);
  });
});

const project = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "kit-tri-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
};
const home = mkdtempSync(join(tmpdir(), "kit-tri-home-"));

describe("runAgentTrifecta", () => {
  it("warns separately when the main session can edit without confirmation", () => {
    const root = project({
      ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Edit"] } }),
    });
    try {
      const rows = runAgentTrifecta(root, home);
      const write = rows.find((r) => r.name === "write access without confirmation: main session");
      assert.equal(write?.status, "warn");
      assert.match(write?.detail ?? "", /Edit/);
      assert.ok(rows.every((r) => !r.name.startsWith("lethal trifecta: main session")));
    } finally {
      rmTemp(root);
    }
  });

  it("warns when acceptEdits approves file edits without a prompt", () => {
    const root = project({
      ".claude/settings.json": JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
    });
    try {
      const rows = runAgentTrifecta(root, home);
      const write = rows.find((r) => r.name === "write access without confirmation: main session");
      assert.equal(write?.status, "warn");
      assert.match(write?.detail ?? "", /Edit/);
    } finally {
      rmTemp(root);
    }
  });

  it("does not call an Edit allow rule prompt-free when ask overrides it", () => {
    const root = project({
      ".claude/settings.json": JSON.stringify({
        permissions: { allow: ["Edit"], ask: ["Edit"] },
      }),
    });
    try {
      const rows = runAgentTrifecta(root, home);
      assert.ok(rows.every((r) => !r.name.startsWith("write access without confirmation")));
    } finally {
      rmTemp(root);
    }
  });

  it("does not warn about file edits in plan mode", () => {
    const root = project({
      ".claude/settings.json": JSON.stringify({
        permissions: { defaultMode: "plan", allow: ["Edit"] },
      }),
    });
    try {
      const rows = runAgentTrifecta(root, home);
      assert.ok(rows.every((r) => !r.name.startsWith("write access without confirmation")));
    } finally {
      rmTemp(root);
    }
  });

  it("still warns for filesystem commands when ask requires a prompt for Edit", () => {
    const root = project({
      ".claude/settings.json": JSON.stringify({
        permissions: { defaultMode: "acceptEdits", ask: ["Edit"] },
      }),
    });
    try {
      const rows = runAgentTrifecta(root, home);
      const write = rows.find((r) => r.name === "write access without confirmation: main session");
      assert.equal(write?.status, "warn");
      assert.match(write?.detail ?? "", /Bash\(mkdir/);
    } finally {
      rmTemp(root);
    }
  });

  it("warns only for subagents that inherit an allowed write tool", () => {
    const root = project({
      ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Edit"] } }),
      ".claude/agents/editor.md": "---\nname: editor\ntools: Edit, Read\n---\n",
      ".claude/agents/reader.md": "---\nname: reader\ntools: Read, Grep\n---\n",
    });
    try {
      const rows = runAgentTrifecta(root, home);
      assert.equal(
        rows.find((r) => r.name === "write access without confirmation: agent editor")?.status,
        "warn",
      );
      assert.ok(rows.every((r) => r.name !== "write access without confirmation: agent reader"));
    } finally {
      rmTemp(root);
    }
  });

  it("applies an Edit allow rule to a subagent with the Write tool", () => {
    const root = project({
      ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Edit"] } }),
      ".claude/agents/writer.md": "---\nname: writer\ntools: Write\n---\n",
    });
    try {
      const rows = runAgentTrifecta(root, home);
      assert.equal(
        rows.find((r) => r.name === "write access without confirmation: agent writer")?.status,
        "warn",
      );
    } finally {
      rmTemp(root);
    }
  });

  it("warns for an approved filesystem command but not git status", () => {
    const root = project({
      ".claude/settings.json": JSON.stringify({
        permissions: { allow: ["Bash(rm *)", "Bash(git status)"] },
      }),
    });
    try {
      const rows = runAgentTrifecta(root, home);
      const write = rows.find((r) => r.name === "write access without confirmation: main session");
      assert.equal(write?.status, "warn");
      assert.match(write?.detail ?? "", /Bash\(rm/);
      assert.doesNotMatch(write?.detail ?? "", /git status/);
    } finally {
      rmTemp(root);
    }
  });

  it("warns for a subagent that reads the web, reads files and can send", () => {
    const root = project({
      ".claude/agents/triage.md": "---\nname: triage\ntools: WebFetch, Read, Grep\n---\n",
    });
    try {
      const rows = runAgentTrifecta(root, home);
      const w = rows.find((r) => r.name.includes("triage"));
      assert.equal(w?.status, "warn");
      assert.match(w?.suggestion ?? "", /WebFetch/);
    } finally {
      rmTemp(root);
    }
  });

  it("passes a reader that cannot send and an executor that never sees raw input", () => {
    const root = project({
      ".claude/agents/reader.md": "---\nname: reader\ntools: Read, Grep\n---\n",
      ".claude/agents/executor.md": "---\nname: executor\ntools: Read, Edit, Bash(npm test)\n---\n",
    });
    try {
      const rows = runAgentTrifecta(root, home);
      assert.ok(rows.every((r) => r.status !== "warn"));
    } finally {
      rmTemp(root);
    }
  });

  it("an agent without a tools line inherits the session grants", () => {
    const root = project({
      ".claude/agents/any.md": "---\nname: any\n---\n",
      ".claude/settings.json": JSON.stringify({ permissions: { allow: ["WebFetch", "Read"] } }),
    });
    try {
      const rows = runAgentTrifecta(root, home);
      assert.equal(rows.find((r) => r.name.includes("any"))?.status, "warn");
    } finally {
      rmTemp(root);
    }
  });

  it("bypassPermissions grants everything to the main session", () => {
    const root = project({
      ".claude/settings.json": JSON.stringify({
        permissions: { defaultMode: "bypassPermissions" },
      }),
    });
    try {
      const rows = runAgentTrifecta(root, home);
      assert.equal(rows.find((r) => r.name.includes("main session"))?.status, "warn");
    } finally {
      rmTemp(root);
    }
  });

  it("does not call bypass mode prompt-free when ask covers every tool", () => {
    const root = project({
      ".claude/settings.json": JSON.stringify({
        permissions: { defaultMode: "bypassPermissions", ask: ["*"] },
      }),
    });
    try {
      const rows = runAgentTrifecta(root, home);
      assert.ok(rows.every((r) => !r.name.startsWith("write access without confirmation")));
    } finally {
      rmTemp(root);
    }
  });

  it("a deny rule on WebFetch removes that leg", () => {
    const root = project({
      ".claude/settings.json": JSON.stringify({
        permissions: { allow: ["WebFetch", "Read"], deny: ["WebFetch"] },
      }),
    });
    try {
      const rows = runAgentTrifecta(root, home);
      assert.ok(rows.every((r) => r.status !== "warn"));
    } finally {
      rmTemp(root);
    }
  });
});

describe("runAgentTrifecta, unclassified and quiet cases", () => {
  it("names unclassified MCP servers instead of passing them silently", () => {
    const root = project({
      ".mcp.json": JSON.stringify({ mcpServers: { frobnicator: { command: "x" } } }),
      ".claude/settings.json": JSON.stringify({ permissions: { allow: ["mcp__frobnicator"] } }),
    });
    try {
      const rows = runAgentTrifecta(root, home);
      assert.ok(rows.some((r) => /frobnicator/.test(r.detail ?? "")));
    } finally {
      rmTemp(root);
    }
  });

  it("never prints a value from a config file", () => {
    const root = project({
      ".mcp.json": JSON.stringify({
        mcpServers: { slack: { command: "x", env: { TOKEN: "sekret-value-123" } } },
      }),
      ".claude/settings.json": JSON.stringify({ permissions: { allow: ["mcp__slack", "Read"] } }),
    });
    try {
      assert.ok(!JSON.stringify(runAgentTrifecta(root, home)).includes("sekret-value-123"));
    } finally {
      rmTemp(root);
    }
  });

  it("a project with nothing declared gives one pass row", () => {
    const root = project({});
    try {
      const rows = runAgentTrifecta(root, home);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "pass");
    } finally {
      rmTemp(root);
    }
  });
});

describe("text from config files is shown safely", () => {
  it("removes control characters and caps the length", () => {
    assert.equal(shown("a\u001b[31mred\u0007b\n"), "a[31mredb");
    assert.equal(shown("x\u009by"), "xy");
    assert.equal(shown("x".repeat(500)).length, 80);
  });

  it(
    "an agent file name with an escape sequence cannot reach the output",
    { skip: process.platform === "win32" },
    () => {
      const root = mkdtempSync(join(tmpdir(), "kit-tri-"));
      const home = mkdtempSync(join(tmpdir(), "kit-tri-home-"));
      try {
        mkdirSync(join(root, ".claude", "agents"), { recursive: true });
        writeFileSync(
          join(root, ".claude", "agents", "evil\u001b[2Jname.md"),
          "---\nname: e\ntools: WebFetch, Read\n---\n",
        );
        const text = JSON.stringify(runAgentTrifecta(root, home));
        assert.ok(!text.includes("\\u001b"));
      } finally {
        rmTemp(root);
        rmTemp(home);
      }
    },
  );

  it("a grant with control characters is shown clean in the detail", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-tri-"));
    const home = mkdtempSync(join(tmpdir(), "kit-tri-home-"));
    try {
      mkdirSync(join(root, ".claude"), { recursive: true });
      writeFileSync(
        join(root, ".claude", "settings.json"),
        JSON.stringify({ permissions: { allow: ["mcp__fro\u001b[2Jb__x"] } }),
      );
      const text = JSON.stringify(runAgentTrifecta(root, home));
      assert.ok(!text.includes("\\u001b"));
      assert.match(text, /fro/);
    } finally {
      rmTemp(root);
      rmTemp(home);
    }
  });
});
