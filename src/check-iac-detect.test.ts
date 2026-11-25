import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDockerfiles, findIac, findIacFiles } from "./check-iac-detect.js";
import { expectedTrivyConfigKey } from "./trivy-report.js";
import { runCli } from "./cli-run.test-support.js";
import { makeFixture, toml } from "./commands/scan.test-support.js";
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

describe("trivy container scan finds a Dockerfile below the root", () => {
  // Measured: with only `app/Dockerfile`, `trivy config (IaC)` found it and `trivy container
  // scan` said "no Dockerfile found", although it runs `trivy fs .` over the whole tree.
  it("findDockerfiles returns nested Dockerfiles and leaves out other IaC", async () => {
    const root = tree(["app/Dockerfile", "svc/x/Dockerfile.prod", "infra/main.tf", "compose.yaml"]);
    try {
      assert.deepEqual(await findDockerfiles(root), ["app/Dockerfile", "svc/x/Dockerfile.prod"]);
    } finally {
      rmTemp(root);
    }
  });

  it(
    "kit check does not skip the container scan when the Dockerfile is in a subdirectory",
    { skip: process.platform === "win32" ? "the fixture's fake `which` is a POSIX shell" : false },
    async (t) => {
      const fixture = makeFixture();
      t.after(() => rmTemp(fixture.dir));
      toml(fixture, "version = 1\n[memory]\ntrack_findings = false\n");
      mkdirSync(join(fixture.dir, "app"));
      writeFileSync(join(fixture.dir, "app", "Dockerfile"), "FROM scratch\n");
      const run = await runCli(["check", "--category", "security", "--json"], fixture.dir, {
        PATH: fixture.bin,
        KIT_NO_UPDATE_CHECK: "1",
        KIT_AUDIT_ANCHOR: "0",
        KIT_ADVISORIES: "0",
        KIT_BUMBLEBEE: "0",
        KIT_SEMGREP_CONFIG: "",
      });
      const rows = (JSON.parse(run.stdout) as { checks: { name: string; status: string }[] })
        .checks;
      const row = rows.find((r) => r.name === "trivy container scan");
      assert.ok(row, run.stdout);
      assert.notEqual(row.status, "skip", JSON.stringify(row));
      assert.doesNotMatch(JSON.stringify(row), /no Dockerfile found/);
    },
  );
});

describe("a Dockerfile named <name>.Dockerfile or Containerfile is found", () => {
  // kit-research decepticon-vs-kit E3: a tree whose only Dockerfiles were `containers/*.Dockerfile`
  // made both trivy rows skip with "no Dockerfile found". trivy itself reads that name.
  it("findIacFiles and findDockerfiles return them, and the trivy coverage key is a Dockerfile", async () => {
    const root = tree([
      "containers/app.Dockerfile",
      "svc/Containerfile",
      "notes/Dockerfile.md.bak",
    ]);
    try {
      const expected = [
        "containers/app.Dockerfile",
        "notes/Dockerfile.md.bak",
        "svc/Containerfile",
      ];
      assert.deepEqual(await findIacFiles(root), expected);
      assert.deepEqual(await findDockerfiles(root), expected);
      assert.equal(
        expectedTrivyConfigKey("containers/app.Dockerfile"),
        "dockerfile:containers/app.Dockerfile",
      );
      assert.equal(expectedTrivyConfigKey("svc/Containerfile"), "dockerfile:svc/Containerfile");
    } finally {
      rmTemp(root);
    }
  });

  it("does not take a name that only contains the word", async () => {
    const root = tree(["Dockerfile-notes.txt", "x.dockerfile.txt", "MyContainerfile"]);
    try {
      assert.deepEqual(await findIacFiles(root), []);
    } finally {
      rmTemp(root);
    }
  });
});
