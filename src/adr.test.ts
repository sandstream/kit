import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAdr,
  evaluateAdr,
  adrIsEnforced,
  globToRegExp,
  extractImports,
  resolveRelative,
  isBuiltinSpecifier,
  type PackageResolver,
} from "./adr.js";
import { createNodeModulesResolver } from "./commands/adr.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const FORBID_IMPORT_PKG = FORBID_IMPORT.replace(
  `import = "^pg$"`,
  `import = "^pg$"\ntransitive = true\nfollow_packages = true`,
);

/**
 * A synthetic dependency tree: `wrapper` is an innocent-looking package whose entry point
 * reaches `pg` one relative hop later. This is the case the in-repo walk structurally cannot
 * see — the whole point of `follow_packages`.
 */
function makeNodeModulesFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "kit-adr-pkg-"));
  const lib = join(root, "node_modules", "wrapper", "lib");
  mkdirSync(lib, { recursive: true });
  writeFileSync(
    join(root, "node_modules", "wrapper", "package.json"),
    JSON.stringify({ name: "wrapper", version: "1.0.0", main: "lib/index.js" }),
  );
  writeFileSync(join(lib, "index.js"), "export { query } from './db.js'\n");
  writeFileSync(join(lib, "db.js"), "const { Client } = require('pg')\n");
  return root;
}

describe("forbid_import (follow_packages — across npm package boundaries)", () => {
  it("parses follow_packages, and it is off unless asked for", () => {
    const off = parseAdr(FORBID_IMPORT_T)!.rules[0] as { followPackages?: boolean };
    const on = parseAdr(FORBID_IMPORT_PKG)!.rules[0] as { followPackages?: boolean };
    assert.equal(off.followPackages, false);
    assert.equal(on.followPackages, true);
  });

  it("flags reaching pg THROUGH a wrapper dependency, naming the chain", () => {
    const root = makeNodeModulesFixture();
    const files = [{ path: "src/web/h.ts", content: "import { query } from 'wrapper'\n" }];
    const v = evaluateAdr(parseAdr(FORBID_IMPORT_PKG)!, files, {
      packages: createNodeModulesResolver(root),
    });
    assert.equal(v.length, 1);
    assert.equal(v[0].kind, "violation");
    assert.equal(v[0].file, "src/web/h.ts", "cited to the file the rule governs");
    assert.equal(v[0].detail, "pg");
    // The chain is shortened to package-relative keys, so it reads as a dependency path.
    assert.ok(v[0].message.includes("wrapper/lib/db.js"), v[0].message);
    assert.ok(!v[0].message.includes("node_modules"), "chain is not a wall of temp paths");
    rmSync(root, { recursive: true, force: true });
  });

  it("the same tree is invisible to a transitive rule WITHOUT follow_packages", () => {
    // Not a gap either: a bare leaf we were never asked to follow is honestly out of scope.
    const root = makeNodeModulesFixture();
    const v = evaluateAdr(
      parseAdr(FORBID_IMPORT_T)!,
      [{ path: "src/web/h.ts", content: "import { query } from 'wrapper'\n" }],
      { packages: createNodeModulesResolver(root) },
    );
    assert.equal(v.length, 0);
    rmSync(root, { recursive: true, force: true });
  });

  it("degrades to the in-repo walk when no resolver is injected (never a crash)", () => {
    const v = evaluateAdr(parseAdr(FORBID_IMPORT_PKG)!, [
      { path: "src/web/h.ts", content: "import { query } from 'wrapper'\n" },
    ]);
    assert.equal(v.length, 0);
  });

  it("a bare specifier that resolves to nothing is a gap, not a pass", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-adr-empty-"));
    const v = evaluateAdr(
      parseAdr(FORBID_IMPORT_PKG)!,
      [{ path: "src/web/h.ts", content: "import x from 'not-installed'\n" }],
      { packages: createNodeModulesResolver(root) },
    );
    assert.equal(v.length, 1);
    assert.equal(v[0].kind, "gap");
    assert.ok(v[0].message.includes('unresolved import "not-installed"'), v[0].message);
    rmSync(root, { recursive: true, force: true });
  });

  it("node builtins stay leaves — following them would gap on every file", () => {
    assert.equal(isBuiltinSpecifier("node:fs"), true);
    assert.equal(isBuiltinSpecifier("path/posix"), true);
    assert.equal(isBuiltinSpecifier("pg"), false);
    const root = mkdtempSync(join(tmpdir(), "kit-adr-builtin-"));
    const v = evaluateAdr(
      parseAdr(FORBID_IMPORT_PKG)!,
      [
        {
          path: "src/web/h.ts",
          content: "import { readFileSync } from 'node:fs'\nimport 'path'\n",
        },
      ],
      { packages: createNodeModulesResolver(root) },
    );
    assert.equal(v.length, 0);
    rmSync(root, { recursive: true, force: true });
  });

  it("the depth bound reports a gap instead of silently stopping", () => {
    const root = makeNodeModulesFixture();
    const v = evaluateAdr(
      parseAdr(FORBID_IMPORT_PKG)!,
      [{ path: "src/web/h.ts", content: "import { query } from 'wrapper'\n" }],
      { packages: createNodeModulesResolver(root), maxPackageDepth: 0 },
    );
    assert.equal(v.length, 1);
    assert.equal(v[0].kind, "gap", "a bounded walk is unproven, never clean");
    assert.ok(v[0].message.includes("depth 0"), v[0].message);
    rmSync(root, { recursive: true, force: true });
  });

  it("the node bound reports a gap instead of silently stopping", () => {
    const v = evaluateAdr(
      parseAdr(FORBID_IMPORT_PKG)!,
      [
        { path: "src/web/h.ts", content: "import { q } from '../data/a.js'\n" },
        { path: "src/data/a.ts", content: "import { q } from './b.js'\n" },
        { path: "src/data/b.ts", content: "import { Client } from 'pg'\n" },
      ],
      { maxNodes: 1 },
    );
    assert.equal(v.length, 1);
    assert.equal(v[0].kind, "gap");
    assert.ok(v[0].message.includes("walk truncated"), v[0].message);
  });

  it("a module that resolves but cannot be READ is a gap, not a pass", () => {
    const unreadable: PackageResolver = {
      resolve: () => "/somewhere/node_modules/wrapper/lib/index.js",
      read: () => null,
    };
    const v = evaluateAdr(
      parseAdr(FORBID_IMPORT_PKG)!,
      [{ path: "src/web/h.ts", content: "import { query } from 'wrapper'\n" }],
      { packages: unreadable },
    );
    assert.equal(v.length, 1);
    assert.equal(v[0].kind, "gap");
    assert.ok(v[0].message.includes("unreadable module wrapper/lib/index.js"), v[0].message);
  });
});

