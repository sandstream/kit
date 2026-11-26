import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { analyzeAnonAccess, checkAnonAccess } from "./check-anon-access.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const sql = (...statements: string[]) => [{ file: "m.sql", text: statements.join("\n") }];

function tree(spec: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-anon-access-"));
  for (const [rel, content] of Object.entries(spec)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const INVOICES = `create table public.invoices (id bigint primary key, customer_email text, amount int);`;
const supa = (...files: string[]) =>
  analyzeAnonAccess(
    files.map((text, i) => ({ file: `supabase/migrations/00${i + 1}.sql`, text })),
    { supabase: true },
  );
const names = (r: { readable: { table: string }[] }) => r.readable.map((t) => t.table);

describe("analyzeAnonAccess: Supabase default grants", () => {
  it("lists a public table with no RLS statement, and one with RLS disabled", () => {
    assert.deepEqual(names(supa(INVOICES)), ["invoices"]);
    const off = supa(INVOICES, "alter table public.invoices disable row level security;");
    assert.deepEqual(names(off), ["invoices"]);
    assert.deepEqual(off.readable[0].personalColumns, ["customer_email"]);
    assert.match(off.readable[0].via[0], /Supabase default grant/);
  });

  it("does not list it once a later migration enables RLS, and lists it again after a disable", () => {
    const on = "alter table public.invoices enable row level security;";
    assert.deepEqual(names(supa(INVOICES, on)), []);
    const off = "alter table invoices disable row level security;";
    assert.deepEqual(names(supa(INVOICES, on, off)), ["invoices"]);
  });

  it("does not take FORCE ROW LEVEL SECURITY alone for enabling it", () => {
    const force = "alter table public.invoices force row level security;";
    assert.deepEqual(names(supa(INVOICES, force)), ["invoices"]);
    const both = "alter table public.invoices enable row level security;";
    assert.deepEqual(names(supa(INVOICES, both, force)), []);
  });

  it("skips tables in schemas other than public", () => {
    const r = supa("create table private.invoices (id int, customer_email text);");
    assert.deepEqual(names(r), []);
  });

  it("does not list a table after REVOKE … FROM anon, but does after REVOKE … FROM public", () => {
    assert.deepEqual(names(supa(INVOICES, "revoke all on public.invoices from anon;")), []);
    assert.deepEqual(
      names(supa(INVOICES, "revoke select on invoices from anon, authenticated;")),
      [],
    );
    const all = "revoke all on all tables in schema public from anon;";
    assert.deepEqual(names(supa(INVOICES, all)), []);
    assert.deepEqual(names(supa(INVOICES, "revoke select on invoices from public;")), ["invoices"]);
  });

  it("honours ALTER DEFAULT PRIVILEGES for tables created after it", () => {
    const revoke =
      "alter default privileges for role postgres in schema public revoke all on tables from anon;";
    assert.deepEqual(names(supa(revoke, INVOICES)), []);
    assert.deepEqual(names(supa(INVOICES, revoke)), ["invoices"]);
    const regrant = "alter default privileges in schema public grant select on tables to anon;";
    assert.deepEqual(names(supa(revoke, regrant, INVOICES)), ["invoices"]);
  });

  it("forgets a dropped table, and models nothing outside a Supabase project", () => {
    assert.deepEqual(names(supa(INVOICES, "drop table if exists public.invoices cascade;")), []);
    assert.deepEqual(names(analyzeAnonAccess(sql(INVOICES))), []);
  });
});

describe("checkAnonAccess: Supabase project", () => {
  const disabled = `${INVOICES}\nalter table public.invoices disable row level security;`;

  it("fails a public table with RLS disabled, at the severity of USING (true)", async () => {
    const dir = tree({
      "supabase/config.toml": "",
      "supabase/migrations/1_invoices.sql": disabled,
    });
    try {
      const r = await checkAnonAccess(dir);
      assert.equal(r.status, "fail");
      assert.equal(r.severity, "high");
      assert.match(r.detail, /invoices \(personal columns: customer_email\)/);
      assert.match(r.suggestion ?? "", /Enable row level security/);
    } finally {
      rmTemp(dir);
    }
  });

  it("detects Supabase from package.json, and warns for a table with no personal column", async () => {
    const dir = tree({
      "package.json": JSON.stringify({ dependencies: { "@supabase/supabase-js": "2.0.0" } }),
      "db/1.sql": "create table posts (id int, body text);",
    });
    try {
      const r = await checkAnonAccess(dir);
      assert.equal(r.status, "warn");
      assert.equal(r.severity, "medium");
      assert.match(r.detail, /posts/);
    } finally {
      rmTemp(dir);
    }
  });

  it("passes the same migration in a project that is not Supabase", async () => {
    const dir = tree({ "db/1_invoices.sql": disabled });
    try {
      assert.equal((await checkAnonAccess(dir)).status, "pass");
    } finally {
      rmTemp(dir);
    }
  });
});
