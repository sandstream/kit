import { describe, it } from "node:test";
import assert from "node:assert";
import { unpinnedRequirements } from "./pinned-requirements.js";

describe("unpinnedRequirements", () => {
  it("flags every form that does not name one exact version", () => {
    const body = [
      "fastapi",
      "uvicorn<1",
      "httpx>=0.27",
      "rich==13.*",
      "gitingest @ https://example.com/gitingest.tar.gz",
    ].join("\n");
    assert.deepStrictEqual(unpinnedRequirements(body), [
      "fastapi",
      "uvicorn",
      "httpx",
      "rich",
      "gitingest",
    ]);
  });

  it("accepts exact pins with extras, markers, comments and hash continuations", () => {
    const body = [
      "# a comment",
      "",
      "fastapi==0.115.0  # pinned",
      "uvicorn[standard]===0.30.6",
      'tomli==2.0.1 ; python_version < "3.11"',
      "httpx==0.27.2 \\",
      "    --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000",
      "-r other.txt",
    ].join("\n");
    assert.deepStrictEqual(unpinnedRequirements(body), []);
  });
});
