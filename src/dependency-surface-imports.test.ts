import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importedPackages,
  packageOfSpecifier,
  scanSurfaceUsage,
  styleImportedPackages,
} from "./dependency-surface-imports.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

describe("packageOfSpecifier", () => {
  it("returns the package name for bare specifiers, scoped or not, with or without a subpath", () => {
    assert.equal(packageOfSpecifier("zod"), "zod");
    assert.equal(packageOfSpecifier("zod/v4"), "zod");
    assert.equal(packageOfSpecifier("@scope/pkg"), "@scope/pkg");
    assert.equal(packageOfSpecifier("@scope/pkg/sub/path.js"), "@scope/pkg");
  });

  it("returns null for relative, absolute, built-in and url specifiers", () => {
    for (const s of [
      "./a",
      "../a",
      "/abs",
      "node:fs",
      "fs",
      "path",
      "https://x/y.js",
      "#internal",
    ]) {
      assert.equal(packageOfSpecifier(s), null, s);
    }
  });
});

describe("importedPackages", () => {
  it("finds static, side-effect, dynamic, re-export and require forms", () => {
    const text = [
      'import a from "pkg-a";',
      "import { b } from 'pkg-b/sub';",
      'import "pkg-c";',
      'const d = await import("pkg-d");',
      'export * from "pkg-e";',
      'export { x } from "@s/pkg-f";',
      'const g = require("pkg-g");',
      'import type { T } from "pkg-h";',
    ].join("\n");
    assert.deepEqual([...importedPackages(text)].sort(), [
      "@s/pkg-f",
      "pkg-a",
      "pkg-b",
      "pkg-c",
      "pkg-d",
      "pkg-e",
      "pkg-g",
      "pkg-h",
    ]);
  });

  it("ignores relative and built-in imports", () => {
    const text = 'import a from "./a.js";\nimport fs from "node:fs";\nimport p from "path";\n';
    assert.deepEqual([...importedPackages(text)], []);
  });
});

