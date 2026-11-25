import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { checkCodeGuardrails } from "./check-code-guardrails.js";
import { checkSecurity } from "./check-security.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-code-guardrails-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    put(path: string, content: string) {
      const target = join(root, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    },
  };
}

it("detects public cloud access in shell commands, including continued commands", async (t) => {
  const f = fixture(t);
  f.put(
    "deploy.sh",
    "#!/bin/sh\ngcloud run deploy app \\\n  --allow-unauthenticated\ngcloud projects add-iam-policy-binding p --member=allUsers\n",
  );
  f.put(
    "safe.sh",
    "#!/bin/sh\n# gcloud run deploy app --ingress=all\ngcloud run deploy app --ingress=internal\n",
  );
  const result = (await checkCodeGuardrails(f.root)).find(
    (row) => row.name === "public cloud command",
  );
  assert.equal(result?.status, "fail");
  assert.match(result?.detail ?? "", /deploy\.sh:2/);
  assert.match(result?.detail ?? "", /deploy\.sh:4/);
  assert.doesNotMatch(result?.detail ?? "", /safe\.sh/);
});

it("detects open ingress and all-address ranges in workflow commands", async (t) => {
  const f = fixture(t);
  f.put(
    ".github/workflows/deploy.yml",
    "jobs:\n  deploy:\n    steps:\n      - run: gcloud run deploy app --ingress=all\n      - run: aws ec2 authorize-security-group-ingress --cidr 0.0.0.0/0\n",
  );
  const result = (await checkCodeGuardrails(f.root)).find(
    (row) => row.name === "public cloud command",
  );
  assert.equal(result?.status, "fail");
  assert.match(result?.detail ?? "", /deploy\.yml:4/);
  assert.match(result?.detail ?? "", /deploy\.yml:5/);
});

it("ignores comments and text that only prints a cloud command", async (t) => {
  const f = fixture(t);
  f.put(
    "deploy.sh",
    "#!/bin/sh\n# gcloud run deploy app --allow-unauthenticated\necho 'gcloud run deploy app --allow-unauthenticated'\ngcloud config list; echo --ingress=all\n",
  );
  const result = (await checkCodeGuardrails(f.root)).find(
    (row) => row.name === "public cloud command",
  );
  assert.equal(result?.status, "pass");
});

it("detects literal secrets in Dockerfile ENV without printing their values", async (t) => {
  const f = fixture(t);
  f.put(
    "Dockerfile",
    "FROM alpine\nENV API_TOKEN=secretvalue \\\n  DB_PASSWORD='another-secret'\nENV REFERENCED_SECRET=${VAULT_SECRET}\n",
  );
  const result = (await checkCodeGuardrails(f.root)).find(
    (row) => row.name === "literal Dockerfile secret",
  );
  assert.equal(result?.status, "fail");
  assert.match(result?.detail ?? "", /API_TOKEN/);
  assert.match(result?.detail ?? "", /DB_PASSWORD/);
  assert.doesNotMatch(result?.detail ?? "", /secretvalue|another-secret|REFERENCED_SECRET/);
});

it("detects the legacy Dockerfile ENV form", async (t) => {
  const f = fixture(t);
  f.put("Dockerfile", "FROM alpine\nENV SERVICE_PASSWORD my-password\n");
  const result = (await checkCodeGuardrails(f.root)).find(
    (row) => row.name === "literal Dockerfile secret",
  );
  assert.equal(result?.status, "fail");
  assert.match(result?.detail ?? "", /SERVICE_PASSWORD/);
  assert.doesNotMatch(result?.detail ?? "", /my-password/);
});

it("blocks when the required Dockerfile inspector is missing or returns no report", async (t) => {
  const f = fixture(t);
  for (const inspector of [null, async () => null]) {
    const rows = await checkCodeGuardrails(f.root, inspector);
    const docker = rows.find((row) => row.name === "literal Dockerfile secret");
    assert.equal(docker?.status, "fail");
    assert.equal(docker?.didNotRun, true);
    assert.equal(rows.find((row) => row.name === "public cloud command")?.status, "pass");
  }
});

it("passes the governed root to the Dockerfile inspector and derives the finding in Kit", async (t) => {
  const f = fixture(t);
  const rows = await checkCodeGuardrails(f.root, async (root) => {
    assert.equal(root, f.root);
    return { hits: [{ file: "Dockerfile", line: 2, indicator: "API_TOKEN" }], errors: [] };
  });
  const docker = rows.find((row) => row.name === "literal Dockerfile secret");
  assert.equal(docker?.status, "fail");
  assert.deepEqual(docker?.files, ["Dockerfile"]);
  assert.match(docker?.detail ?? "", /Dockerfile:2 \(API_TOKEN\)/);
});

