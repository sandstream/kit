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
  assert.deepEqual(
    results.map((row) => row.status),
    ["warn", "warn", "warn"],
  );
  assert.ok(results.every((row) => row.didNotRun === true));
});
