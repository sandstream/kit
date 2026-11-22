import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { goInstall } from "./install-gate-go.js";
import type { GemProbe } from "./install-gate-gem.js";
import { decideBashGate, parseInstallCommand } from "./install-gate.js";
import { triageTargetFor, type GateDeps } from "./triage-gate.js";
import type { TriageType } from "./triage.js";

const probe = (): GemProbe => ({ isInstall: false, refs: [], unverifiable: [] });

/** Triage stub: records each call and passes every module except those under `example.com/young`. */
function stubDeps(calls: string[]): GateDeps {
  return {
    runTriage: async (type: TriageType, target: string) => {
      calls.push(`${type} ${target}`);
      const passed = !target.startsWith("example.com/young");
      const output = passed
        ? "TRIAGE PASSED"
        : "  x CRITICAL: cooling: v0.1.0 was published 1 days ago";
      return { type, target, passed, output };
    },
  };
}

describe("install gate: go install and go run of a versioned package", () => {
  const refs: Array<[string, string[]]> = [
    ["go install golang.org/x/tools/gopls@latest", ["gomod:golang.org/x/tools/gopls@latest"]],
    [
      "go install github.com/BurntSushi/toml/cmd/tomlv@v1.4.0",
      ["gomod:github.com/BurntSushi/toml/cmd/tomlv@v1.4.0"],
    ],
    ["go install -v -ldflags '-s -w' example.com/tool@v1.2.3", ["gomod:example.com/tool@v1.2.3"]],
    ["go install -tags=netgo example.com/tool@latest", ["gomod:example.com/tool@latest"]],
    ["go install --tags netgo example.com/tool@latest", ["gomod:example.com/tool@latest"]],
    [
      "go install example.com/a@v1.0.0 example.com/b@v2.0.0",
      ["gomod:example.com/a@v1.0.0", "gomod:example.com/b@v2.0.0"],
    ],
    ["go install example.com/tool@main", ["gomod:example.com/tool@main"]],
    ["go -C /tmp install example.com/tool@latest", ["gomod:example.com/tool@latest"]],
    ["go run example.com/tool@latest --flag other@thing", ["gomod:example.com/tool@latest"]],
    ["go run -race example.com/tool@v1.0.0", ["gomod:example.com/tool@v1.0.0"]],
    ["GOBIN=/opt/bin go install example.com/tool@latest", ["gomod:example.com/tool@latest"]],
    [
      "GOOS=linux GOARCH=arm64 go install example.com/tool@latest",
      ["gomod:example.com/tool@latest"],
    ],
    ["/usr/local/go/bin/go install example.com/tool@latest", ["gomod:example.com/tool@latest"]],
    ['bash -c "go install example.com/tool@latest"', ["gomod:example.com/tool@latest"]],
  ];
  for (const [command, expected] of refs) {
    it(`gates ${command}`, () => {
      const parsed = parseInstallCommand(command);
      assert.equal(parsed.isInstall, true);
      assert.deepEqual(parsed.refs, expected);
      assert.deepEqual(parsed.unverifiable, []);
    });
  }
});

describe("install gate: go installs that are refused", () => {
  const refused: Array<[string, RegExp]> = [
    [
      "GOPROXY=https://proxy.example go install example.com/tool@latest",
      /UNVERIFIED SOURCE: GOPROXY\..*kit triage repo/,
    ],
    ["GOPROXY=direct go install example.com/tool@latest", /UNVERIFIED SOURCE: GOPROXY/],
    ["env GOFLAGS=-insecure go install example.com/tool@latest", /UNVERIFIED SOURCE: GOFLAGS/],
    ["GOPRIVATE=example.com go install example.com/tool@latest", /UNVERIFIED SOURCE: GOPRIVATE/],
    [
      "GONOSUMDB=example.com GOSUMDB=off go install example.com/tool@latest",
      /UNVERIFIED SOURCE: GONOSUMDB, GOSUMDB/,
    ],
    ["go install tool@latest", /cannot reduce to a triage target: gomod:tool@latest/],
    ["go install ./cmd/x@latest", /cannot reduce to a triage target: gomod:\.\/cmd\/x@latest/],
    ["go install example.com/tool@", /cannot reduce to a triage target: gomod:example\.com\/tool@/],
    ["go install 'example.com/tool@v1 x'", /cannot reduce to a triage target/],
  ];
  for (const [command, reason] of refused) {
    it(`refuses ${command}`, async () => {
      const calls: string[] = [];
      const verdict = await decideBashGate(command, stubDeps(calls));
      assert.equal(verdict.block, true);
      assert.match(verdict.reason, reason);
      assert.match(verdict.reason, /fail-closed/);
      assert.deepEqual(calls, [], "a refused command is not triaged");
    });
  }
});

describe("install gate: go commands that fetch nothing", () => {
  const local = [
    "go install .",
    "go install ./cmd/x",
    "go install ./...",
    "go install example.com/me/project/cmd/tool",
    "go install -v ./cmd/a ./cmd/b",
    "go run .",
    "go run ./cmd/x arg@value",
    "go run main.go",
    "go build ./...",
    "go test ./...",
    "go version",
    "go mod download",
    "GOPROXY=off go install ./cmd/x",
  ];
  for (const command of local) {
    it(`is not a registry fetch: ${command}`, () => {
      const parsed = parseInstallCommand(command);
      assert.equal(parsed.isInstall, false);
      assert.deepEqual(parsed.refs, []);
      assert.deepEqual(parsed.unverifiable, []);
    });
  }
});

describe("install gate: go triage decides, as for npm", () => {
  it("blocks a module whose triage does not pass, with the triage reason", async () => {
    const calls: string[] = [];
    const verdict = await decideBashGate(
      "go install example.com/young/tool@latest",
      stubDeps(calls),
    );
    assert.equal(verdict.block, true);
    assert.deepEqual(calls, ["go example.com/young/tool@latest"]);
    assert.match(
      verdict.reason,
      /triage did not pass \(go example\.com\/young\/tool@latest\): CRITICAL: cooling/,
    );
  });

  it("allows a module whose triage passes", async () => {
    const calls: string[] = [];
    const verdict = await decideBashGate(
      "go install golang.org/x/tools/gopls@latest",
      stubDeps(calls),
    );
    assert.equal(verdict.block, false);
    assert.deepEqual(calls, ["go golang.org/x/tools/gopls@latest"]);
  });

  it("maps a gomod: ref to go triage, and leaves mise's go: refs on repo triage", () => {
    assert.deepEqual(triageTargetFor("gomod:golang.org/x/tools/gopls@latest"), {
      kind: "triage",
      type: "go",
      target: "golang.org/x/tools/gopls@latest",
    });
    assert.equal(
      triageTargetFor("go:github.com/google/osv-scanner/cmd/osv-scanner").kind,
      "triage",
    );
    const mise = triageTargetFor("go:github.com/google/osv-scanner/cmd/osv-scanner");
    assert.equal(mise.kind === "triage" && mise.type, "repo");
  });

  it("leaves a probe untouched for other commands", () => {
    const p = probe();
    assert.equal(goInstall(["npm", "install", "x"], p), false);
    assert.equal(goInstall(["go", "build", "./..."], p), false);
    assert.deepEqual(p, probe());
  });
});
