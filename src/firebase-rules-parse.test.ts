import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  blankComments,
  documentSegments,
  isOpenCondition,
  isSignedInOnly,
  isWildcardMatch,
  parseRules,
} from "./firebase-rules-parse.js";

const DOCS = "/databases/{database}/documents";

describe("parseRules: statements and paths", () => {
  it("reads a one-line allow with its nested match path", () => {
    const src = [
      "rules_version = '2';",
      "service cloud.firestore {",
      "  match /databases/{database}/documents {",
      "    match /{document=**} {",
      "      allow read, write: if true;",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const { allows, incomplete } = parseRules(src);
    assert.equal(incomplete, null);
    assert.deepEqual(allows, [
      {
        line: 5,
        methods: ["read", "write"],
        condition: "true",
        path: `${DOCS}/{document=**}`,
      },
    ]);
  });

  it("reads a condition that spans lines and one with no condition", () => {
    const src = `service cloud.firestore { match ${DOCS} { match /items/{id} {
      allow read: if
        request.auth != null
        && request.auth.uid == resource.data.owner;
      allow create;
    } } }`;
    const { allows } = parseRules(src);
    assert.equal(allows.length, 2);
    assert.equal(
      allows[0].condition,
      "request.auth != null && request.auth.uid == resource.data.owner",
    );
    assert.equal(allows[0].line, 2);
    assert.equal(allows[1].condition, null);
    assert.deepEqual(allows[1].methods, ["create"]);
  });

  it("ends a statement without a semicolon at the next allow or the closing brace", () => {
    const src = `match /a/{x} {
      allow read: if true
      allow write: if false
    }`;
    const { allows, incomplete } = parseRules(src);
    assert.equal(incomplete, null);
    assert.deepEqual(
      allows.map((a) => a.condition),
      ["true", "false"],
    );
  });

  it("keeps sibling and nested match paths apart", () => {
    const src = `match /a/{x} { allow read: if false; match /sub/{y} { allow get: if true; } }
      match /b/{z} { allow list: if true; }`;
    const paths = parseRules(src).allows.map((a) => a.path);
    assert.deepEqual(paths, ["/a/{x}", "/a/{x}/sub/{y}", "/b/{z}"]);
  });
});

describe("parseRules: comments, functions and broken files", () => {
  it("ignores allow statements inside line and block comments", () => {
    const src = `match /a/{x} {
      // allow read, write: if true;
      /* allow read: if true;
         allow write; */
      allow read: if request.auth.uid == x; // trailing
    }`;
    const { allows } = parseRules(src);
    assert.equal(allows.length, 1);
    assert.equal(allows[0].condition, "request.auth.uid == x");
    assert.equal(allows[0].line, 5);
  });

  it("skips function bodies, including braces and the word allow in strings", () => {
    const src = `match /a/{x} {
      function owner(d) { return d.data.tag == '}allow'; }
      allow read: if owner(resource);
    }`;
    const { allows, incomplete } = parseRules(src);
    assert.equal(incomplete, null);
    assert.equal(allows.length, 1);
    assert.equal(allows[0].condition, "owner(resource)");
  });

  it("reports an unterminated block comment and unbalanced braces", () => {
    assert.equal(
      parseRules("match /a/{x} { /* allow read: if true; }").incomplete,
      "unterminated block comment",
    );
    assert.equal(
      parseRules("match /a/{x} { allow read: if false;").incomplete,
      "unbalanced braces",
    );
  });

  it("blanks comments but keeps newlines and comment markers inside strings", () => {
    const { text } = blankComments("a // b\nc '//d' /* e\nf */ g");
    assert.equal(text, "a     \nc '//d'     \n     g");
  });
});

describe("firebase rule predicates", () => {
  it("treats `true`, `(true)` and a missing condition as open", () => {
    assert.ok(isOpenCondition("true"));
    assert.ok(isOpenCondition("( true )"));
    assert.ok(isOpenCondition(null));
    assert.ok(!isOpenCondition("false"));
    assert.ok(!isOpenCondition("true && request.auth != null"));
  });

  it("recognises a signed-in-only condition and nothing narrower", () => {
    assert.ok(isSignedInOnly("request.auth != null"));
    assert.ok(isSignedInOnly("(request.auth.uid != null)"));
    assert.ok(!isSignedInOnly("request.auth != null && request.auth.uid == uid"));
    assert.ok(!isSignedInOnly(null));
  });

  it("finds a wildcard below the Firestore and Storage roots", () => {
    assert.ok(isWildcardMatch(`${DOCS}/{document=**}`));
    assert.ok(isWildcardMatch(`${DOCS}/{coll}/{doc}`));
    assert.ok(isWildcardMatch("/b/{bucket}/o/{allPaths=**}"));
    assert.ok(!isWildcardMatch(`${DOCS}/invoices/{id}`));
    assert.ok(!isWildcardMatch(DOCS));
    assert.deepEqual(documentSegments("/b/{bucket}/o/u/{f}"), ["u", "{f}"]);
  });
});
