import { it } from "node:test";
import assert from "node:assert/strict";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function config(name: string) {
  const loaded = ts.readConfigFile(resolve(ROOT, name), ts.sys.readFile);
  assert.equal(loaded.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, ROOT);
  assert.deepEqual(parsed.errors, []);
  return parsed;
}

it("production compiler graph never pulls test modules or support into the published runtime", () => {
  const testBuild = config("tsconfig.json");
  assert.ok(
    testBuild.fileNames.some((file) => file.endsWith(".test-support.ts")),
    "fixture modules must still compile in the test build",
  );
  const production = config("tsconfig.prod.json");
  const program = ts.createProgram(production.fileNames, { ...production.options, noEmit: true });
  const files = program
    .getSourceFiles()
    .map((file) => relative(ROOT, file.fileName).replaceAll("\\", "/"));
  assert.ok(files.includes("src/cli.ts"));
  assert.deepEqual(
    files.filter((file) => file.startsWith("src/") && /\.test(?:-support)?\.ts$/.test(file)),
    [],
  );
});
