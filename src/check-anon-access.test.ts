/**
 * Anonymous database access, read statically from SQL migrations.
 *
 * The case behind this check: a `content` table with `FOR SELECT USING (true)` and a phone
 * column. Anyone with the public anon key can read every row, and the migration reads like a
 * normal public-content policy. Each test pins one way a policy opens a table to anonymous
 * readers, or one way it looks open and is not.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

const CONTENT_TABLE = `CREATE TABLE public.content (id uuid primary key, body text, phone text);`;

describe("analyzeAnonAccess: policies", () => {
  it("flags FOR SELECT USING (true) without a TO clause, because the default role is PUBLIC", () => {
    const r = analyzeAnonAccess(
      sql(
        CONTENT_TABLE,
        "ALTER TABLE public.content ENABLE ROW LEVEL SECURITY;",
        `CREATE POLICY "read all" ON public.content FOR SELECT USING (true);`,
      ),
    );
    assert.deepEqual(
      r.readable.map((t) => t.table),
      ["content"],
    );
    assert.deepEqual(r.readable[0].personalColumns, ["phone"]);
    assert.match(r.readable[0].via[0], /read all/);
  });

  it("flags TO anon and TO public, and reads FOR ALL as including select", () => {
    for (const to of ["TO anon", "TO public", "TO authenticated, anon"]) {
      const r = analyzeAnonAccess(
        sql(CONTENT_TABLE, `CREATE POLICY p ON content FOR ALL ${to} USING (true);`),
      );
      assert.equal(r.readable.length, 1, to);
    }
  });

  it("does not flag TO authenticated USING (true)", () => {
    const r = analyzeAnonAccess(
      sql(CONTENT_TABLE, `CREATE POLICY p ON content FOR SELECT TO authenticated USING (true);`),
    );
    assert.equal(r.readable.length, 0);
  });

  it("does not flag a row-scoped policy for anon", () => {
    const r = analyzeAnonAccess(
      sql(
        CONTENT_TABLE,
        `CREATE POLICY p ON content FOR SELECT TO anon USING (auth.uid() = owner_id);`,
      ),
    );
    assert.equal(r.readable.length, 0);
  });

  it("does not flag an insert-only policy", () => {
    const r = analyzeAnonAccess(
      sql(CONTENT_TABLE, `CREATE POLICY p ON content FOR INSERT TO anon WITH CHECK (true);`),
    );
    assert.equal(r.readable.length, 0);
  });

  it("treats (1 = 1) and ( TRUE ) like true", () => {
    for (const expr of ["(1 = 1)", "( TRUE )", "((true))"]) {
      const r = analyzeAnonAccess(
        sql(CONTENT_TABLE, `CREATE POLICY p ON content FOR SELECT USING ${expr};`),
      );
      assert.equal(r.readable.length, 1, expr);
    }
  });
});

describe("analyzeAnonAccess: dropped and inert policies", () => {
  it("lets a later DROP POLICY cancel the earlier policy", () => {
    const r = analyzeAnonAccess([
      {
        file: "001.sql",
        text: `${CONTENT_TABLE}\nCREATE POLICY p ON content FOR SELECT USING (true);`,
      },
      { file: "002.sql", text: `DROP POLICY IF EXISTS p ON content;` },
    ]);
    assert.equal(r.readable.length, 0);
  });

  it("ignores a policy that sits in a comment", () => {
    const r = analyzeAnonAccess(
      sql(
        CONTENT_TABLE,
        `-- CREATE POLICY p ON content FOR SELECT USING (true);`,
        `/* CREATE POLICY q ON content FOR SELECT USING (true); */`,
      ),
    );
    assert.equal(r.readable.length, 0);
  });

  it("does not let a restrictive policy count as opening the table", () => {
    const r = analyzeAnonAccess(
      sql(CONTENT_TABLE, `CREATE POLICY p ON content AS RESTRICTIVE FOR SELECT USING (true);`),
    );
    assert.equal(r.readable.length, 0);
  });
});

describe("analyzeAnonAccess: grants", () => {
  it("flags GRANT SELECT TO anon on a table without row level security", () => {
    const r = analyzeAnonAccess(
      sql(CONTENT_TABLE, "GRANT SELECT ON TABLE public.content TO anon;"),
    );
    assert.equal(r.readable.length, 1);
    assert.match(r.readable[0].via[0], /GRANT/);
  });

  it("does not flag a grant when row level security is on and no policy opens the table", () => {
    const r = analyzeAnonAccess(
      sql(
        CONTENT_TABLE,
        "ALTER TABLE content ENABLE ROW LEVEL SECURITY;",
        "GRANT SELECT ON content TO anon;",
      ),
    );
    assert.equal(r.readable.length, 0);
  });

  it("applies GRANT ... ON ALL TABLES IN SCHEMA public to every table the migrations create", () => {
    const r = analyzeAnonAccess(
      sql(
        CONTENT_TABLE,
        "CREATE TABLE public.orders (id int, email text);",
        "GRANT ALL ON ALL TABLES IN SCHEMA public TO anon;",
      ),
    );
    assert.deepEqual(r.readable.map((t) => t.table).sort(), ["content", "orders"]);
  });

  it("lets REVOKE cancel an earlier grant", () => {
    const r = analyzeAnonAccess(
      sql(CONTENT_TABLE, "GRANT SELECT ON content TO anon;", "REVOKE SELECT ON content FROM anon;"),
    );
    assert.equal(r.readable.length, 0);
  });
});

describe("analyzeAnonAccess: column grants", () => {
  const TEAMS = [
    "CREATE TABLE public.teams (id uuid, name text, contact_phone_1 text, contact_email_1 text);",
    "CREATE POLICY public_view_teams ON teams FOR SELECT USING (true);",
  ];

  it("counts only the granted columns after REVOKE SELECT and a column GRANT", () => {
    const r = analyzeAnonAccess(
      sql(
        ...TEAMS,
        "REVOKE SELECT ON public.teams FROM anon;",
        "GRANT SELECT (id, name) ON public.teams TO anon;",
      ),
    );
    assert.deepEqual(
      r.readable.map((t) => t.table),
      ["teams"],
    );
    assert.deepEqual(r.readable[0].personalColumns, []);
  });

  it("still reports a personal column that the column GRANT includes", () => {
    const r = analyzeAnonAccess(
      sql(
        ...TEAMS,
        "REVOKE SELECT ON teams FROM anon;",
        "GRANT SELECT (id, contact_phone_1) ON teams TO anon;",
      ),
    );
    assert.deepEqual(r.readable[0].personalColumns, ["contact_phone_1"]);
  });

  it("lifts the column limit when a later table-level GRANT SELECT follows", () => {
    const r = analyzeAnonAccess(
      sql(
        ...TEAMS,
        "REVOKE SELECT ON teams FROM anon;",
        "GRANT SELECT (id) ON teams TO anon;",
        "GRANT SELECT ON teams TO anon;",
      ),
    );
    assert.deepEqual(r.readable[0].personalColumns, ["contact_email_1", "contact_phone_1"]);
  });
});

describe("analyzeAnonAccess: parsing that must not hide an open table", () => {
  const open = (text: string) => analyzeAnonAccess(sql(CONTENT_TABLE, text)).readable.length;

  it("reads USING (true) when WITH CHECK follows", () => {
    assert.equal(open("CREATE POLICY p ON content FOR ALL USING (true) WITH CHECK (true);"), 1);
    assert.equal(open("CREATE POLICY p ON content FOR ALL USING (true) WITH CHECK (false);"), 1);
  });

  it("does not call a nested row condition open", () => {
    assert.equal(
      open("CREATE POLICY p ON content FOR SELECT USING (owner = (SELECT id FROM t LIMIT 1));"),
      0,
    );
  });

  it("is not blinded by a dollar sign inside a line comment", () => {
    const text = [
      "-- see $$ note",
      "CREATE POLICY p ON content FOR SELECT USING (true);",
      "-- end $$",
    ].join("\n");
    assert.equal(open(text), 1);
  });

  it("is not blinded by a block comment opener inside a line comment", () => {
    const text = [
      "-- remember /*",
      "CREATE POLICY p ON content FOR SELECT USING (true);",
      "/* closed */",
    ].join("\n");
    assert.equal(open(text), 1);
  });

  it("is not confused by a semicolon or dashes inside a string", () => {
    const text = [
      "COMMENT ON TABLE content IS 'a -- b; $$ c';",
      "CREATE POLICY p ON content FOR SELECT USING (true);",
    ].join("\n");
    assert.equal(open(text), 1);
  });

  it("reads the role when WITH GRANT OPTION follows", () => {
    assert.equal(open("GRANT SELECT ON content TO anon WITH GRANT OPTION;"), 1);
    assert.equal(open("GRANT SELECT ON content TO authenticated, anon WITH GRANT OPTION;"), 1);
  });

  it("lets REVOKE ... CASCADE cancel a grant", () => {
    assert.equal(
      open("GRANT SELECT ON content TO anon;\nREVOKE SELECT ON content FROM anon CASCADE;"),
      0,
    );
  });
});

describe("analyzeAnonAccess: personal columns", () => {
  it("finds phone, email, person names and national ids, from CREATE TABLE and ALTER TABLE", () => {
    const r = analyzeAnonAccess(
      sql(
        `CREATE TABLE people (id int, first_name text, Email text, notes text, UNIQUE (id));`,
        `ALTER TABLE people ADD COLUMN IF NOT EXISTS personnummer text;`,
        `ALTER TABLE people ADD COLUMN mobile_phone text;`,
        `CREATE POLICY p ON people FOR SELECT USING (true);`,
      ),
    );
    assert.deepEqual(r.readable[0].personalColumns.sort(), [
      "email",
      "first_name",
      "mobile_phone",
      "personnummer",
    ]);
  });

  it("does not call a plain name or title column personal", () => {
    const r = analyzeAnonAccess(
      sql(
        `CREATE TABLE products (id int, name text, title text);`,
        `CREATE POLICY p ON products FOR SELECT USING (true);`,
      ),
    );
    assert.deepEqual(r.readable[0].personalColumns, []);
  });

  it("does not take the content of a dollar-quoted function body for statements", () => {
    const r = analyzeAnonAccess(
      sql(
        CONTENT_TABLE,
        `CREATE FUNCTION f() RETURNS void AS $$ BEGIN CREATE POLICY p ON content FOR SELECT USING (true); END $$ LANGUAGE plpgsql;`,
      ),
    );
    assert.equal(r.readable.length, 0);
  });
});

describe("checkAnonAccess", () => {
  it("skips with a reason when the project has no SQL files", async () => {
    const dir = tree({ "package.json": "{}" });
    try {
      const r = await checkAnonAccess(dir);
      assert.equal(r.status, "skip");
      assert.equal(r.category, "exposure");
      assert.match(r.detail, /no SQL/i);
    } finally {
      rmTemp(dir);
    }
  });

  it("fails with the table and the column for the content case", async () => {
    const dir = tree({
      "supabase/migrations/001_content.sql": `${CONTENT_TABLE}\nALTER TABLE content ENABLE ROW LEVEL SECURITY;`,
      "supabase/migrations/002_policy.sql": `CREATE POLICY "read all" ON content FOR SELECT USING (true);`,
    });
    try {
      const r = await checkAnonAccess(dir);
      assert.equal(r.status, "fail");
      assert.equal(r.severity, "high");
      assert.match(r.detail, /content/);
      assert.match(r.detail, /phone/);
      assert.ok(r.suggestion);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("checkAnonAccess: results", () => {
  it("applies migrations in file name order, so a later drop wins", async () => {
    const dir = tree({
      "supabase/migrations/001.sql": `${CONTENT_TABLE}\nCREATE POLICY p ON content FOR SELECT USING (true);`,
      "supabase/migrations/002.sql": `DROP POLICY p ON content;`,
    });
    try {
      const r = await checkAnonAccess(dir);
      assert.equal(r.status, "pass");
    } finally {
      rmTemp(dir);
    }
  });

  it("warns, not fails, for an anon-readable table with no personal column", async () => {
    const dir = tree({
      "db/schema.sql": `CREATE TABLE posts (id int, body text);\nCREATE POLICY p ON posts FOR SELECT USING (true);`,
    });
    try {
      const r = await checkAnonAccess(dir);
      assert.equal(r.status, "warn");
      assert.match(r.detail, /posts/);
    } finally {
      rmTemp(dir);
    }
  });

  it("passes and says what it read when no table is anon-readable", async () => {
    const dir = tree({
      "supabase/migrations/001.sql": `${CONTENT_TABLE}\nALTER TABLE content ENABLE ROW LEVEL SECURITY;`,
    });
    try {
      const r = await checkAnonAccess(dir);
      assert.equal(r.status, "pass");
      assert.match(r.detail, /1 SQL file/);
    } finally {
      rmTemp(dir);
    }
  });

  it("does not read SQL under node_modules or through a symlink", async () => {
    const dir = tree({
      "node_modules/pkg/bad.sql": `CREATE TABLE t (phone text);\nCREATE POLICY p ON t FOR SELECT USING (true);`,
      "outside/bad.sql": `CREATE TABLE t (phone text);\nCREATE POLICY p ON t FOR SELECT USING (true);`,
    });
    try {
      symlinkSync(join(dir, "outside"), join(dir, "linked"), "dir");
      rmTemp(join(dir, "outside"));
      const r = await checkAnonAccess(dir);
      assert.equal(r.status, "skip");
    } finally {
      rmTemp(dir);
    }
  });

  it("reports an unreadable-size file as an incomplete scan, not a pass", async () => {
    const dir = tree({
      "db/big.sql": "-- " + "x".repeat(3 * 1024 * 1024),
      "db/ok.sql": "SELECT 1;",
    });
    try {
      const r = await checkAnonAccess(dir);
      assert.equal(r.status, "warn");
      assert.equal(r.didNotRun, true);
      assert.match(r.detail, /big\.sql/);
    } finally {
      rmTemp(dir);
    }
  });
});
