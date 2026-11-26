/** The `signed-in database access` row: a policy that lets every signed-in user read every row. */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { analyzeAnonAccess, checkDatabaseAccess } from "./check-anon-access.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const sql = (...statements: string[]) => [{ file: "m.sql", text: statements.join("\n") }];
const signedIn = (...statements: string[]) =>
  analyzeAnonAccess(sql(...statements)).signedIn.map((t) => t.table);

const INVOICES = "create table public.invoices (id bigint primary key, customer_email text);";
const RLS = "alter table public.invoices enable row level security;";

function tree(spec: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-signed-in-access-"));
  for (const [rel, content] of Object.entries(spec)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe("analyzeAnonAccess: policies open to every signed-in user", () => {
  it("lists TO authenticated USING (true) for select and for all, in either case", () => {
    const p = "create policy r on public.invoices for select to authenticated using (true);";
    assert.deepEqual(signedIn(INVOICES, RLS, p), ["invoices"]);
    const all = `CREATE POLICY "Enable read" ON "public"."invoices" AS PERMISSIVE FOR ALL TO authenticated USING ( TRUE );`;
    assert.deepEqual(signedIn(INVOICES, RLS, all), ["invoices"]);
    const r = analyzeAnonAccess(sql(INVOICES, RLS, p)).signedIn[0];
    assert.deepEqual(r.personalColumns, ["customer_email"]);
    assert.match(r.via[0], /policy "r" \(TO authenticated USING true\)/);
  });

  it("does not list a row-scoped, restrictive, insert-only or dropped policy", () => {
    const scoped =
      "create policy r on invoices for select to authenticated using (auth.uid() = owner);";
    const restrictive =
      "create policy r on invoices as restrictive for select to authenticated using (true);";
    const insert = "create policy r on invoices for insert to authenticated with check (true);";
    const open = "create policy r on invoices for select to authenticated using (true);";
    assert.deepEqual(signedIn(INVOICES, RLS, scoped), []);
    assert.deepEqual(signedIn(INVOICES, RLS, restrictive), []);
    assert.deepEqual(signedIn(INVOICES, RLS, insert), []);
    assert.deepEqual(signedIn(INVOICES, RLS, open, "drop policy r on invoices;"), []);
  });

  it("leaves a table anon can already read to the anonymous row", () => {
    const both = "create policy r on invoices for select to anon, authenticated using (true);";
    const r = analyzeAnonAccess(sql(INVOICES, RLS, both));
    assert.deepEqual(
      r.readable.map((t) => t.table),
      ["invoices"],
    );
    assert.deepEqual(r.signedIn, []);
  });
});

describe("checkDatabaseAccess: signed-in database access row", () => {
  const open = "create policy r on public.invoices for select to authenticated using (true);";

  it("fails high when the table has a personal-looking column, and leaves the anon row passing", async () => {
    const dir = tree({ "supabase/migrations/1.sql": [INVOICES, RLS, open].join("\n") });
    try {
      const [anon, signed] = await checkDatabaseAccess(dir);
      assert.equal(anon.status, "pass");
      assert.equal(signed.name, "signed-in database access");
      assert.equal(signed.status, "fail");
      assert.equal(signed.severity, "high");
      assert.match(signed.detail, /invoices \(personal columns: customer_email\)/);
      assert.match(signed.suggestion ?? "", /auth\.uid\(\)/);
    } finally {
      rmTemp(dir);
    }
  });

  it("warns medium without a personal column, passes with none, skips without SQL", async () => {
    const posts =
      "create table posts (id int, body text);\nalter table posts enable row level security;";
    const p = "create policy r on posts for select to authenticated using (true);";
    const warn = tree({ "db/1.sql": `${posts}\n${p}` });
    const pass = tree({ "db/1.sql": posts });
    const none = tree({ "package.json": "{}" });
    try {
      const w = (await checkDatabaseAccess(warn))[1];
      assert.equal(w.status, "warn");
      assert.equal(w.severity, "medium");
      assert.match(w.detail, /posts/);
      assert.equal((await checkDatabaseAccess(pass))[1].status, "pass");
      assert.equal((await checkDatabaseAccess(none))[1].status, "skip");
    } finally {
      for (const d of [warn, pass, none]) rmTemp(d);
    }
  });

  it("accepts a table declared public in .kit.toml, as the anon row does", async () => {
    const posts =
      "create table posts (id int, body text);\nalter table posts enable row level security;";
    const p = "create policy r on posts for select to authenticated using (true);";
    const dir = tree({
      "db/1.sql": `${posts}\n${p}`,
      ".kit.toml": '[anon_access.public]\nposts = "public feed"\n',
    });
    try {
      const r = (await checkDatabaseAccess(dir))[1];
      assert.equal(r.status, "pass");
      assert.match(r.detail, /1 declared public: posts/);
    } finally {
      rmTemp(dir);
    }
  });
});
