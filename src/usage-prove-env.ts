/**
 * Negative controls for the env-write gate, for `kit usage prove`: a plaintext credential written to
 * a `.env` file is refused, and a write of ordinary text is let through. Kept apart from
 * usage-prove.ts so that file's long nested control stays as it was.
 */
import type { Control } from "./usage-prove.js";

/** Runs the kit CLI with these arguments and this stdin, and returns the exit code. */
export type RunKit = (args: string[], opts?: { input?: string }) => { code: number };

/**
 * Controls for the env-write gate: a plaintext credential written to a `.env` file is refused, and
 * a write of ordinary text is let through. The same pairing as the install gate, for the same
 * reason: a gate that refuses every write is an outage, not a gate.
 *
 * The credential is a Stripe TEST key shape (recognised by the scanner, worthless if it leaked),
 * built from parts so this file does not itself hold a credential-shaped string.
 */
export function controlEnvWriteGate(run: RunKit): Control[] {
  const fakeKey = `sk_test_${"A".repeat(20)}`;
  const write = (file: string, content: string) =>
    JSON.stringify({ tool_name: "Write", tool_input: { file_path: file, content } });
  const refused = run(["gate-env"], { input: write(".env", `STRIPE_SECRET_KEY=${fakeKey}\n`) });
  const allowed = run(["gate-env"], { input: write("notes.md", "nothing secret here\n") });
  const blocked = refused.code === 2;
  return [
    {
      name: "env-write gate refuses a plaintext credential in .env",
      expected: "exit 2: the write is blocked before it lands",
      observed: blocked ? `exit ${refused.code}, blocked` : `exit ${refused.code}, NOT blocked`,
      verdict: blocked ? "refused" : "allowed",
      ok: blocked,
    },
    {
      name: "env-write gate allows a write with no credential",
      expected: "exit 0",
      observed: `exit ${allowed.code}`,
      verdict: allowed.code === 0 ? "allowed" : "refused",
      ok: allowed.code === 0,
    },
  ];
}