describe("createNodeModulesResolver", () => {
  it("resolves a package entry from main, a subpath, and a relative hop inside it", () => {
    const root = makeNodeModulesFixture();
    const r = createNodeModulesResolver(root);
    const entry = r.resolve("src/web/h.ts", "wrapper");
    assert.equal(entry, join(root, "node_modules", "wrapper", "lib", "index.js"));
    assert.equal(
      r.resolve("src/web/h.ts", "wrapper/lib/db.js"),
      join(root, "node_modules", "wrapper", "lib", "db.js"),
    );
    assert.equal(
      r.resolve(entry!, "./db.js"),
      join(root, "node_modules", "wrapper", "lib", "db.js"),
    );
    assert.equal(r.read(entry!)?.includes("./db.js"), true);
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null (→ gap) for anything it cannot resolve or read", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-adr-null-"));
    const r = createNodeModulesResolver(root);
    assert.equal(r.resolve("src/web/h.ts", "ghost-package"), null);
    assert.equal(r.resolve("src/web/h.ts", "#private/map"), null);
    assert.equal(r.resolve("src/web/h.ts", "./nope.js"), null);
    assert.equal(r.read(join(root, "nope.js")), null);
    rmSync(root, { recursive: true, force: true });
  });

  it("prefers exports over main, including a conditional exports object", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-adr-exports-"));
    const pkg = join(root, "node_modules", "modern");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "modern",
        main: "./legacy.cjs",
        exports: { ".": { import: "./esm.mjs", require: "./legacy.cjs" } },
      }),
    );
    writeFileSync(join(pkg, "esm.mjs"), "export const a = 1\n");
    writeFileSync(join(pkg, "legacy.cjs"), "module.exports = 1\n");
    assert.equal(
      createNodeModulesResolver(root).resolve("src/web/h.ts", "modern"),
      join(pkg, "esm.mjs"),
    );
    rmSync(root, { recursive: true, force: true });
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

describe("parseAdr — enforced_by", () => {
  const withFrontmatter = (extra: string): string =>
    `---\nid: ADR-0099\ntitle: T\nstatus: accepted\n${extra}---\n\n# body\n`;

  it("parses an inline list", () => {
    const adr = parseAdr(withFrontmatter("enforced_by: [src/a.test.ts, src/b.test.ts]\n"));
    assert.deepEqual(adr?.enforcedBy, ["src/a.test.ts", "src/b.test.ts"]);
  });

  it("parses a block list", () => {
    const adr = parseAdr(withFrontmatter("enforced_by:\n  - src/a.test.ts\n  - src/b.test.ts\n"));
    assert.deepEqual(adr?.enforcedBy, ["src/a.test.ts", "src/b.test.ts"]);
  });

  it("strips quotes", () => {
    const adr = parseAdr(withFrontmatter(`enforced_by: ["src/a.test.ts"]\n`));
    assert.deepEqual(adr?.enforcedBy, ["src/a.test.ts"]);
  });

  it("is an empty list when absent — the field is optional, never undefined", () => {
    // Callers iterate it directly; an undefined here would be a crash at the call site.
    assert.deepEqual(parseAdr(withFrontmatter(""))?.enforcedBy, []);
  });

  it("yields nothing rather than a guess for a shape it does not understand", () => {
    assert.deepEqual(parseAdr(withFrontmatter("enforced_by: src/a.test.ts\n"))?.enforcedBy, []);
  });
});
