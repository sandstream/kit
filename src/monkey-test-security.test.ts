import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { securityFindings } from "./monkey-test-security.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

describe("monkey-test immutable journal evidence", () => {
  it("does not mistake an append call for protection against update or delete", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-monkey-journal-"));
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { stripe: "1.0.0" } }),
    );
    writeFileSync(
      join(root, "src", "payments.ts"),
      [
        "const tenant_id = request.auth.tenant_id;",
        "const event = stripe.webhooks.constructEvent(raw, sig, secret);",
        "await webhook_events.insert({ event_id: event.id });",
        "await stripe.refunds.create({ payment_intent: id });",
        "return charge.receipt_url;",
        "await journal.insert({ tenant_id, event });",
      ].join("\n"),
    );

    try {
      const findings = await securityFindings(root);
      assert.ok(findings.some((finding) => finding.title === "Immutable money journal not found"));
    } finally {
      rmTemp(root);
    }
  });
});

function supabaseApp(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kit-monkey-supabase-"));
  const all: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { "@supabase/supabase-js": "2.0.0" } }),
    ".kit.toml": 'version = 1\n\n[services.supabase]\nkind = "supabase"\n',
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const INVOICES_SQL = "create table public.invoices (id bigint primary key, customer_email text);\n";
const NOTES_SQL = [
  "create table public.notes (id bigint primary key, author_email text);",
  "alter table public.notes enable row level security;",
  "create policy read_notes on public.notes for select using (true);",
].join("\n");

describe("monkey-test RLS coverage per table (kit-research#230)", () => {
  it("flags a table without RLS even when another table has RLS and a policy", async () => {
    const root = supabaseApp({
      "supabase/migrations/001_notes.sql": NOTES_SQL,
      "supabase/migrations/002_invoices.sql": INVOICES_SQL,
    });
    try {
      const rls = (await securityFindings(root)).filter((f) => /RLS/.test(f.title));
      assert.equal(rls.length, 1, JSON.stringify(rls));
      assert.match(rls[0].title, /invoices/);
      assert.doesNotMatch(rls[0].title, /notes/);
      assert.equal(rls[0].file, "supabase/migrations/002_invoices.sql");
    } finally {
      rmTemp(root);
    }
  });

  it("points the finding at the migration, not .kit.toml", async () => {
    const root = supabaseApp({ "supabase/migrations/001_invoices.sql": INVOICES_SQL });
    try {
      const rls = (await securityFindings(root)).filter((f) => /RLS/.test(f.title));
      assert.equal(rls.length, 1);
      assert.equal(rls[0].file, "supabase/migrations/001_invoices.sql");
    } finally {
      rmTemp(root);
    }
  });

  it("passes when every created table has RLS and a policy", async () => {
    const root = supabaseApp({ "supabase/migrations/001_notes.sql": NOTES_SQL });
    try {
      const rls = (await securityFindings(root)).filter((f) => /RLS/.test(f.title));
      assert.deepEqual(rls, []);
    } finally {
      rmTemp(root);
    }
  });
});

describe("monkey-test secret finding repro (kit-research#230)", () => {
  it("names a command that finds the secret, not the ClamAV artifact scan", async () => {
    const root = supabaseApp({
      "src/seed.js": 'export const users = [{ email: "admin@h.example", password: "admin123" }];\n',
    });
    try {
      const finding = (await securityFindings(root)).find(
        (f) => f.title === "Secret-shaped value in runtime source",
      );
      assert.ok(finding, "the seed password is a keyed-secret finding");
      assert.doesNotMatch(finding.repro, /scan-artifact/);
      assert.match(finding.repro, /^rg -n -P '.+' 'src\/seed\.js' {2}# keyed-secret$/);
      const rg = spawnSync("rg", ["--version"]);
      if (process.platform === "win32" || rg.error) return; // the repro is POSIX shell syntax
      const run = spawnSync("sh", ["-c", finding.repro], { cwd: root, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /password/);
    } finally {
      rmTemp(root);
    }
  });
});
