import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findIac } from "./check-iac-detect.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function tree(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "kit-iac-"));
  for (const rel of files) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), "");
  }
  return root;
}

describe("findIac", () => {
  it("finds a Dockerfile in the root", async () => {
    const root = tree(["Dockerfile"]);
    try {
      assert.deepEqual(await findIac(root), ["."]);
    } finally {
      rmTemp(root);
    }
  });

  it("finds Dockerfiles and Terraform below a root that has none", async () => {
    const root = tree([
      "docker/Dockerfile",
      "docker/keycloak/Dockerfile.prod",
      "infra/ipf/dev/main.tf",
      "infra/ipf/stage/main.tf",
      "docker-compose.yaml",
    ]);
    try {
      assert.deepEqual(await findIac(root), [
        ".",
        "docker",
        "docker/keycloak",
        "infra/ipf/dev",
        "infra/ipf/stage",
      ]);
    } finally {
      rmTemp(root);
    }
  });

  it("does not count vendored or downloaded copies", async () => {
    const root = tree([
      "node_modules/x/Dockerfile",
      ".terraform/modules/m/main.tf",
      "vendor/y/Dockerfile",
      ".git/hooks/main.tf",
    ]);
    try {
      assert.deepEqual(await findIac(root), []);
    } finally {
      rmTemp(root);
    }
  });

  it("looks three levels down and no further", async () => {
    const root = tree(["a/b/c/Dockerfile", "a/b/c/d/Dockerfile"]);
    try {
      assert.deepEqual(await findIac(root), ["a/b/c"]);
    } finally {
      rmTemp(root);
    }
  });

  it("does not match a file that only ends in the name", async () => {
    const root = tree(["notDockerfile", "main.tf.bak", "composex.yml"]);
    try {
      assert.deepEqual(await findIac(root), []);
    } finally {
      rmTemp(root);
    }
  });

  it("is empty for an unreadable or missing root", async () => {
    assert.deepEqual(await findIac(join(tmpdir(), "kit-iac-does-not-exist")), []);
  });
});
