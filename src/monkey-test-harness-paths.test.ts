import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeMonkeyHarness } from "./monkey-test-harness.js";

async function withHarness(run: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "kit-monkey-paths-")));
  try {
    assert.equal((await writeMonkeyHarness(root)).ok, true);
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

it("refuses a scaffold hard-linked to protected operator configuration", async () => {
  await withHarness(async (root) => {
    const config = join(root, "playwright.monkey.config.ts");
    const before = await fs.readFile(config);
    const spec = join(root, "tests/monkey/monkey.spec.ts");
    await fs.rm(spec);
    await fs.link(config, spec);

    const result = await writeMonkeyHarness(root, { force: true });
    assert.ok((await fs.readFile(config)).equals(before), "protected config bytes changed");
    assert.equal(result.ok, false);
    assert.equal(
      result.writes.find((write) => write.path.endsWith("monkey.spec.ts"))?.action,
      "skipped",
    );
  });
});

for (const relative of ["tests/monkey", ".kit/monkey-test"]) {
  it(`refuses a linked parent directory: ${relative}`, async () => {
    await withHarness(async (root) => {
      const external = await fs.mkdtemp(join(tmpdir(), "kit-monkey-external-"));
      try {
        const target = join(external, "shared");
        await fs.rename(join(root, relative), target);
        await fs.symlink(target, join(root, relative));
        const names = await fs.readdir(target);
        const before = await Promise.all(names.map((name) => fs.readFile(join(target, name))));
        if (relative === "tests/monkey") {
          await fs.appendFile(join(target, "monkey.spec.ts"), "\n// shared edits\n");
          before[names.indexOf("monkey.spec.ts")] = await fs.readFile(
            join(target, "monkey.spec.ts"),
          );
        }
        const result = await writeMonkeyHarness(root, { force: true });
        for (const [index, name] of names.entries()) {
          assert.ok(
            (await fs.readFile(join(target, name))).equals(before[index]),
            `${name} bytes changed`,
          );
        }
        assert.deepEqual(await fs.readdir(target), names);
        assert.equal(result.ok, false);
      } finally {
        await fs.rm(external, { recursive: true, force: true });
      }
    });
  });
}

it("does not clobber config when a leaf becomes a symlink during init", async (t) => {
  await withHarness(async (root) => {
    const config = join(root, "playwright.monkey.config.ts");
    const before = await fs.readFile(config);
    const spec = join(root, "tests/monkey/monkey.spec.ts");
    await fs.appendFile(spec, "\n// stale generated scaffold\n");
    const mkdir = fs.mkdir;
    let swapped = false;
    t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
      if (!swapped && args[0] === dirname(spec)) {
        swapped = true;
        await fs.rm(spec);
        await fs.symlink(config, spec);
      }
      return mkdir(...args);
    });
    syncBuiltinESMExports();
    try {
      await writeMonkeyHarness(root, { force: true });
      assert.equal(swapped, true);
      assert.ok((await fs.readFile(config)).equals(before), "protected config bytes changed");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

it("preserves arbitrary operator bytes under ordinary and forced init", async () => {
  await withHarness(async (root) => {
    const paths = [
      "playwright.monkey.config.ts",
      ".kit/monkey-test/role-matrix.json",
      ".kit/monkey-test/expected-findings.example.json",
    ];
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0xff, 0x0d, 0x0a]);
    for (const path of paths) await fs.writeFile(join(root, path), bytes);
    for (const force of [false, true]) {
      assert.equal((await writeMonkeyHarness(root, { force })).ok, true);
      for (const path of paths) assert.deepEqual(await fs.readFile(join(root, path)), bytes);
    }
  });
});

for (const kind of ["symlink", "hardlink"]) {
  it(`keeps protected config intact when a ${kind} replaces the leaf at publication`, async (t) => {
    await withHarness(async (root) => {
      const config = join(root, "playwright.monkey.config.ts");
      const before = await fs.readFile(config);
      const spec = join(root, "tests/monkey/monkey.spec.ts");
      await fs.appendFile(spec, "\n// stale scaffold\n");
      const rename = fs.rename;
      let replaced = false;
      t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        if (args[1] === spec) {
          replaced = true;
          await fs.rm(spec);
          if (kind === "symlink") await fs.symlink(config, spec);
          else await fs.link(config, spec);
        }
        return rename(...args);
      });
      syncBuiltinESMExports();
      try {
        assert.equal((await writeMonkeyHarness(root, { force: true })).ok, true);
        assert.equal(replaced, true);
        assert.ok((await fs.readFile(config)).equals(before), "protected config bytes changed");
        assert.equal((await fs.lstat(spec)).isSymbolicLink(), false);
        assert.equal((await fs.stat(config)).nlink, 1);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  });
}

it("cleans owned staging files when publication fails and preserves existing contents", async (t) => {
  await withHarness(async (root) => {
    const spec = join(root, "tests/monkey/monkey.spec.ts");
    await fs.appendFile(spec, "\n// stale scaffold\n");
    const before = await fs.readFile(spec);
    const entries = await fs.readdir(dirname(spec));
    t.mock.method(fs, "rename", async () => {
      throw Object.assign(new Error("publication refused"), { code: "EACCES" });
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(writeMonkeyHarness(root, { force: true }), /publication refused/);
      assert.ok((await fs.readFile(spec)).equals(before), "existing spec bytes changed");
      assert.deepEqual(await fs.readdir(dirname(spec)), entries);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

it("does not replace an operator file created concurrently with first init", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "kit-monkey-create-")));
  const config = join(root, "playwright.monkey.config.ts");
  const link = fs.link;
  const bytes = Buffer.from("operator configuration\r\n");
  let created = false;
  t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
    if (args[1] === config) {
      created = true;
      await fs.writeFile(config, bytes, { flag: "wx" });
    }
    return link(...args);
  });
  syncBuiltinESMExports();
  try {
    const result = await writeMonkeyHarness(root);
    assert.equal(created, true);
    assert.equal(result.ok, false);
    assert.ok((await fs.readFile(config)).equals(bytes), "concurrent operator bytes changed");
    assert.deepEqual((await fs.readdir(root)).sort(), [
      ".kit",
      "playwright.monkey.config.ts",
      "tests",
    ]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
