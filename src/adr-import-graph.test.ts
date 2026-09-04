import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateTransitiveImport,
  extractImports,
  isBuiltinSpecifier,
  resolveRelative,
} from "./adr-import-graph.js";

describe("ADR import graph substrate", () => {
  it("extracts and resolves TypeScript imports without treating builtins as packages", () => {
    const source = 'import fs from "node:fs";\nexport { value } from "./value.js";\n';
    assert.deepEqual(extractImports(source), [
      { specifier: "node:fs", line: 1 },
      { specifier: "./value.js", line: 2 },
    ]);
    assert.equal(
      resolveRelative("src/main.ts", "./value.js", new Set(["src/value.ts"])),
      "src/value.ts",
    );
    assert.equal(isBuiltinSpecifier("node:fs"), true);
    assert.equal(isBuiltinSpecifier("fs/promises"), true);
    assert.equal(isBuiltinSpecifier("left-pad"), false);
  });

  it("reports a forbidden import reached through a relative edge", () => {
    const contentByPath = new Map([
      ["src/start.ts", 'import "./middle.js";'],
      ["src/middle.ts", 'import client from "model-client";'],
    ]);
    const findings = evaluateTransitiveImport("ADR-TEST", {}, "src/start.ts", /^model-client$/, {
      fileSet: new Set(contentByPath.keys()),
      contentByPath,
      importsOf: (_path, content) => extractImports(content),
      maxPackageDepth: 3,
      maxNodes: 20,
    });

    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "violation");
    assert.match(findings[0].detail, /model-client/);
  });
});
