/**
 * `kit secrets propagate --to supabase`: Edge Function secrets through `supabase secrets set
 * --env-file`. The Supabase CLI has no stdin path, so the value goes in an env file of mode 0600
 * inside a folder of mode 0700 that is removed afterwards, and never into argv.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PropagationOptions, PropagationResult } from "./secrets-propagate.js";
import { safeDiagnostic, spawnWithStdin } from "./secrets-propagate-exec.js";

const SUPABASE_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SUPABASE_PROJECT_REF = /^[a-z0-9]{10,40}$/;

/** An Edge Function secret name: an upper-case env name that does not start with the reserved SUPABASE_. */
export function isValidSupabaseSecretName(name: string): boolean {
  return SUPABASE_NAME.test(name) && !name.startsWith("SUPABASE_");
}

/**
 * One value as an env-file entry that the Supabase CLI reads back exactly. Measured against a real
 * project, the CLI reads single quotes literally and reads double quotes with only `\n` and `\r`
 * expanded: a quote, a dollar and a backslash cannot be escaped inside double quotes (they are
 * stored with the backslash kept). So the quoting follows the value:
 *   - no single quote, newline or return: single quotes, everything literal;
 *   - otherwise double quotes with `\n` and `\r`, which is exact only without `"`, `$` and `\`;
 *   - otherwise the value has no exact form and is refused, never stored changed.
 */
export function quoteEnvValue(value: string): string {
  if (value.includes("\u0000")) {
    throw new Error("the value contains a NUL byte, which an env file cannot carry");
  }
  const needsDouble = ["'", "\r", "\n"].some((ch) => value.includes(ch));
  if (!needsDouble) return `'${value}'`;
  if (['"', "$", "\\"].some((ch) => value.includes(ch))) {
    throw new Error(
      "the value has a single quote or a line break together with a double quote, a dollar or a backslash, and the Supabase CLI cannot read that back exactly; set it in the Supabase dashboard",
    );
  }
  return `"${value.split("\n").join("\\n").split("\r").join("\\r")}"`;
}

/** An env file with one entry, in a folder only this user can open. `remove` deletes both. */
export function writePrivateEnvFile(
  name: string,
  value: string,
): { path: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "kit-supabase-"));
  const path = join(dir, "secrets.env");
  try {
    writeFileSync(path, `${name}=${quoteEnvValue(value)}\n`, { mode: 0o600 });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A multi-line value is redacted line by line too, since a CLI may echo only one line of it. */
function valueFragments(value: string): string[] {
  return [value, ...value.split(/\r?\n/).filter((line) => line.length >= 4)];
}

export async function propagateSupabase(
  name: string,
  value: string,
  opts: PropagationOptions,
): Promise<PropagationResult> {
  const refuse = (detail: string): PropagationResult => ({
    target: "supabase",
    ok: false,
    detail,
    valueInArgv: false,
  });
  if (!isValidSupabaseSecretName(name)) {
    return refuse(
      "supabase: the name must be upper case letters, digits and underscores, and cannot start with SUPABASE_ (reserved)",
    );
  }
  if (opts.supabaseProject !== undefined && !SUPABASE_PROJECT_REF.test(opts.supabaseProject)) {
    return refuse(
      "supabase: --supabase-project must be a project ref (lower case letters and digits)",
    );
  }
  let file: { path: string; remove: () => void };
  try {
    file = writePrivateEnvFile(name, value);
  } catch (err) {
    return refuse(`supabase: ${safeDiagnostic(err, [value])}`);
  }
  try {
    const args = ["secrets", "set", "--env-file", file.path];
    if (opts.supabaseProject) args.push("--project-ref", opts.supabaseProject);
    const { code, stderr } = await spawnWithStdin("supabase", args, "", valueFragments(value));
    return {
      target: "supabase",
      ok: code === 0,
      detail:
        code === 0
          ? `pushed to supabase edge function secrets${opts.supabaseProject ? ` project=${opts.supabaseProject}` : " (linked project)"}`
          : `supabase exit ${code}: ${stderr.split("\n")[0]}`,
      valueInArgv: false,
    };
  } finally {
    file.remove();
  }
}
