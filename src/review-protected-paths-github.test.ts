import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectPrProtectedPaths } from "./review-protected-paths-github.js";
import type { ReadCommand } from "./review-receipt-io.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const base = {
  release: { exact: [], prefix: [] },
  github: { exact: [], prefix: [".github/"] },
  secrets: { exact: [], prefix: ["src/secrets"] },
  permissions: { exact: [], prefix: [] },
};
const head = { ...base, permissions: { exact: ["src/new-policy.ts"], prefix: [] } };
const paths = ["src/renamed.ts", "src/new-policy.ts", ".github/kit-protected-paths.json"];

type Options = {
  baseFile?: unknown;
  headFile?: unknown;
  defaultFile?: unknown;
  files?: unknown;
  changeAt?: number;
  defaultChangeAt?: number;
  headChangeAt?: number;
  headCommit?: string;
};
const blob = (text: string) => ({ __typename: "Blob", text, isTruncated: false });
function commands(options: Options = {}): ReadCommand {
  let refs = 0;
  return (command, args) => {
    const call = [command, ...args].join(" ");
    if (call.includes("baseRefName baseRef")) {
      refs++;
      return JSON.stringify({
        data: {
          repository: {
            defaultBranchRef: {
              name: "main",
              target: {
                oid:
                  options.defaultChangeAt && refs >= options.defaultChangeAt
                    ? "d".repeat(40)
                    : BASE,
              },
            },
            pullRequest: {
              number: 7,
              headRefOid:
                options.headChangeAt && refs >= options.headChangeAt ? "e".repeat(40) : HEAD,
              baseRefName: "main",
              baseRef: {
                target: {
                  oid: options.changeAt && refs >= options.changeAt ? "c".repeat(40) : BASE,
                },
              },
            },
          },
        },
      });
    }
    if (call.includes("baseCommit:object"))
      return JSON.stringify({
        data: {
          repository: {
            baseCommit: { oid: BASE },
            headCommit: { oid: options.headCommit ?? HEAD },
            defaultCommit: { oid: BASE },
            defaultFile:
              options.defaultFile === undefined
                ? options.baseFile === undefined
                  ? blob(JSON.stringify(base))
                  : options.baseFile
                : options.defaultFile,
            baseFile:
              options.baseFile === undefined ? blob(JSON.stringify(base)) : options.baseFile,
            headFile:
              options.headFile === undefined ? blob(JSON.stringify(head)) : options.headFile,
          },
        },
      });
    if (call.includes("/pulls/7/files?per_page=100"))
      return JSON.stringify(
        options.files ?? [
          [
            { filename: paths[0], status: "renamed", previous_filename: "src/secrets-rotate.ts" },
            { filename: paths[1], status: "added" },
            { filename: paths[2], status: "modified" },
          ],
        ],
      );
    throw new Error(`unexpected command ${call}`);
  };
}
const collect = (options?: Options) =>
  collectPrProtectedPaths(
    "/tmp",
    { repo: "sandstream/kit", number: 7, head: HEAD },
    paths,
    commands(options),
  );

describe("PR protection rules", () => {
  it("applies base and proposed rules and protects the original name of a renamed file", () => {
    assert.deepEqual(collect().protectedPaths, [
      { path: "src/new-policy.ts", classes: ["permissions"] },
      { path: ".github/kit-protected-paths.json", classes: ["github"] },
      { path: "src/secrets-rotate.ts", classes: ["secrets"] },
    ]);
  });
  it("keeps base protection if the proposed rule file is deleted", () => {
    assert.ok(
      collect({ headFile: null }).protectedPaths.some(
        (entry) => entry.path === "src/secrets-rotate.ts",
      ),
    );
  });
  it("refuses truncated or invalid base rules and malformed proposed rules", () => {
    for (const baseFile of [{ __typename: "Blob", text: "{}", isTruncated: true }, blob("{}")]) {
      assert.throws(() => collect({ baseFile }));
    }
    assert.throws(() => collect({ headFile: blob("{}") }));
    assert.throws(() => collect({ headCommit: "c".repeat(40) }), /commit/i);
  });
  it("uses built-in rules when the base file is absent, without letting the proposed file remove them", () => {
    const empty = {
      release: { exact: [], prefix: [] },
      github: { exact: [], prefix: [] },
      secrets: { exact: [], prefix: [] },
      permissions: { exact: [], prefix: [] },
    };
    const result = collect({ baseFile: null, headFile: blob(JSON.stringify(empty)) });
    assert.ok(result.protectedPaths.some((entry) => entry.path === "src/secrets-rotate.ts"));
    assert.ok(
      result.protectedPaths.some((entry) => entry.path === ".github/kit-protected-paths.json"),
    );
  });
  it("keeps default branch protection when the target branch has weaker rules", () => {
    const empty = {
      release: { exact: [], prefix: [] },
      github: { exact: [], prefix: [] },
      secrets: { exact: [], prefix: [] },
      permissions: { exact: [], prefix: [] },
    };
    const result = collect({
      baseFile: blob(JSON.stringify(empty)),
      headFile: blob(JSON.stringify(empty)),
      defaultFile: blob(JSON.stringify(base)),
    });
    assert.ok(result.protectedPaths.some((entry) => entry.path === "src/secrets-rotate.ts"));
  });
  it("rejects incomplete file lists and missing rename origins", () => {
    assert.throws(() => collect({ files: [[]] }), /incomplete/i);
    assert.throws(
      () =>
        collect({
          files: [
            [
              { filename: paths[0], status: "renamed" },
              { filename: paths[1], status: "added" },
              { filename: paths[2], status: "modified" },
            ],
          ],
        }),
      /rename/i,
    );
  });
  it("rejects a base change while gathering evidence", () => {
    assert.throws(() => collect({ changeAt: 2 }), /base or head changed/i);
    assert.throws(() => collect({ defaultChangeAt: 2 }), /base or head changed/i);
  });
  it("rejects a changed PR head while gathering evidence", () => {
    assert.throws(() => collect({ headChangeAt: 2 }), /base or head changed/i);
  });
});
