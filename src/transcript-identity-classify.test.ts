import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyToolCall, firstUrlHost } from "./transcript-identity-classify.js";

const input = (o: unknown): string => JSON.stringify(o);

describe("classifyToolCall", () => {
  it("calls a curl with a User-Agent header network-shaped, with its host", () => {
    const cmd = 'curl -H "User-Agent: probe (alice@example.com)" https://api.example.net/v1';
    assert.deepEqual(classifyToolCall("Bash", input({ command: cmd })), {
      network: true,
      host: "api.example.net",
    });
  });

  it("calls a git commit that names the address local", () => {
    const cmd = 'git -c user.email=alice@example.com commit -m "fix"';
    assert.deepEqual(classifyToolCall("Bash", input({ command: cmd })), {
      network: false,
      host: null,
    });
  });

  it("calls a Python requests script network-shaped even without a literal URL", () => {
    const code = "import requests\nrequests.get(base, headers={'From': 'alice@example.com'})";
    const r = classifyToolCall("Write", input({ file_path: "x.py", content: code }));
    assert.deepEqual(r, { network: true, host: "unknown" });
  });

  it("calls a From: header on its own line network-shaped", () => {
    const r = classifyToolCall("Bash", input({ command: "printf 'From: alice@example.com\\n'" }));
    assert.equal(r.network, true);
  });

  it("calls WebFetch network-shaped with the URL's host", () => {
    const r = classifyToolCall("WebFetch", input({ url: "https://docs.example.org/a?u=alice" }));
    assert.deepEqual(r, { network: true, host: "docs.example.org" });
  });

  it("calls WebSearch and mcp__ tools network-shaped", () => {
    assert.deepEqual(classifyToolCall("WebSearch", input({ query: "alice" })), {
      network: true,
      host: "web-search",
    });
    assert.deepEqual(classifyToolCall("mcp__tracker__create_issue", input({ body: "alice" })), {
      network: true,
      host: "mcp:tracker",
    });
  });

  it("calls a file edit with no network text local", () => {
    const r = classifyToolCall("Edit", input({ old_string: "a", new_string: "alice@example.com" }));
    assert.equal(r.network, false);
  });
});

describe("firstUrlHost", () => {
  it("drops userinfo and lower-cases the host", () => {
    assert.equal(firstUrlHost("see https://alice:pw@API.Example.com/x"), "api.example.com");
  });

  it("returns null when the text holds no URL", () => {
    assert.equal(firstUrlHost("no link here"), null);
  });
});
