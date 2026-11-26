import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { checkFirebaseRules, locateRulesFiles } from "./check-firebase-rules.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function tree(spec: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-firebase-rules-"));
  for (const [rel, content] of Object.entries(spec)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

async function withTree<T>(
  spec: Record<string, string>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = tree(spec);
  try {
    return await fn(dir);
  } finally {
    rmTemp(dir);
  }
}

const firestore = (body: string): string =>
  `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${body}\n  }\n}\n`;

describe("checkFirebaseRules: verdicts", () => {
  it("fails an `if true` rule on every document, critical when it opens writes", async () => {
    const r = await withTree(
      {
        "firestore.rules": firestore(
          "    match /{document=**} {\n      allow read, write: if true;\n    }",
        ),
      },
      checkFirebaseRules,
    );
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "critical");
    assert.match(r.detail, /firestore\.rules:5 allow read, write if true on \/\{document=\*\*\}/);
  });

  it("fails a read-only allow with no condition as high", async () => {
    const r = await withTree(
      { "firestore.rules": firestore("    match /items/{id} {\n      allow read;\n    }") },
      checkFirebaseRules,
    );
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "high");
    assert.match(r.detail, /allow read with no condition on \/items\/\{id\}/);
  });

  it("warns on a signed-in-only rule over a wildcard match, not over a named collection", async () => {
    const wild = await withTree(
      {
        "firestore.rules": firestore(
          "    match /{coll}/{doc} {\n      allow read: if request.auth != null;\n    }",
        ),
      },
      checkFirebaseRules,
    );
    assert.equal(wild.status, "warn");
    assert.equal(wild.severity, "medium");
    assert.match(wild.detail, /signed-in user/);
    const named = await withTree(
      {
        "firestore.rules": firestore(
          "    match /invoices/{id} {\n      allow read: if request.auth != null;\n    }",
        ),
      },
      checkFirebaseRules,
    );
    assert.equal(named.status, "pass");
    assert.match(named.detail, /compared as text/);
  });

  it("reads storage.rules and ignores open rules that are commented out", async () => {
    const storage = [
      "service firebase.storage {",
      "  match /b/{bucket}/o {",
      "    match /{allPaths=**} {",
      "      // allow read, write: if true;",
      "      allow read, write: if request.auth != null;",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const r = await withTree({ "storage.rules": storage }, checkFirebaseRules);
    assert.equal(r.status, "warn");
    assert.match(
      r.detail,
      /storage\.rules:5 allow read, write if request\.auth != null on \/\{allPaths=\*\*\}/,
    );
  });
});

describe("checkFirebaseRules: which files", () => {
  it("skips with a reason when the project has no Firebase rules", async () => {
    const r = await withTree({ "package.json": "{}" }, checkFirebaseRules);
    assert.equal(r.status, "skip");
    assert.match(r.detail, /no Firebase rules files/);
  });

  it("reads the rules paths firebase.json names, in object and array form", async () => {
    const r = await withTree(
      {
        "firebase.json": JSON.stringify({
          firestore: [{ database: "(default)", rules: "rules/db.rules" }],
          storage: { rules: "rules/files.rules" },
        }),
        "rules/db.rules": firestore("    match /a/{id} {\n      allow write: if true;\n    }"),
        "rules/files.rules":
          "service firebase.storage { match /b/{bucket}/o { allow read: if false; } }",
      },
      checkFirebaseRules,
    );
    assert.equal(r.status, "fail");
    assert.match(r.detail, /in 2 rules files/);
    assert.match(r.detail, /db\.rules:5 allow write if true/);
  });

  it("does not read a named path outside the project and says the scan is incomplete", async () => {
    const r = await withTree(
      {
        "firebase.json": JSON.stringify({ firestore: { rules: "../outside.rules" } }),
        "firestore.rules": firestore("    match /a/{id} {\n      allow read: if false;\n    }"),
      },
      checkFirebaseRules,
    );
    assert.equal(r.status, "warn");
    assert.equal(r.didNotRun, true);
    assert.match(r.detail, /outside the project; not read/);
  });

  it("reports a named file that is missing and a file it could not finish", async () => {
    const r = await withTree(
      {
        "firebase.json": JSON.stringify({ storage: { rules: "gone.rules" } }),
        "firestore.rules": "service cloud.firestore { /* allow read: if true;",
      },
      checkFirebaseRules,
    );
    assert.equal(r.status, "warn");
    assert.equal(r.scanIncomplete, true);
    assert.match(r.detail, /gone\.rules, not found/);
    assert.match(r.detail, /unterminated block comment/);
  });

  it("names each file once", async () => {
    await withTree(
      { "firebase.json": JSON.stringify({ firestore: { rules: "./firestore.rules" } }) },
      async (dir) => {
        const { files } = await locateRulesFiles(dir);
        assert.deepEqual(files, ["firestore.rules", "storage.rules"]);
      },
    );
  });
});
