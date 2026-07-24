import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAdr,
  evaluateAdr,
  adrIsEnforced,
  globToRegExp,
  extractImports,
  resolveRelative,
} from "./adr.js";

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

const REQUIRE = `---
id: ADR-0010
title: Web handlers must go through the governance wrapper
status: accepted
---

\`\`\`toml kit-enforce
[[require_pattern]]
pattern = "withGovernance"
paths = "src/web/**/*.ts"
message = "web handlers must call withGovernance"
\`\`\`
`;

describe("require_pattern", () => {
  const adr = parseAdr(REQUIRE)!;

  it("parses as a require-pattern rule", () => {
    assert.equal(adr.rules.length, 1);
    assert.equal(adr.rules[0].type, "require-pattern");
    assert.equal(adrIsEnforced(adr), true);
  });

  it("flags a matching file that is MISSING the required pattern", () => {
    const v = evaluateAdr(adr, [{ path: "src/web/handler.ts", content: "export const x = 1\n" }]);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "require-pattern");
    assert.equal(v[0].kind, "violation");
    assert.equal(v[0].line, 1);
  });

  it("passes when the required pattern is present", () => {
    const v = evaluateAdr(adr, [
      { path: "src/web/handler.ts", content: "import { withGovernance } from '../gov.js'\n" },
    ]);
    assert.equal(v.length, 0);
  });

  it("ignores files outside the glob", () => {
    const v = evaluateAdr(adr, [{ path: "src/lib/util.ts", content: "no wrapper here" }]);
    assert.equal(v.length, 0);
  });
});

const FORBID_IMPORT = `---
id: ADR-0011
title: Web must not import the DB driver
status: accepted
---

\`\`\`toml kit-enforce
[[forbid_import]]
import = "^pg$"
paths = "src/web/**/*.ts"
message = "web must not import pg directly"
\`\`\`
`;

describe("forbid_import (direct)", () => {
  const adr = parseAdr(FORBID_IMPORT)!;

  it("parses as a forbid-import rule (non-transitive by default)", () => {
    assert.equal(adr.rules[0].type, "forbid-import");
    assert.equal((adr.rules[0] as { transitive?: boolean }).transitive, false);
  });

  it("flags a direct import of the forbidden specifier, at its line", () => {
    const v = evaluateAdr(adr, [
      { path: "src/web/h.ts", content: "const a = 1\nimport { Client } from 'pg'\n" },
    ]);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "forbid-import");
    assert.equal(v[0].detail, "pg");
    assert.equal(v[0].line, 2);
  });

  it("does not match a substring specifier (anchored regex)", () => {
    const v = evaluateAdr(adr, [{ path: "src/web/h.ts", content: "import x from 'pg-promise'\n" }]);
    assert.equal(v.length, 0);
  });

  it("does not flag a mere textual mention outside an import", () => {
    const v = evaluateAdr(adr, [{ path: "src/web/h.ts", content: "// we avoid 'pg' here\n" }]);
    assert.equal(v.length, 0);
  });
});

const FORBID_IMPORT_T = FORBID_IMPORT.replace(
  `import = "^pg$"`,
  `import = "^pg$"\ntransitive = true`,
);

describe("forbid_import (transitive)", () => {
  const adr = parseAdr(FORBID_IMPORT_T)!;

  it("flags reaching pg through a relative-import chain (intermediate outside the glob)", () => {
    const v = evaluateAdr(adr, [
      { path: "src/web/h.ts", content: "import { q } from '../data/repo.js'\n" },
      { path: "src/data/repo.ts", content: "import { Client } from 'pg'\n" },
    ]);
    assert.equal(v.length, 1);
    assert.equal(v[0].file, "src/web/h.ts");
    assert.equal(v[0].kind, "violation");
    assert.ok(v[0].message.includes("via"));
  });

  it("passes when no reachable file imports pg", () => {
    const v = evaluateAdr(adr, [
      { path: "src/web/h.ts", content: "import { q } from '../data/repo.js'\n" },
      { path: "src/data/repo.ts", content: "export const q = 1\n" },
    ]);
    assert.equal(v.length, 0);
  });

  it("surfaces an unresolvable relative import as a gap, not green", () => {
    const v = evaluateAdr(adr, [
      { path: "src/web/h.ts", content: "import { q } from './missing.js'\n" },
    ]);
    assert.equal(v.length, 1);
    assert.equal(v[0].kind, "gap");
    assert.ok(v[0].message.includes("cannot prove"));
  });

  it("a bare (external) leaf that isn't the target is not a gap", () => {
    const v = evaluateAdr(adr, [
      { path: "src/web/h.ts", content: "import express from 'express'\n" },
    ]);
    assert.equal(v.length, 0);
  });
});

describe("extractImports", () => {
  it("finds ES import, re-export, require and dynamic import specifiers", () => {
    const refs = extractImports(
      [
        "import a from 'x'",
        "export { b } from './y.js'",
        "const c = require('z')",
        "const d = await import('./w.js')",
        "// import 'commented' — still matched (over-flag, never false-green)",
      ].join("\n"),
    );
    assert.deepEqual(
      refs.map((r) => r.specifier),
      ["x", "./y.js", "z", "./w.js", "commented"],
    );
  });
});

describe("resolveRelative", () => {
  const set = new Set(["src/web/repo.ts", "src/web/dir/index.ts"]);
  it("resolves ./ with an implied extension", () => {
    assert.equal(resolveRelative("src/web/h.ts", "./repo.js", set), "src/web/repo.ts");
    assert.equal(resolveRelative("src/web/h.ts", "./repo", set), "src/web/repo.ts");
  });
  it("resolves a directory to its index", () => {
    assert.equal(resolveRelative("src/web/h.ts", "./dir", set), "src/web/dir/index.ts");
  });
  it("returns null for bare specifiers and unresolvable paths", () => {
    assert.equal(resolveRelative("src/web/h.ts", "pg", set), null);
    assert.equal(resolveRelative("src/web/h.ts", "./nope.js", set), null);
  });
});
