import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectStack } from "./stack-detector.js";

// The runtime pins detectStack takes from src/stack-runtime-pins.ts. Each fixture lives in its own
// mkdtemp directory, never a predictable name under the temp dir.
async function makeProject(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content, "utf-8");
  }
}

/** detectStack with the installed runtime versions fixed, so a test does not read this machine. */
function detectWith(dir: string, installed: Record<string, string | null>) {
  return detectStack(dir, { installedVersion: async (tool) => installed[tool] ?? null });
}

describe("detectStack: a declared range is kept, not narrowed to its floor", () => {
  it("engines >=20.0.0 pins the installed Node 22, not 20", async () => {
    // `>=20.0.0` became `node = "20"`, and `kit init` then failed on the Node 22 it ran on.
    const dir = await mkdtemp(join(tmpdir(), "kit-detect-engines-"));
    await makeProject(dir, { "package.json": JSON.stringify({ engines: { node: ">=20.0.0" } }) });
    try {
      assert.equal((await detectWith(dir, { node: "22.22.0" })).tools.node, "22");
      assert.equal((await detectWith(dir, { node: "18.19.0" })).tools.node, "20", "outside: floor");
      assert.equal((await detectWith(dir, { node: null })).tools.node, "20", "none: floor");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("detectStack: Python is detected from what the repo declares", () => {
  async function py(files: Record<string, string>, installed: string | null = "3.11.17") {
    const dir = await mkdtemp(join(tmpdir(), "kit-detect-py-"));
    await makeProject(dir, files);
    try {
      return await detectWith(dir, { python: installed });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("a pyproject holding only tool config is not a Python project", async () => {
    const s = await py({ "pyproject.toml": '[tool.pyright]\nvenvPath = "app"\n' });
    assert.notEqual(s.language, "python");
    assert.equal(s.tools.uv, undefined);
  });

  it("uv only with uv.lock or [tool.uv]", async () => {
    const project = '[project]\nname = "x"\n';
    assert.equal((await py({ "pyproject.toml": project })).tools.uv, undefined);
    assert.equal((await py({ "pyproject.toml": project, "uv.lock": "" })).tools.uv, "latest");
    const toolUv = `${project}[tool.uv]\ndev-dependencies = []\n`;
    assert.equal((await py({ "pyproject.toml": toolUv })).tools.uv, "latest");
    assert.equal((await py({ "requirements.txt": "flask\n" })).tools.uv, undefined);
  });

  it("no Python pin unless the repo declares one", async () => {
    const project = '[project]\nname = "x"\n';
    assert.equal((await py({ "pyproject.toml": project })).tools.python, undefined);
    const pinned = { "pyproject.toml": project, ".python-version": "3.11\n" };
    assert.equal((await py(pinned)).tools.python, "3.11");
    const ranged = '[project]\nname = "x"\nrequires-python = ">=3.10"\n';
    assert.equal((await py({ "pyproject.toml": ranged })).tools.python, "3.11", "installed fits");
    const outside = await py({ "pyproject.toml": ranged }, "3.9.18");
    assert.equal(outside.tools.python, undefined, "installed outside the range: no pin");
  });
});
