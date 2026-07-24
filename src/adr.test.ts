import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAdr, evaluateAdr, adrIsEnforced, globToRegExp } from "./adr.js";

const ACCEPTED = `---
id: ADR-0007
title: Web layer must not import the DB driver
status: accepted
---

## Decision
Go through the service layer.

\`\`\`toml kit-enforce
[[forbid_pattern]]
pattern = "from ['\\"]pg['\\"]"
paths = "src/web/**/*.ts"
message = "web must not import pg directly"
\`\`\`
`;

describe("parseAdr", () => {
  it("returns null without frontmatter or without an id", () => {
    assert.equal(parseAdr("# just markdown"), null);
    assert.equal(parseAdr("---\ntitle: x\n---\nbody"), null);
  });

  it("parses id/title/status and the toml kit-enforce block", () => {
    const adr = parseAdr(ACCEPTED)!;
    assert.equal(adr.id, "ADR-0007");
    assert.equal(adr.status, "accepted");
    assert.equal(adr.hasEnforceBlock, true);
    assert.equal(adr.rules.length, 1);
    assert.equal(adr.rules[0].paths, "src/web/**/*.ts");
  });

  it("an unknown status is normalized, not crashed", () => {
    const adr = parseAdr("---\nid: A\nstatus: bogus\n---\nx")!;
    assert.equal(adr.status, "unknown");
  });

  it("accepted + no enforce block = documented, not enforced", () => {
    const adr = parseAdr("---\nid: A-1\ntitle: t\nstatus: accepted\n---\nprose only")!;
    assert.equal(adr.hasEnforceBlock, false);
    assert.equal(adrIsEnforced(adr), false);
  });

  it("malformed toml yields zero rules but keeps hasEnforceBlock (surfaced)", () => {
    const adr = parseAdr(
      "---\nid: A\nstatus: accepted\n---\n```toml kit-enforce\nnot = = valid\n```",
    )!;
    assert.equal(adr.hasEnforceBlock, true);
    assert.equal(adr.rules.length, 0);
  });
});

describe("adrIsEnforced", () => {
  it("only accepted ADRs with ≥1 rule enforce", () => {
    assert.equal(adrIsEnforced(parseAdr(ACCEPTED)!), true);
    const proposed = ACCEPTED.replace("status: accepted", "status: proposed");
    assert.equal(adrIsEnforced(parseAdr(proposed)!), false);
  });
});

describe("evaluateAdr", () => {
  const adr = parseAdr(ACCEPTED)!;

  it("flags a forbidden pattern in a matching file, cited to the ADR + line", () => {
    const v = evaluateAdr(adr, [
      { path: "src/web/handler.ts", content: "import x from 'pg'\nconst y = 1\n" },
    ]);
    assert.equal(v.length, 1);
    assert.equal(v[0].adrId, "ADR-0007");
    assert.equal(v[0].line, 1);
  });

  it("ignores files outside the glob", () => {
    const v = evaluateAdr(adr, [{ path: "src/service/db.ts", content: "import x from 'pg'" }]);
    assert.equal(v.length, 0);
  });

  it("a non-accepted ADR never gates", () => {
    const proposed = parseAdr(ACCEPTED.replace("status: accepted", "status: superseded"))!;
    const v = evaluateAdr(proposed, [{ path: "src/web/h.ts", content: "from 'pg'" }]);
    assert.equal(v.length, 0);
  });
});

describe("globToRegExp", () => {
  it("handles ** and *", () => {
    assert.ok(globToRegExp("src/web/**/*.ts").test("src/web/a/b/c.ts"));
    assert.ok(globToRegExp("src/web/**/*.ts").test("src/web/x.ts"));
    assert.ok(!globToRegExp("src/web/**/*.ts").test("src/api/x.ts"));
    assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  });
});
