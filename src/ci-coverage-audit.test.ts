import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditCiCoverage, auditDeploymentImageTags } from "./ci-coverage-audit.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function fixture(files: Record<string, string>, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "kit-ci-coverage-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(root, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    }
    run(root);
  } finally {
    rmTemp(root);
  }
}

describe("CI gate coverage", () => {
  it("warns when kit is installed but no pipeline runs its checks", () => {
    fixture({ ".kit.toml": "[tools]\nnode = '22'\n" }, (root) => {
      const rows = auditCiCoverage(root);
      assert.equal(rows[0]?.status, "warn");
      assert.match(rows[0]?.detail ?? "", /kit check/);
    });
  });

  it("recognizes executable CI steps and ignores comments", () => {
    fixture(
      {
        ".kit.toml": "[tools]\nnode = '22'\n",
        ".github/workflows/ci.yml": [
          "jobs:",
          "  test:",
          "    steps:",
          "      # run: kit scan",
          "      - run: npx sandstream-kit check --category security",
          "      - run: osv-scanner scan source -r .",
          "      - uses: aquasecurity/trivy-action@abcdef",
        ].join("\n"),
      },
      (root) => {
        const rows = auditCiCoverage(root);
        assert.equal(rows[0]?.status, "pass");
        assert.match(rows[0]?.detail ?? "", /kit check: present/);
        assert.match(rows[0]?.detail ?? "", /kit scan: missing/);
        assert.match(rows[0]?.detail ?? "", /osv: present/);
        assert.match(rows[0]?.detail ?? "", /trivy: present/);
      },
    );
  });

  it("recognizes GitLab and Bitbucket script gates", () => {
    fixture(
      {
        ".gitlab-ci.yml": "test:\n  script:\n    - kit scan --json\n",
        "bitbucket-pipelines.yml":
          "pipelines:\n  default:\n    - step:\n        script:\n          - kit check\n",
      },
      (root) => {
        const rows = auditCiCoverage(root);
        assert.equal(rows[0]?.status, "pass");
        assert.match(rows[0]?.detail ?? "", /kit scan: present/);
      },
    );
  });
});

describe("deployment image tags", () => {
  it("flags latest and branch refs in deploy scripts, compose and CI variables", () => {
    fixture(
      {
        "scripts/deploy.sh": "docker build -t app:latest .\n",
        "compose.yml": "services:\n  web:\n    image: example/app:${BRANCH_NAME}\n",
        ".github/workflows/deploy.yml":
          "jobs:\n  deploy:\n    env:\n      IMAGE_TAG: ${{ github.ref_name }}\n",
        ".gitlab-ci.yml": "variables:\n  IMAGE_TAG: $CI_COMMIT_REF_SLUG\n",
      },
      (root) => {
        const rows = auditDeploymentImageTags(root);
        assert.equal(rows[0]?.status, "warn");
        assert.equal(rows[0]?.files?.length, 4);
      },
    );
  });

  it("accepts immutable tags and does not treat CI base images as deployment images", () => {
    fixture(
      {
        "scripts/deploy.sh": "docker build -t app:v1.2.3 .\n",
        "compose.yml": "services:\n  web:\n    image: example/app@sha256:" + "a".repeat(64) + "\n",
        ".gitlab-ci.yml": "image: node:latest\nscript:\n  - npm test\n",
      },
      (root) => assert.equal(auditDeploymentImageTags(root)[0]?.status, "pass"),
    );
  });

  it("scans a deploy script at the project root", () => {
    fixture({ "deploy.sh": "docker push app:latest\n" }, (root) => {
      const [row] = auditDeploymentImageTags(root);
      assert.equal(row.status, "warn");
      assert.deepEqual(row.files, ["deploy.sh"]);
    });
  });

  it("skips when no deployment source exists", () => {
    fixture({}, (root) => assert.equal(auditDeploymentImageTags(root)[0]?.status, "skip"));
  });
});
