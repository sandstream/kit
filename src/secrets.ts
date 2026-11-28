import { readFile, writeFile, access } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, resolve } from "node:path";
import type { InfisicalConfig, SecretKeyConfig, SecretsConfig } from "./config.js";
import { resolveViaBackend, resetInfisicalCache } from "./secret-backends.js";
import { recordSecretRead, type SecretReader } from "./secrets-read-record.js";
import { secureFile } from "./utils/secure-perms.js";

export interface SecretResolveResult {
  name: string;
  resolved: boolean;
  value: string | null;
  detail: string;
  /** True when the backend manages the value out-of-band (e.g. EAS) — `value`
   *  is a display placeholder, not a real secret, so it's never written to
   *  .env.local. Lets the writer skip these without sniffing the value string. */
  managed?: boolean;
}

export interface WriteOpts {
  vault?: string;
  project?: string;
  region?: string;
  vaultPath?: string;
}

export interface WriteResult {
  ok: boolean;
  ref?: string;
  detail: string;
}

export interface SecretBackend {
  /** Read a secret value for `name` using its `config`. Never throws — failures
   *  come back as `{ resolved: false, detail }`. */
  resolve(
    name: string,
    config: SecretKeyConfig,
    infisicalConfig?: InfisicalConfig,
    cwd?: string,
  ): Promise<SecretResolveResult>;
  /** Write a secret. Absent ⇒ the backend is read-only (migration unsupported).
   *  May throw; callers wrap it so the error is redacted before surfacing.
   *
   *  Value handling: where the CLI supports it, the value is fed via stdin so it
   *  never lands in argv / the process table (vault `kv put -`, aws/gcp
   *  `file:///dev/stdin` / `--data-file=-`). The 1Password, Infisical, Doppler and
   *  Azure CLIs only accept the value as a `key=value` / `--value` argv token for
   *  these operations, so it is briefly visible in `ps` there — an inherent CLI
   *  limitation. The error path is covered regardless: writeSecretToBackend redacts
   *  the held plaintext by exact substring before any failure message is surfaced. */
  write?(key: string, value: string, opts: WriteOpts): Promise<WriteResult>;
}

/** Interpolate {{KEY}} placeholders in a template string with resolved values. */
function interpolateTemplate(template: string, resolved: Map<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return resolved.get(key) ?? `{{${key}}}`;
  });
}

async function loadTemplate(templatePath: string): Promise<string | null> {
  try {
    await access(templatePath);
    return await readFile(templatePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Record the read of every declared key (`src/secrets-read-record.ts`) in `read.cwd`'s chain, or
 * else the output file's directory, then reset the Infisical bulk-fetch cache for this call. Throws,
 * before anything is resolved, when the read cannot be recorded.
 */
async function beginRead(
  keys: Record<string, SecretKeyConfig>,
  outputPath: string,
  read: Partial<SecretReader> = {},
): Promise<void> {
  const cwd = read.cwd ?? (outputPath === devNull ? process.cwd() : dirname(resolve(outputPath)));
  const storeOf = (name: string) => keys[name]!.source;
  await recordSecretRead(
    { keys: Object.keys(keys), storeOf, via: read.via ?? "kit secrets" },
    { ...read, cwd },
  );
  resetInfisicalCache();
}

/** Resolve every declared key through its backend, after `beginRead` recorded the read. */
async function resolveKeys(
  secrets: SecretsConfig & { keys: Record<string, SecretKeyConfig> },
): Promise<{ results: SecretResolveResult[]; resolved: Map<string, string> }> {
  const results: SecretResolveResult[] = [];
  for (const [name, config] of Object.entries(secrets.keys)) {
    results.push(await resolveViaBackend(name, config, secrets.infisical));
  }
  const resolved = new Map<string, string>();
  for (const r of results) {
    // Skip backend-managed values (e.g. EAS) — their `value` is a display
    // placeholder, not a real secret to write into .env.local or a child's env.
    if (r.resolved && r.value !== null && !r.managed) {
      resolved.set(r.name, r.value);
    }
  }
  return { results, resolved };
}

/**
 * Resolve the declared keys into memory and write nothing: the path `kit run --inject` uses to hand
 * them to one child. The read is recorded in `read.cwd`'s chain first, as for `generateSecrets`, and
 * an unrecordable read throws before any value is fetched.
 */
export async function resolveSecretsInMemory(
  secrets: SecretsConfig,
  read: Partial<SecretReader> & { cwd: string },
): Promise<{ results: SecretResolveResult[]; resolved: Map<string, string> }> {
  if (!secrets.keys) return { results: [], resolved: new Map() };
  await beginRead(secrets.keys, devNull, read);
  return resolveKeys({ ...secrets, keys: secrets.keys });
}

export async function generateSecrets(
  secrets: SecretsConfig,
  outputPath: string = ".env.local",
  read?: Partial<SecretReader>,
): Promise<{
  results: SecretResolveResult[];
  written: boolean;
  fromTemplate: boolean;
  skipped?: "nothing-resolved";
}> {
  if (!secrets.keys) {
    return { results: [], written: false, fromTemplate: false };
  }

  // Record the read (or throw), then reset the Infisical bulk-fetch cache for this call.
  await beginRead(secrets.keys, outputPath, read);
  const { results, resolved } = await resolveKeys({ ...secrets, keys: secrets.keys });

  let content: string;
  let fromTemplate = false;

  // If a template is configured, read it and interpolate
  const template = secrets.template ? await loadTemplate(secrets.template) : null;

  if (template !== null) {
    fromTemplate = true;
    const header = [
      "# Generated by kit secrets from template — do not edit manually",
      `# Template: ${secrets.template}`,
      `# Generated at ${new Date().toISOString()}`,
      "",
    ].join("\n");
    content = header + interpolateTemplate(template, resolved) + "\n";
  } else {
    // Fallback: generate from keys
    const lines: string[] = [
      "# Generated by kit secrets — do not edit manually",
      `# Generated at ${new Date().toISOString()}`,
      "",
    ];

    for (const result of results) {
      if (resolved.has(result.name)) {
        lines.push(`${result.name}=${resolved.get(result.name)}`);
      } else {
        lines.push(`# ${result.name}= # ${result.detail}`);
      }
    }

    lines.push("");
    content = lines.join("\n");
  }

  // Never clobber an existing .env.local when we resolved nothing. The source
  // (vault) being empty/unauthed is not a reason to replace a working file
  // with an empty scaffold — that destroys local-dev credentials. Leave it
  // untouched and report the skip so the caller can say so.
  if (resolved.size === 0) {
    const fileExists = await access(outputPath).then(
      () => true,
      () => false,
    );
    if (fileExists) {
      return { results, written: false, fromTemplate, skipped: "nothing-resolved" };
    }
  }

  // Create owner-only from the start (mode applies only on creation), then
  // enforce 0o600 / icacls on the existing file too (handles pre-existing files
  // and the umask race) — plaintext secrets must never be world-readable.
  // Skip the platform null device (secrets-sync discards output there): chmod on
  // the root-owned /dev/null throws EPERM and there's nothing to secure anyway.
  await writeFile(outputPath, content, { encoding: "utf-8", mode: 0o600 });
  if (outputPath !== devNull) secureFile(outputPath);
  return { results, written: true, fromTemplate };
}
