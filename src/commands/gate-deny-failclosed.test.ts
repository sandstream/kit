/**
 * kit-research#233 E3: the fault deny in runGateFailClosed loaded `node:fs` with a dynamic import
 * before denying. When module loading is the fault, that import throws too and the process exits
 * 1, which every PreToolUse harness treats as allow. These tests break module loading for real
 * (a resolve hook that refuses every specifier once armed) and break the deny writers themselves.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { denyGateFault, type GateDenyIo } from "./gate.js";

const GATE_JS = fileURLToPath(new URL("./gate.js", import.meta.url));
const CLI_JS = fileURLToPath(new URL("../cli.js", import.meta.url));
const NO_HOOKS =
  typeof (nodeModule as { registerHooks?: unknown }).registerHooks === "function"
    ? false
    : "module.registerHooks needs Node 22.15+";

// Armed by KIT_TEST_FAIL_RESOLVE: "*" refuses every specifier; any other value refuses exactly
// that specifier when cli.js imports it. The error is the one the V8-snapshot build produced.
const HOOK = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  const arm = process.env.KIT_TEST_FAIL_RESOLVE;
  if (arm && (arm === "*" || (specifier === arm && String(context.parentURL).endsWith("/cli.js")))) {
    const e = new Error("simulated module-load fault: " + specifier);
    e.code = "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING";
    throw e;
  }
  return next(specifier, context);
} });
`;

const RUNNER = `const { runGateFailClosed } = await import(process.argv[2]);
process.env.KIT_TEST_FAIL_RESOLVE = "*";
await runGateFailClosed("gate-bash", () => { throw new Error("internal fault"); });
`;

function withHook(args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kit-gate-deny-"));
  try {
    writeFileSync(join(dir, "hook.mjs"), HOOK);
    writeFileSync(join(dir, "runner.mjs"), RUNNER);
    const hook = pathToFileURL(join(dir, "hook.mjs")).href;
    const argv = args.map((a) => (a === "<runner>" ? join(dir, "runner.mjs") : a));
    return spawnSync(process.execPath, ["--import", hook, ...argv], {
      cwd: dir,
      encoding: "utf8",
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }),
      env: { ...process.env, KIT_NON_INTERACTIVE: "1", KIT_NO_UPDATE_CHECK: "1", ...env },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("gate fault deny when module loading is the fault", { skip: NO_HOOKS }, () => {
  it("denies with exit 2 when every import fails after the gate module loaded", () => {
    const r = withHook(["<runner>", pathToFileURL(GATE_JS).href]);
    assert.equal(r.status, 2, `stderr: ${r.stderr}`); // exit 1 would let the tool call run
    assert.match(r.stderr, /kit gate-bash: BLOCKED — gate error \(fail-closed\)/);
  });

  it("denies with exit 2 when an import before the gate handler fails in the CLI", () => {
    const r = withHook([CLI_JS, "gate-bash"], { KIT_TEST_FAIL_RESOLVE: "./read-only-mode.js" });
    assert.equal(r.status, 2, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /kit gate-bash: BLOCKED — gate error \(fail-closed\)/);
  });
});

/** An io whose writers record or throw, and whose exit records the code then stops the caller. */
function fakeIo(over: Partial<GateDenyIo> = {}) {
  const seen: { stderr: string[]; exit?: number } = { stderr: [] };
  const io: GateDenyIo = {
    stdoutDeny: () => false,
    writeStderr: (text) => void seen.stderr.push(text),
    exit: (code) => {
      seen.exit = code;
      throw new Error("__exit__");
    },
    ...over,
  };
  return { io, seen };
}

describe("denyGateFault when the deny writer itself fails", () => {
  const boom = () => {
    throw new Error("writer down");
  };

  it("still exits 2 when the stderr writer throws", (t) => {
    const { io, seen } = fakeIo({ writeStderr: boom });
    t.mock.method(process.stderr, "write", () => true);
    assert.throws(() => denyGateFault("gate-bash", new Error("x"), io), /__exit__/);
    assert.equal(seen.exit, 2);
  });

  it("still exits 2 when the stdout-JSON deny throws", (t) => {
    const { io, seen } = fakeIo({ stdoutDeny: boom });
    t.mock.method(process.stderr, "write", () => true);
    assert.throws(() => denyGateFault("gate-env", new Error("x"), io), /__exit__/);
    assert.equal(seen.exit, 2);
  });

  it("still exits 2 when even the fallback process.stderr write throws", (t) => {
    const { io, seen } = fakeIo({ writeStderr: boom });
    t.mock.method(process.stderr, "write", boom);
    assert.throws(() => denyGateFault("gate-egress", new Error("x"), io), /__exit__/);
    assert.equal(seen.exit, 2);
  });

  it("denies with a fixed reason when reading the fault's message throws", (t) => {
    const { io, seen } = fakeIo();
    const hostile = {
      toString() {
        throw new Error("no message");
      },
    };
    assert.throws(() => denyGateFault("gate-fs", hostile, io), /__exit__/);
    assert.equal(seen.exit, 2);
    assert.match(seen.stderr.join(""), /BLOCKED — gate error \(fail-closed\): unprintable error/);
  });

  it("returns false without exiting after a stdout-JSON deny (Cline, Antigravity)", (t) => {
    const { io, seen } = fakeIo({ stdoutDeny: () => true });
    assert.equal(denyGateFault("gate-bash", new Error("x"), io), false);
    assert.equal(seen.exit, undefined);
  });
});
