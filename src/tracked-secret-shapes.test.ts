/**
 * The `secrets scan` fallback without TruffleHog, measured in kit-research#230: an unquoted
 * `OPENAI_API_KEY=sk-proj-…` in a committed AGENTS.md and a Stripe key in a committed dist bundle
 * both passed as "Git grep found no matches", while `kit security scan-staged` blocked them.
 * All keys below are synthetic.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { checkSecretsInCode } from "./check-security.js";
import { providerSecretLabels, scanTrackedProviderSecrets } from "./tracked-secret-shapes.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const OPENAI = "sk-proj-FAKE0not0a0real0key0000NOTREAL0000KEY00";
const STRIPE = "sk_test_0000FAKE0000NOTREAL0000KEY00";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-tracked-shapes-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  return dir;
}

/** A PATH with Git and without TruffleHog, so the fallback runs on every platform. */
function pathWithoutTrufflehog(): string {
  const finder = process.platform === "win32" ? "where" : "which";
  const git = execFileSync(finder, ["git"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
  return process.platform === "win32" ? dirname(git) : "/usr/bin:/bin";
}

async function fallbackScan(dir: string) {
  const previous = process.env.PATH;
  process.env.PATH = pathWithoutTrufflehog();
  try {
    return await checkSecretsInCode(dir);
  } finally {
    process.env.PATH = previous;
  }
}

describe("providerSecretLabels", () => {
  it("finds unquoted provider keys the grep fallback's assignment pattern misses", () => {
    const text = `OPENAI_API_KEY=${OPENAI}\nSTRIPE_SECRET_KEY=${STRIPE}\n`;
    assert.deepEqual(providerSecretLabels(text), ["ai-api-key", "stripe-key"]);
  });

  it("leaves generic and public-by-design shapes to the grep", () => {
    const publishable = "pk_live_0000FAKE0000NOTREAL0000KEY00";
    const firebase = "AIzaSyFAKE0000000000000000000000000000";
    const generic = 'password = "correct-horse-battery-staple-0000"';
    assert.deepEqual(providerSecretLabels(`${publishable}\n${firebase}\n${generic}\n`), []);
  });

  it("skips a placeholder whose tail is one repeated character", () => {
    assert.deepEqual(providerSecretLabels("sk_test_AAAAAAAAAAAAAAAAAAAA"), []);
  });
});

describe("scanTrackedProviderSecrets and the secrets scan row", () => {
  it("lists tracked files with provider keys, and not test files or untracked ones", async () => {
    const dir = repo({
      "AGENTS.md": `# Notes\n\nOPENAI_API_KEY=${OPENAI}\n`,
      "dist/assets/index-a1b2c3.js": `const k="${STRIPE}";\n`,
      "src/pay.test.ts": `const k = "${STRIPE}";\n`,
    });
    writeFileSync(join(dir, "untracked.md"), `KEY=${OPENAI}\n`);
    try {
      const { hits, gap } = await scanTrackedProviderSecrets(dir);
      assert.equal(gap, undefined);
      assert.deepEqual(hits, [
        { file: "AGENTS.md", labels: ["ai-api-key"] },
        { file: "dist/assets/index-a1b2c3.js", labels: ["stripe-key"] },
      ]);
    } finally {
      rmTemp(dir);
    }
  });

  it("fails the row without TruffleHog, and still says coverage is unverified", async () => {
    const dir = repo({ "AGENTS.md": `OPENAI_API_KEY=${OPENAI}\n` });
    execFileSync(
      "git",
      ["-c", "user.email=t@h.example", "-c", "user.name=t", "commit", "-qm", "x"],
      {
        cwd: dir,
      },
    );
    try {
      const r = await fallbackScan(dir);
      assert.equal(r.status, "fail");
      assert.equal(r.severity, "high");
      assert.deepEqual(r.files, ["AGENTS.md"]);
      assert.match(r.detail, /AGENTS\.md \(ai-api-key\)/);
      assert.match(r.detail, /Coverage unverified/);
    } finally {
      rmTemp(dir);
    }
  });
});