describe("scanSurfaceUsage", () => {
  const project = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "kit-surface-usage-"));
    for (const [rel, body] of Object.entries(files)) {
      const path = join(dir, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, body);
    }
    return dir;
  };

  it("counts each source file once per package, and skips node_modules, dist and .git", async () => {
    const dir = project({
      "src/a.ts": 'import z from "zod";\nimport y from "zod/v4";\n',
      "src/b.ts": 'import z from "zod";\n',
      "src/c.js": 'const x = require("left-pad");\n',
      "node_modules/zod/index.js": 'import z from "zod";\n',
      "dist/a.js": 'import z from "zod";\n',
      ".git/x.js": 'import z from "zod";\n',
    });
    try {
      const u = await scanSurfaceUsage(dir, {});
      assert.equal(u.importSites.get("zod"), 2, "two files, not three imports");
      assert.equal(u.importSites.get("left-pad"), 1);
    } finally {
      rmTemp(dir);
    }
  });

  it("collects the scripts, config files and workflows that can run a tool", async () => {
    const dir = project({
      "eslint.config.js":
        'import js from "@eslint/js";\nexport default [js.configs.recommended];\n',
      ".prettierrc": '{"singleQuote": true}\n',
      ".github/workflows/ci.yml": "steps:\n  - run: npx knip\n",
      Dockerfile: "RUN npm ci\n",
      "notes.txt": "mentions secret-tool but is not a config\n",
    });
    try {
      const u = await scanSurfaceUsage(dir, { scripts: { build: "tsc -p ." } });
      assert.match(u.scriptText, /tsc -p \./);
      assert.match(u.scriptText, /@eslint\/js/);
      assert.match(u.scriptText, /singleQuote/);
      assert.match(u.scriptText, /npx knip/);
      assert.match(u.scriptText, /npm ci/);
      assert.doesNotMatch(u.scriptText, /secret-tool/);
    } finally {
      rmTemp(dir);
    }
  });

  it("stops at its file cap and says so, instead of scanning a huge tree for ever", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) files[`src/f${i}.ts`] = 'import z from "zod";\n';
    const dir = project(files);
    try {
      const u = await scanSurfaceUsage(dir, {}, { maxFiles: 10 });
      assert.equal(u.truncated, true);
      assert.ok((u.importSites.get("zod") ?? 0) <= 10);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("scanSurfaceUsage: production files and test files", () => {
  it("counts production imports apart from test imports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-surface-prod-"));
    const write = (rel: string, body: string): void => {
      const path = join(dir, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, body);
    };
    write("src/server.ts", 'import s from "sdk";\n');
    write("src/server.test.ts", 'import s from "sdk";\n');
    write("src/helpers.test-support.ts", 'import s from "sdk";\n');
    write("test/e2e.ts", 'import s from "sdk";\n');
    write("src/__tests__/x.ts", 'import s from "sdk";\n');
    try {
      const u = await scanSurfaceUsage(dir, {});
      assert.equal(u.importSites.get("sdk"), 5);
      assert.equal(u.productionImportSites?.get("sdk"), 1);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("scanSurfaceUsage: styles and budget", () => {
  it("counts a package a stylesheet imports or loads as a plugin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-surface-css-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "app.css"),
      '@import "tailwindcss";\n@plugin "tw-animate-css";\n@import "./local.css";\n@use "~sass-lib/mixins";\n',
    );
    try {
      const u = await scanSurfaceUsage(dir, {});
      assert.equal(u.importSites.get("tailwindcss"), 1);
      assert.equal(u.importSites.get("tw-animate-css"), 1);
      assert.equal(u.importSites.get("sass-lib"), 1);
      assert.equal(u.importSites.get("local.css"), undefined);
    } finally {
      rmTemp(dir);
    }
  });

  it("stops at its byte budget and says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-surface-bytes-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    for (let i = 0; i < 20; i++) {
      writeFileSync(
        join(dir, "src", `f${i}.ts`),
        `import z from "zod";\n${"// pad\n".repeat(200)}`,
      );
    }
    try {
      const u = await scanSurfaceUsage(dir, {}, { maxBytes: 5_000 });
      assert.equal(u.truncated, true);
      assert.ok((u.importSites.get("zod") ?? 0) < 20);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("styleImportedPackages", () => {
  it("reads import, plugin, config, use and forward, with or without url() and a leading tilde", () => {
    const css = [
      '@import "tailwindcss";',
      "@import url('normalize.css');",
      '@plugin "@tailwindcss/typography";',
      '@config "./tailwind.config.js";',
      '@use "~sass-lib/mixins";',
      "@forward 'other-lib';",
      '@import "./local";',
      '@import "https://fonts.example/css";',
    ].join("\n");
    assert.deepEqual([...styleImportedPackages(css)].sort(), [
      "@tailwindcss/typography",
      "other-lib",
      "sass-lib",
      "tailwindcss",
    ]);
  });
});

describe("scanSurfaceUsage: time budget", () => {
  it("stops at its time budget and says so, so a slow disk cannot stall kit check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-surface-time-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    for (let i = 0; i < 40; i++)
      writeFileSync(join(dir, "src", `f${i}.ts`), 'import z from "zod";\n');
    try {
      const u = await scanSurfaceUsage(dir, {}, { maxMillis: 0 });
      assert.equal(u.truncated, true);
      assert.ok((u.importSites.get("zod") ?? 0) < 40);
    } finally {
      rmTemp(dir);
    }
  });

  it("reads every file when the budget is generous, with the same counts as one at a time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-surface-par-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    for (let i = 0; i < 70; i++) {
      writeFileSync(
        join(dir, "src", `f${i}.ts`),
        `import z from "zod";\n${i % 2 ? 'import y from "yup";\n' : ""}`,
      );
    }
    try {
      const u = await scanSurfaceUsage(dir, {}, { maxMillis: 60_000 });
      assert.equal(u.truncated, false);
      assert.equal(u.importSites.get("zod"), 70);
      assert.equal(u.importSites.get("yup"), 35);
    } finally {
      rmTemp(dir);
    }
  });
});
