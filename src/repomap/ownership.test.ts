import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCodeowners, ownerFor, topAuthor } from "./ownership.js";

describe("repomap ownership — parseCodeowners", () => {
  it("parses rules, skipping comments and blanks; keeps order + multiple owners", () => {
    const text = `
      # a comment
      *            @default-team

      /src/exec-broker/  @broker-team @security   # inline comment
      *.md         @docs
    `;
    const rules = parseCodeowners(text);
    assert.deepEqual(rules, [
      { pattern: "*", owners: ["@default-team"] },
      { pattern: "/src/exec-broker/", owners: ["@broker-team", "@security"] },
      { pattern: "*.md", owners: ["@docs"] },
    ]);
  });
});

describe("repomap ownership — ownerFor (last match wins)", () => {
  const rules = parseCodeowners(`
    *                  @root
    *.ts               @ts-team
    /src/exec-broker/  @broker-team
    docs/              @docs-team
  `);

  it("falls through to the catch-all when nothing more specific matches", () => {
    assert.deepEqual(ownerFor("README", rules), ["@root"]);
  });

  it("matches an extension glob at any depth", () => {
    assert.deepEqual(ownerFor("src/foo/bar.ts", rules), ["@ts-team"]);
  });

  it("later, more specific anchored dir rule wins over the extension rule", () => {
    // both `*.ts` and `/src/exec-broker/` match this path; the dir rule is later → wins
    assert.deepEqual(ownerFor("src/exec-broker/broker.ts", rules), ["@broker-team"]);
  });

  it("a non-anchored dir pattern matches at any depth", () => {
    assert.deepEqual(ownerFor("packages/x/docs/guide.md", rules), ["@docs-team"]);
    assert.deepEqual(ownerFor("docs/guide.md", rules), ["@docs-team"]);
  });

  it("returns [] when no rule matches", () => {
    const only = parseCodeowners("/src/  @team");
    assert.deepEqual(ownerFor("test/x.ts", only), []);
  });
});

describe("repomap ownership — glob edge cases", () => {
  it("* does not cross a slash; ** does", () => {
    const star = parseCodeowners("/src/*.ts  @a");
    assert.deepEqual(ownerFor("src/x.ts", star), ["@a"]);
    assert.deepEqual(ownerFor("src/sub/x.ts", star), [], "* must not cross /");

    const dstar = parseCodeowners("/src/**/*.ts  @b");
    assert.deepEqual(ownerFor("src/sub/deep/x.ts", dstar), ["@b"]);
    assert.deepEqual(ownerFor("src/x.ts", dstar), ["@b"], "**/ collapses to zero dirs");
  });

  it("an anchored pattern does not match the same name nested elsewhere", () => {
    const anchored = parseCodeowners("/build/  @ops");
    assert.deepEqual(ownerFor("build/out.js", anchored), ["@ops"]);
    assert.deepEqual(
      ownerFor("packages/x/build/out.js", anchored),
      [],
      "leading / anchors to root",
    );
  });
});

describe("repomap ownership — topAuthor (git-blame fallback)", () => {
  it("returns the most frequent author", () => {
    assert.equal(topAuthor(["Ada", "Bo", "Ada", "Ada", "Bo"]), "Ada");
  });
  it("breaks ties alphabetically for determinism", () => {
    assert.equal(topAuthor(["Bo", "Ada"]), "Ada");
    assert.equal(topAuthor(["Zed", "Ada", "Zed", "Ada"]), "Ada");
  });
  it("ignores blank lines and returns null for no history", () => {
    assert.equal(topAuthor(["", "  ", "Ada", ""]), "Ada");
    assert.equal(topAuthor([]), null);
    assert.equal(topAuthor(["", "   "]), null);
  });
});
