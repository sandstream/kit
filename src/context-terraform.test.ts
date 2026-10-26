import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terraformFindings } from "./context-terraform.js";
import { uncheckedContext } from "./context-unchecked.js";
import { rmTemp } from "./temp-cleanup.test-support.js";
import type { ContextConfig } from "./config.js";

function repo(state?: unknown, workspace?: string, sub = "."): string {
  const root = mkdtempSync(join(tmpdir(), "kit-tf-"));
  const tf = join(root, sub, ".terraform");
  mkdirSync(tf, { recursive: true });
  if (state !== undefined) writeFileSync(join(tf, "terraform.tfstate"), JSON.stringify(state));
  if (workspace !== undefined) writeFileSync(join(tf, "environment"), workspace);
  return root;
}
const backend = (bucket: string, prefix: string) => ({ backend: { config: { bucket, prefix } } });
const declare = (t: object): ContextConfig => ({ terraform: t }) as unknown as ContextConfig;
const by = (f: { field: string; status: string }[]) =>
  Object.fromEntries(f.map((x) => [x.field, x.status]));

describe("terraform context", () => {
  it("passes when the stored backend matches the declared bucket, prefix and workspace", () => {
    const root = repo(backend("acme-state-dev", "env/dev"), "dev");
    try {
      const f = terraformFindings(
        declare({ bucket: "acme-state-dev", prefix: "env/dev", workspace: "dev" }),
        root,
      );
      assert.deepEqual(by(f), { bucket: "ok", prefix: "ok", workspace: "ok" });
    } finally {
      rmTemp(root);
    }
  });

  it("flags the stage bucket when dev is declared", () => {
    const root = repo(backend("acme-state-stage", "env/dev"));
    try {
      const f = terraformFindings(declare({ bucket: "acme-state-dev" }), root);
      assert.equal(f[0].status, "mismatch");
      assert.equal(f[0].actual, "acme-state-stage");
    } finally {
      rmTemp(root);
    }
  });

  it("is unknown when .terraform is missing, for every declared field", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-tf-"));
    try {
      const f = terraformFindings(declare({ bucket: "b", workspace: "w" }), root);
      assert.deepEqual(by(f), { bucket: "unknown", workspace: "unknown" });
    } finally {
      rmTemp(root);
    }
  });

  it("is unknown when the state file is not JSON", () => {
    const root = repo();
    writeFileSync(join(root, ".terraform", "terraform.tfstate"), "{not json");
    try {
      assert.equal(terraformFindings(declare({ bucket: "b" }), root)[0].status, "unknown");
    } finally {
      rmTemp(root);
    }
  });

  it("reads the default workspace when .terraform has no environment file", () => {
    const root = repo(backend("b", "p"));
    try {
      const f = terraformFindings(declare({ workspace: "default" }), root);
      assert.equal(f[0].status, "ok");
    } finally {
      rmTemp(root);
    }
  });

  it("reads from a declared subdirectory", () => {
    const root = repo(backend("b", "p"), undefined, "infra/dev");
    try {
      const f = terraformFindings(declare({ dir: "infra/dev", bucket: "b" }), root);
      assert.equal(f.find((x) => x.field === "bucket")?.status, "ok");
    } finally {
      rmTemp(root);
    }
  });
});

describe("terraform context dir", () => {
  it("refuses a dir outside the repository, absolute or with ..", () => {
    const root = repo(backend("b", "p"));
    try {
      for (const dir of ["../elsewhere", "/etc", "a/../../x"]) {
        const f = terraformFindings(declare({ dir, bucket: "b" }), root);
        assert.equal(f[0].field, "dir");
        assert.equal(f[0].status, "mismatch");
      }
    } finally {
      rmTemp(root);
    }
  });

  it("refuses a dir that is a symlink out of the repository", () => {
    const root = repo(backend("b", "p"));
    const outside = repo(backend("b", "p"));
    try {
      symlinkSync(outside, join(root, "link"));
      const f = terraformFindings(declare({ dir: "link", bucket: "b" }), root);
      assert.equal(f[0].field, "dir");
      assert.equal(f[0].status, "mismatch");
    } finally {
      rmTemp(root);
      rmTemp(outside);
    }
  });

  it("checks nothing when terraform is not declared", () => {
    assert.deepEqual(terraformFindings(undefined, "."), []);
    assert.deepEqual(terraformFindings({} as ContextConfig, "."), []);
  });

  it("the terraform section and its keys are known to the unchecked report", () => {
    assert.deepEqual(
      uncheckedContext(declare({ bucket: "b", prefix: "p", workspace: "w", dir: "d" })),
      [],
    );
  });
});
