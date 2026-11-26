import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeAnonAccess } from "./check-anon-access.js";

const sql = (...statements: string[]) => [{ file: "m.sql", text: statements.join("\n") }];
const CONTENT_TABLE = `CREATE TABLE public.content (id uuid primary key, body text, phone text);`;

describe("analyzeAnonAccess: lexer edge cases", () => {
  const POLICY = "CREATE POLICY p ON content FOR SELECT USING (true);";
  const open = (text: string) => analyzeAnonAccess(sql(CONTENT_TABLE, text)).readable.length;

  it("reads a backslash-escaped quote inside an E string", () => {
    const text = ["COMMENT ON TABLE content IS E'a\\'b; c';", POLICY].join("\n");
    assert.equal(open(text), 1);
  });

  it("does not take a dollar sign inside an identifier for a dollar quote", () => {
    const text = ["CREATE TABLE my$tbl$x (id int);", POLICY, "SELECT $tbl$;"].join("\n");
    assert.equal(open(text), 1);
  });

  it("treats a non-ASCII letter as part of an identifier, so a dollar sign after it opens nothing", () => {
    const text = ["CREATE TABLE t\u00e5$x$y (id int);", POLICY, "SELECT $x$;"].join("\n");
    assert.equal(open(text), 1);
  });

  it("reads a column name with a non-ASCII letter whole", () => {
    const r = analyzeAnonAccess(
      sql(
        "CREATE TABLE people (id int, f\u00f6rnamn text, first_name text);",
        "CREATE POLICY p ON people FOR SELECT USING (true);",
      ),
    );
    assert.deepEqual(r.readable[0].personalColumns, ["first_name"]);
  });

  it("marks a file with an unterminated block comment, string or dollar quote as incomplete", () => {
    for (const tail of ["/* never closed", "SELECT 'never closed", "SELECT $$ never closed"]) {
      const r = analyzeAnonAccess([{ file: "bad.sql", text: `${POLICY}\n${tail}` }]);
      assert.deepEqual(r.incomplete, ["bad.sql"], tail);
    }
  });

  it("does not mark a complete file as incomplete", () => {
    const r = analyzeAnonAccess(sql(CONTENT_TABLE, POLICY, "-- a comment at the end"));
    assert.deepEqual(r.incomplete, []);
  });
});
