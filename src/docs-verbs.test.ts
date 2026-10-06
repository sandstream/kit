import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { securityFindings } from "./monkey-test-security.js";

const root = join(import.meta.dirname, "..");

/** Verbs docs/COMMANDS.md documents as `kit <group> <verb>` inside backticks. */
function documentedVerbs(group: string): string[] {
  const text = readFileSync(join(root, "docs", "COMMANDS.md"), "utf8");
  const found = new Set<string>();
  for (const m of text.matchAll(new RegExp(`\`kit ${group} ([a-z][a-z-]*)`, "g"))) {
    found.add(m[1]);
  }
  return [...found];
}

describe("docs/COMMANDS.md only documents verbs the command handles", () => {
  it("kit hooks", () => {
    const src = readFileSync(join(root, "src", "commands", "hooks.ts"), "utf8");
    const handled = new Set([...src.matchAll(/subcommand === "([a-z-]+)"/g)].map((m) => m[1]));
    const phantom = documentedVerbs("hooks").filter((v) => !handled.has(v));
    assert.deepEqual(phantom, [], `documented but not handled: ${phantom.join(", ")}`);
  });

  it("kit policy hints never name a trust sub-verb", () => {
    for (const file of ["src/commands/policy.ts", "src/profile/portable.ts"]) {
      const src = readFileSync(join(root, file), "utf8");
      assert.doesNotMatch(src, /kit policy trust add/, `${file} names a verb that does not exist`);
    }
  });
});

describe("monkey-test env switches are documented", () => {
  it("SKIP_SEED appears in docs/MONKEY_TEST.md", () => {
    const runner = readFileSync(join(root, "src", "monkey-test-runner.ts"), "utf8");
    assert.match(runner, /process\.env\.SKIP_SEED/);
    const doc = readFileSync(join(root, "docs", "MONKEY_TEST.md"), "utf8");
    assert.match(doc, /SKIP_SEED=1/);
  });
});

describe("monkey-test status is described consistently", () => {
  it("documents the static checks that a stub and unused string can satisfy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-monkey-doc-limitation-"));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ dependencies: { stripe: "1.0.0", "@supabase/supabase-js": "1.0.0" } }),
      );
      writeFileSync(
        join(dir, "src", "stubs.ts"),
        'export function verifyWebhookSignature() {}\nexport const unused = "alter table orders enable row level security; create policy tenant_orders on orders using (tenant_id = auth.uid())";\n',
      );
      const titles = (await securityFindings(dir)).map((finding) => finding.title);
      assert.ok(!titles.includes("Payment provider detected without webhook signature verification"));
      assert.ok(!titles.includes("Supabase detected without obvious RLS policy coverage"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const doc = readFileSync(join(root, "docs", "MONKEY_TEST.md"), "utf8");
    assert.match(doc, /stub/i);
    assert.match(doc, /lexical/i);
  });
});