it("detects a commented-out security guard but accepts active code", async (t) => {
  const f = fixture(t);
  f.put(
    "src/access.ts",
    "if (!authorized) {\n  // throw new Error('denied');\n}\nif (!ready) {\n  return false;\n}\n",
  );
  const result = (await checkCodeGuardrails(f.root)).find(
    (row) => row.name === "commented-out guard",
  );
  assert.equal(result?.status, "fail");
  assert.match(result?.detail ?? "", /src\/access\.ts:1/);
  assert.doesNotMatch(result?.detail ?? "", /:4/);
});

it("requires a reason for each inline suppression", async (t) => {
  const f = fixture(t);
  f.put(
    "deploy.sh",
    "# kit-ignore L2-cloud-public: public demo endpoint\ngcloud run deploy app --allow-unauthenticated\n",
  );
  f.put(
    "Dockerfile",
    "FROM alpine\n# kit-ignore L2-docker-env-secret: fixture only\nENV API_TOKEN=example\n",
  );
  f.put(
    "src/access.ts",
    "// kit-ignore L2-commented-guard: example of disabled guard\nif (!authorized) {\n  // throw new Error('denied');\n}\n",
  );
  const results = await checkCodeGuardrails(f.root);
  assert.deepEqual(
    results.map((row) => row.status),
    ["pass", "pass", "pass"],
  );
  f.put(
    "deploy.sh",
    "# kit-ignore L2-cloud-public:\ngcloud run deploy app --allow-unauthenticated\n",
  );
  const repeat = await checkCodeGuardrails(f.root);
  assert.equal(repeat.find((row) => row.name === "public cloud command")?.status, "fail");
});

it("includes the three rules in the project security check", async (t) => {
  const f = fixture(t);
  f.put("deploy.sh", "gcloud run deploy app --allow-unauthenticated\n");
  const rows = await checkSecurity(f.root, "project");
  assert.deepEqual(
    rows
      .filter((row) =>
        ["public cloud command", "literal Dockerfile secret", "commented-out guard"].includes(
          row.name,
        ),
      )
      .map((row) => [row.name, row.status]),
    [
      ["public cloud command", "fail"],
      ["literal Dockerfile secret", "pass"],
      ["commented-out guard", "pass"],
    ],
  );
});

it("does not report a pass when a candidate source file cannot be scanned", async (t) => {
  const f = fixture(t);
  f.put("src/large.ts", "x".repeat(256 * 1024 + 1));
  const results = await checkCodeGuardrails(f.root);
  const guard = results.find((row) => row.name === "commented-out guard");
  assert.equal(guard?.status, "warn");
  assert.equal(guard?.didNotRun, true);
  assert.match(guard?.detail ?? "", /src\/large\.ts/);
});

it("an oversized source file marks only the row that reads it, and is named as skipped", async (t) => {
  // Measured: one 300 KB .tsx beside a Dockerfile made all three rows didNotRun, although
  // neither the cloud-command scan nor the Dockerfile scan reads a .tsx.
  const f = fixture(t);
  f.put("Dockerfile", "FROM alpine\n");
  f.put("src/logos.tsx", "A".repeat(300_000));
  const rows = await checkCodeGuardrails(f.root);
  const by = (name: string) => rows.find((row) => row.name === name);
  assert.equal(by("public cloud command")?.status, "pass");
  assert.equal(by("public cloud command")?.didNotRun, undefined);
  assert.equal(by("literal Dockerfile secret")?.status, "pass");
  assert.equal(by("literal Dockerfile secret")?.didNotRun, undefined);
  assert.equal(by("commented-out guard")?.status, "warn");
  assert.match(by("commented-out guard")?.detail ?? "", /skipped src\/logos\.tsx \(over 256 KB\)/);
});

it("an unreadable test file or Dockerfile marks only its own row", async (t) => {
  const f = fixture(t);
  f.put("src/big.test.ts", "x".repeat(256 * 1024 + 1));
  f.put("Dockerfile", "FROM alpine\n" + "#".repeat(256 * 1024 + 1));
  const rows = await checkCodeGuardrails(f.root);
  const by = (name: string) => rows.find((row) => row.name === name);
  assert.equal(by("literal Dockerfile secret")?.status, "warn");
  assert.equal(by("literal Dockerfile secret")?.didNotRun, true);
  assert.equal(by("public cloud command")?.status, "pass");
  assert.equal(by("commented-out guard")?.status, "pass", "the guard scan skips test files");
});

it("skips generated test-report trees instead of warning that they were not scanned", async (t) => {
  const f = fixture(t);
  for (const dir of [
    "playwright-report",
    "test-results",
    "blob-report",
    "storybook-static",
    ".turbo",
  ]) {
    f.put(`${dir}/trace/assets/bundle.js`, "x".repeat(256 * 1024 + 1));
  }
  f.put("src/app.ts", "export const ok = true;\n");
  const results = await checkCodeGuardrails(f.root);
  assert.deepEqual(
    results.map((row) => row.status),
    ["pass", "pass", "pass"],
  );
  assert.ok(results.every((row) => row.didNotRun !== true));
});
