import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SecretsConfig } from "./config.js";
import { generateSecrets } from "./secrets.js";
import { exec } from "./utils/exec.js";
import { safeErrorMessage } from "./secrets-migrate.js";

export interface SyncResult {
  target: string;
  synced: string[];
  skipped: string[];
  failed: string[];
  dryRun: boolean;
  message: string;
}

type SyncTarget = "github" | "dotenv-ci" | "stdout";

export interface SecretsSyncOptions {
  target: SyncTarget;
  dryRun?: boolean;
  projectPath?: string;
}

/**
 * Resolve secret values from the configured store, then push them to the
 * requested target (GitHub Actions secrets, .env.ci, or stdout export lines).
 */
export async function syncSecrets(
  secrets: SecretsConfig,
  options: SecretsSyncOptions,
): Promise<SyncResult> {
  const { target, dryRun = false, projectPath = process.cwd() } = options;

  // Resolve all secrets using the existing generate logic (reads from stores)
  const { results } = await generateSecrets(secrets, "/dev/null");

  const resolved: Record<string, string> = {};
  for (const r of results) {
    if (r.resolved && r.value !== null && !r.value.startsWith("(")) {
      resolved[r.name] = r.value;
    }
  }

  const synced: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  switch (target) {
    case "github":
      return syncToGitHub(resolved, dryRun, synced, skipped, failed);

    case "dotenv-ci": {
      const outPath = resolve(projectPath, ".env.ci");
      const lines = Object.entries(resolved).map(([k, v]) => `${k}=${v}`);
      if (!dryRun) {
        await writeFile(outPath, lines.join("\n") + "\n", "utf8");
        synced.push(...Object.keys(resolved));
      } else {
        skipped.push(...Object.keys(resolved));
      }
      return {
        target,
        synced,
        skipped,
        failed,
        dryRun,
        message: dryRun
          ? `Would write ${lines.length} secrets to .env.ci`
          : `Wrote ${synced.length} secrets to ${outPath}`,
      };
    }

    case "stdout": {
      const lines = Object.entries(resolved).map(
        ([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`,
      );
      if (!dryRun) {
        process.stdout.write(lines.join("\n") + "\n");
        synced.push(...Object.keys(resolved));
      } else {
        skipped.push(...Object.keys(resolved));
      }
      return {
        target,
        synced,
        skipped,
        failed,
        dryRun,
        message: dryRun
          ? `Would export ${lines.length} secrets`
          : `Exported ${synced.length} secrets`,
      };
    }

    default:
      return {
        target,
        synced: [],
        skipped: [],
        failed: [`Unknown target: ${target}`],
        dryRun,
        message: `Unknown sync target: ${target}. Use: github, dotenv-ci, stdout`,
      };
  }
}

async function syncToGitHub(
  secrets: Record<string, string>,
  dryRun: boolean,
  synced: string[],
  skipped: string[],
  failed: string[],
): Promise<SyncResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      target: "github",
      synced: [],
      skipped: [],
      failed: ["GITHUB_TOKEN not set"],
      dryRun,
      message: "Set GITHUB_TOKEN with repo scope to sync secrets to GitHub Actions",
    };
  }

  // Detect repo from git remote
  let owner: string, repo: string;
  try {
    const { stdout } = await exec("git", ["remote", "get-url", "origin"], {
      timeout: 5_000,
    });
    const remote = stdout.trim();
    const match =
      remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/) ??
      remote.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (!match) throw new Error(`Cannot parse GitHub remote: ${remote}`);
    [, owner, repo] = match;
  } catch (err) {
    return {
      target: "github",
      synced: [],
      skipped: [],
      failed: [`Could not determine GitHub repo: ${(err as Error).message}`],
      dryRun,
      message: "Run kit secrets sync --target=github from inside a GitHub repo",
    };
  }

  // Fetch repo public key for encryption
  const keyResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
  );

  if (!keyResp.ok) {
    return {
      target: "github",
      synced: [],
      skipped: [],
      failed: [`GitHub API error ${keyResp.status}: ${await keyResp.text()}`],
      dryRun,
      message: "Failed to fetch GitHub repo public key",
    };
  }

  const { key, key_id } = (await keyResp.json()) as { key: string; key_id: string };

  if (dryRun) {
    skipped.push(...Object.keys(secrets));
    return {
      target: "github",
      synced,
      skipped,
      failed,
      dryRun: true,
      message: `Would sync ${skipped.length} secrets to ${owner}/${repo} GitHub Actions`,
    };
  }

  // Encrypt and push each secret using sodium (libsodium-wrappers)
  // Attempt to use libsodium-wrappers for native encryption.
  // It's an optional peer dependency — fall back to gh CLI if absent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sodium: any = null;
  try {
    sodium = await import("libsodium-wrappers" as string);
    await sodium.ready;
  } catch {
    return syncToGitHubViaCli(secrets, owner, repo, synced, skipped, failed, dryRun);
  }

  const repoKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);

  for (const [name, value] of Object.entries(secrets)) {
    try {
      const encrypted = sodium.crypto_box_seal(new TextEncoder().encode(value), repoKey);
      const encryptedB64 = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);

      const putResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${name}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ encrypted_value: encryptedB64, key_id }),
        },
      );

      if (putResp.ok || putResp.status === 201 || putResp.status === 204) {
        synced.push(name);
      } else {
        failed.push(`${name}: ${putResp.status}`);
      }
    } catch (err) {
      // Redact: an error here can carry the secret value in its message.
      failed.push(`${name}: ${safeErrorMessage(err, [value])}`);
    }
  }

  return {
    target: "github",
    synced,
    skipped,
    failed,
    dryRun: false,
    message: `Synced ${synced.length}/${Object.keys(secrets).length} secrets to ${owner}/${repo} GitHub Actions${failed.length ? ` (${failed.length} failed)` : ""}`,
  };
}

async function syncToGitHubViaCli(
  secrets: Record<string, string>,
  owner: string,
  repo: string,
  synced: string[],
  skipped: string[],
  failed: string[],
  dryRun: boolean,
): Promise<SyncResult> {
  // Fall back to `gh secret set` CLI if libsodium is unavailable
  try {
    await exec("gh", ["--version"], { timeout: 5_000 });
  } catch {
    return {
      target: "github",
      synced: [],
      skipped: [],
      failed: ["Neither libsodium-wrappers nor gh CLI available"],
      dryRun,
      message: "Install gh CLI (brew install gh) or add libsodium-wrappers to package.json",
    };
  }

  for (const [name, value] of Object.entries(secrets)) {
    try {
      await exec("gh", ["secret", "set", name, "--repo", `${owner}/${repo}`, "--body", value], {
        timeout: 15_000,
      });
      synced.push(name);
    } catch (err) {
      // execFile errors embed the full argv (including `--body <value>`) in the
      // message — redact the secret before it reaches `failed[]`/stdout/CI logs.
      failed.push(`${name}: ${safeErrorMessage(err, [value])}`);
    }
  }

  return {
    target: "github",
    synced,
    skipped,
    failed,
    dryRun: false,
    message: `Synced ${synced.length}/${Object.keys(secrets).length} secrets to ${owner}/${repo} via gh CLI${failed.length ? ` (${failed.length} failed)` : ""}`,
  };
}
