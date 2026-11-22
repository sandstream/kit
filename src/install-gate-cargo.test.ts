import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cargoInstall } from "./install-gate-cargo.js";
import type { GemProbe } from "./install-gate-gem.js";
import { decideBashGate, parseInstallCommand } from "./install-gate.js";
import { gateInstall, triageTargetFor, type GateDeps } from "./triage-gate.js";
import type { TriageType } from "./triage.js";

const probe = (): GemProbe => ({ isInstall: false, refs: [], unverifiable: [] });

/** Triage stub: records each call and passes every crate except `fast-anything`. */
function stubDeps(calls: string[]): GateDeps {
  return {
    runTriage: async (type: TriageType, target: string) => {
      calls.push(`${type} ${target}`);
      const passed = !target.startsWith("fast-anything");
      const output = passed
        ? "TRIAGE PASSED"
        : "  x CRITICAL: cooling: 0.1.0 was published 1 days ago";
      return { type, target, passed, output };
    },
  };
}

describe("install gate: cargo install and cargo binstall", () => {
  const refs: Array<[string, string[]]> = [
    ["cargo install ripgrep", ["crate:ripgrep"]],
    ["cargo install fast-anything", ["crate:fast-anything"]],
    ["cargo install ripgrep@14.1.0", ["crate:ripgrep@14.1.0"]],
    ["cargo install ripgrep --version 14.1.0", ["crate:ripgrep@14.1.0"]],
    ["cargo install --version=14.1.0 ripgrep", ["crate:ripgrep@14.1.0"]],
    ["cargo install --vers =14.1.0 ripgrep", ["crate:ripgrep@14.1.0"]],
    ["cargo install --locked --force ripgrep fd-find", ["crate:ripgrep", "crate:fd-find"]],
    ["cargo install ripgrep --features pcre2 --root /opt/tools -j 4", ["crate:ripgrep"]],
    ["cargo +nightly install cargo-expand", ["crate:cargo-expand"]],
    ["cargo --locked install ripgrep", ["crate:ripgrep"]],
    ["cargo --color never install ripgrep", ["crate:ripgrep"]],
    ["cargo binstall cargo-nextest", ["crate:cargo-nextest"]],
    ["cargo binstall -y cargo-nextest@0.9.70", ["crate:cargo-nextest@0.9.70"]],
    ["cargo-binstall --no-confirm just", ["crate:just"]],
    ["sudo cargo install ripgrep", ["crate:ripgrep"]],
    ["/home/me/.cargo/bin/cargo install ripgrep", ["crate:ripgrep"]],
    ["cargo.exe install ripgrep", ["crate:ripgrep"]],
    ['sh -c "cargo install ripgrep"', ["crate:ripgrep"]],
    ["cargo build && cargo install ripgrep", ["crate:ripgrep"]],
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

describe("install gate: cargo installs that are refused", () => {
  const refused: Array<[string, RegExp]> = [
    [
      "cargo install --git https://github.com/acme/tool",
      /UNVERIFIED SOURCE: --git\..*kit triage repo/,
    ],
    ["cargo install --git https://github.com/acme/tool --tag v1 tool", /UNVERIFIED SOURCE: --git/],
    ["cargo install --git=https://github.com/acme/tool", /UNVERIFIED SOURCE: --git/],
    [
      "cargo install --registry internal ripgrep",
      /UNVERIFIED SOURCE: --registry\..*kit triage repo/,
    ],
    ["cargo install --index https://index.example ripgrep", /UNVERIFIED SOURCE: --index/],
    ["cargo --config net.offline=true install ripgrep", /UNVERIFIED SOURCE: --config/],
    ["cargo binstall --pkg-url https://dl.example/x.tgz tool", /UNVERIFIED SOURCE: --pkg-url/],
    ["cargo binstall --manifest-path ./Cargo.toml tool", /UNVERIFIED SOURCE: --manifest-path/],
    [
      "CARGO_REGISTRIES_CRATES_IO_INDEX=https://x.example cargo install ripgrep",
      /UNVERIFIED SOURCE: CARGO_REGISTRIES_CRATES_IO_INDEX/,
    ],
    ["cargo install ripgrep --version ^14", /cannot reduce to a triage target: cargo-version:\^14/],
    ["cargo install ripgrep@14", /cannot reduce to a triage target: crate:ripgrep@14/],
    ["cargo install 'bad name'", /cannot reduce to a triage target: crate:bad name/],
    ["cargo install https://example.com/tool.crate", /cannot reduce to a triage target/],
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

describe("install gate: cargo commands that fetch nothing from the registry", () => {
  const local = [
    "cargo install --path .",
    "cargo install --path ./crates/cli --locked",
    "cargo install --path=. --force",
    "cargo install",
    "cargo install --list",
    "cargo build --release",
    "cargo test",
    "cargo --version",
    "cargo run -- install ripgrep",
    "CARGO_SOURCE_X=1 cargo install --path .",
  ];
  for (const command of local) {
    it(`is not a registry install: ${command}`, () => {
      const parsed = parseInstallCommand(command);
      assert.equal(parsed.isInstall, false);
      assert.deepEqual(parsed.refs, []);
      assert.deepEqual(parsed.unverifiable, []);
    });
  }
});

describe("install gate: cargo triage decides, as for npm", () => {
  it("blocks the crate npm's twin was refused for, with the triage reason", async () => {
    const calls: string[] = [];
    const verdict = await decideBashGate("cargo install fast-anything", stubDeps(calls));
    assert.equal(verdict.block, true);
    assert.deepEqual(calls, ["cargo fast-anything"]);
    assert.match(verdict.reason, /triage did not pass \(cargo fast-anything\): CRITICAL: cooling/);
  });

  it("allows a crate whose triage passes, and triages every crate named", async () => {
    const calls: string[] = [];
    const verdict = await decideBashGate("cargo install ripgrep fd-find@10.2.0", stubDeps(calls));
    assert.equal(verdict.block, false);
    assert.deepEqual(calls, ["cargo ripgrep", "cargo fd-find@10.2.0"]);
  });

  it("maps a crate: ref to cargo triage, and leaves mise's cargo: refs as they were", async () => {
    assert.deepEqual(triageTargetFor("crate:ripgrep@14.1.0"), {
      kind: "triage",
      type: "cargo",
      target: "ripgrep@14.1.0",
    });
    assert.equal(triageTargetFor("cargo:").kind, "untriageable");
    assert.equal((await gateInstall("crate:ripgrep", stubDeps([]))).decision, "pass");
  });

  it("leaves a probe untouched for other commands", () => {
    const p = probe();
    assert.equal(cargoInstall(["npm", "install", "x"], p), false);
    assert.equal(cargoInstall(["cargo", "build"], p), false);
    assert.deepEqual(p, probe());
  });
});
