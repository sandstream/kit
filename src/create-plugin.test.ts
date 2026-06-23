import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPlugin } from "./create-plugin.js";

let tmpDir: string;

before(async () => {
  tmpDir = join(tmpdir(), `kit-create-plugin-test-${process.pid}`);
  await mkdir(tmpDir, { recursive: true });
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("createPlugin", () => {
  it("creates plugin directory with correct package name", async () => {
    const result = await createPlugin({ name: "test-svc", cwd: tmpDir, skipInstall: true });
    assert.equal(result.success, true);
    assert.equal(result.packageName, "kit-plugin-test-svc");
    assert(result.pluginDir.endsWith("kit-plugin-test-svc"));
  });

  it("strips kit-plugin- prefix if user passes full name", async () => {
    const result = await createPlugin({
      name: "kit-plugin-already-prefixed",
      cwd: tmpDir,
      skipInstall: true,
    });
    assert.equal(result.packageName, "kit-plugin-already-prefixed");
  });

  it("creates package.json with correct name", async () => {
    await createPlugin({ name: "pkg-check", cwd: tmpDir, skipInstall: true });
    const raw = await readFile(join(tmpDir, "kit-plugin-pkg-check", "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { name: string; type: string };
    assert.equal(pkg.name, "kit-plugin-pkg-check");
    assert.equal(pkg.type, "module");
  });

  it("creates tsconfig.json", async () => {
    await createPlugin({ name: "ts-check", cwd: tmpDir, skipInstall: true });
    const raw = await readFile(join(tmpDir, "kit-plugin-ts-check", "tsconfig.json"), "utf-8");
    const tsconfig = JSON.parse(raw) as { compilerOptions: { module: string } };
    assert.equal(tsconfig.compilerOptions.module, "Node16");
  });

  it("creates src/index.ts that exports { adapter }", async () => {
    await createPlugin({ name: "idx-check", cwd: tmpDir, skipInstall: true });
    const src = await readFile(join(tmpDir, "kit-plugin-idx-check", "src", "index.ts"), "utf-8");
    assert(src.includes("adapter"), "index.ts should export 'adapter'");
  });

  it("creates adapter source file", async () => {
    await createPlugin({ name: "src-check", cwd: tmpDir, skipInstall: true });
    const src = await readFile(
      join(tmpDir, "kit-plugin-src-check", "src", "src-check.ts"),
      "utf-8",
    );
    assert(src.includes("ServiceAdapter"), "should import ServiceAdapter type");
    assert(src.includes("getRequiredTools"), "should implement getRequiredTools");
    assert(src.includes("check"), "should implement check");
    assert(src.includes("provision"), "should implement provision");
  });

  it("creates test file", async () => {
    await createPlugin({ name: "test-file-check", cwd: tmpDir, skipInstall: true });
    const src = await readFile(
      join(tmpDir, "kit-plugin-test-file-check", "src", "test-file-check.test.ts"),
      "utf-8",
    );
    assert(src.includes("node:test"), "should use node:test");
    assert(src.includes("describe"), "should have describe block");
  });

  it("creates README.md", async () => {
    await createPlugin({ name: "readme-check", cwd: tmpDir, skipInstall: true });
    const readme = await readFile(join(tmpDir, "kit-plugin-readme-check", "README.md"), "utf-8");
    assert(readme.includes("kit-plugin-readme-check"), "README should mention package name");
    assert(readme.includes("kitPlugins"), "README should mention kitPlugins");
  });

  it("returns nextSteps array", async () => {
    const result = await createPlugin({ name: "steps-check", cwd: tmpDir, skipInstall: true });
    assert(Array.isArray(result.nextSteps));
    assert(result.nextSteps.length > 0);
    assert(result.nextSteps.some((s) => s.includes("npm run build")));
    assert(result.nextSteps.some((s) => s.includes("npm test")));
  });

  it("generated package.json has typescript as devDependency", async () => {
    await createPlugin({ name: "sdk-dep-check", cwd: tmpDir, skipInstall: true });
    const raw = await readFile(join(tmpDir, "kit-plugin-sdk-dep-check", "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { devDependencies: Record<string, string> };
    // typescript is the only devDep needed — SDK types are bundled in src/types/
    assert(pkg.devDependencies["typescript"], "should have typescript devDep");
  });

  it("creates bundled adapter-sdk type stub", async () => {
    await createPlugin({ name: "stub-check", cwd: tmpDir, skipInstall: true });
    const stub = await readFile(
      join(tmpDir, "kit-plugin-stub-check", "src", "types", "adapter-sdk.d.ts"),
      "utf-8",
    );
    assert(stub.includes("ServiceAdapter"), "stub should define ServiceAdapter");
    assert(stub.includes("AdapterContext"), "stub should define AdapterContext");
    assert(stub.includes("ProvisionResult"), "stub should define ProvisionResult");
  });
});
