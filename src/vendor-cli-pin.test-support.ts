/**
 * Shared fixture for the vendor-CLI pin tests: a temp project, a bin dir holding a fake `op`, and
 * `PinDeps` pointed at them. The fake is a POSIX shell stub that logs its argv and prints the
 * version written into its own bytes, so a new version also changes the hash and a new `note`
 * changes the hash alone. It needs `/bin/sh`: suites using it skip on win32 (`POSIX_ONLY`).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetHashCacheForTests, readCliVersion, type PinDeps } from "./vendor-cli-pin.js";
import type { PinIo } from "./commands/tools-pin.js";

export const POSIX_ONLY = process.platform === "win32" ? "fake CLIs are /bin/sh scripts" : false;

export function opStub(version: string, note = ""): string {
  return `#!/bin/sh
# fake op ${note}
printf '%s\\n' "$*" >> "$OP_LOG"
case "$1" in
  --version) printf '%s\\n' "${version}" ;;
  read) printf 'value' ;;
esac
`;
}

export interface Fixture {
  root: string;
  proj: string;
  bin: string;
  deps: PinDeps;
  io: PinIo;
  audits: Array<Record<string, unknown>>;
  writeOp: (dir: string, body: string) => void;
  logged: () => string;
  clearLog: () => void;
  done: () => void;
}

export function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "kit-vcp-"));
  const proj = join(root, "proj");
  const bin = join(root, "bin");
  const log = join(root, "op.log");
  mkdirSync(proj);
  const writeOp = (dir: string, body: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "op"), body);
    chmodSync(join(dir, "op"), 0o755);
  };
  writeOp(bin, opStub("2.30.0"));
  const saved = { path: process.env.PATH, log: process.env.OP_LOG };
  process.env.OP_LOG = log;
  const audits: Array<Record<string, unknown>> = [];
  _resetHashCacheForTests();
  return {
    root,
    proj,
    bin,
    audits,
    writeOp,
    deps: {
      cwd: proj,
      env: { PATH: bin },
      platform: process.platform,
      arch: process.arch,
      home: join(root, "home"),
      miseWhich: async () => null,
    },
    io: { audit: async (e) => (audits.push(e), true), versionOf: readCliVersion },
    logged: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
    clearLog: () => writeFileSync(log, ""),
    done: () => {
      process.env.PATH = saved.path;
      if (saved.log === undefined) delete process.env.OP_LOG;
      else process.env.OP_LOG = saved.log;
      process.exitCode = 0;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Run `fn` with stderr captured; returns what was written. */
export async function captureStderr(fn: () => Promise<unknown>): Promise<string> {
  const errs: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => (
    errs.push(String(s)),
    true
  )) as typeof process.stderr.write;
  try {
    await fn();
  } catch {
    // the caller asserts on the refusal separately
  } finally {
    process.stderr.write = write;
  }
  return errs.join("");
}
