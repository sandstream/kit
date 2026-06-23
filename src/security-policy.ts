import { readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";

export interface AllowlistEntry {
  name: string;
  /** semver range allowed for this package, e.g. ">=14.0.0 <15" or "*" */
  range: string;
  reason?: string;
}

export interface SecretPolicyEntry {
  /** Maximum allowed time-to-live for credentials issued from this key, in hours. */
  max_ttl_hours?: number;
  /** Required permission scope. Free-form string so providers map to their own
   * vocabulary (Stripe "restricted-readonly", AWS "ReadOnlyAccess", GCP IAM
   * role names, etc.). When set, `policy check` reports any key whose vault
   * config doesn't pin a scope. */
  scope?: string;
  /** Soft cap on monthly spend in USD. Enforcement is provider-side
   * (Stripe spend-limits, OpenAI usage-limits); kit only records the
   * intended limit so it can be re-verified manually or by future S5 work. */
  spend_cap_usd?: number;
  /** When true, only `*_restricted` / least-privilege key variants are
   * accepted (Stripe restricted keys, AWS IAM roles vs root credentials). */
  require_restricted?: boolean;
  /** Free-text reason — survives in audit logs when violations are reported. */
  description?: string;
}

export interface Allowlist {
  policy: {
    /** Block runtime dependencies that aren't on the allowlist */
    enforce_runtime: boolean;
    /** Block devDependencies that aren't on the allowlist */
    enforce_dev: boolean;
    /** Allow `*` ranges (treat as wildcard accept). Default false. */
    allow_wildcards: boolean;
    /** Require every key in `[secrets.keys]` to have a `secrets` entry below. */
    enforce_secrets?: boolean;
    /** Default cap when a key has no spend_cap_usd of its own (USD). */
    default_spend_cap_usd?: number;
  };
  packages: AllowlistEntry[];
  /** Per-key policy. Keyed by the env-var name from `[secrets.keys]`. */
  secrets?: Record<string, SecretPolicyEntry>;
}

const ALLOWLIST_FILE = ".kit-allowlist.json";

const DEFAULT_POLICY: Allowlist["policy"] = {
  enforce_runtime: true,
  enforce_dev: false,
  allow_wildcards: false,
};

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export async function readAllowlist(cwd: string = process.cwd()): Promise<Allowlist | null> {
  const path = resolve(cwd, ALLOWLIST_FILE);
  try {
    await access(path);
    const text = await readFile(path, "utf-8");
    return JSON.parse(text) as Allowlist;
  } catch {
    return null;
  }
}

export async function writeAllowlist(list: Allowlist, cwd: string = process.cwd()): Promise<void> {
  const path = resolve(cwd, ALLOWLIST_FILE);
  await writeFile(path, JSON.stringify(list, null, 2) + "\n", "utf-8");
}

async function readPackageJson(cwd: string): Promise<PackageJson | null> {
  try {
    const text = await readFile(resolve(cwd, "package.json"), "utf-8");
    return JSON.parse(text) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * Bootstraps `.kit-allowlist.json` from the current package.json. Every
 * existing dependency is allowed at its currently-recorded range. The user
 * iterates from there: tightening, removing, or annotating.
 */
export async function initAllowlist(cwd: string = process.cwd()): Promise<Allowlist> {
  const pkg = await readPackageJson(cwd);
  const packages: AllowlistEntry[] = [];

  if (pkg) {
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      packages.push({ name, range, reason: "runtime" });
    }
    for (const [name, range] of Object.entries(pkg.devDependencies ?? {})) {
      packages.push({ name, range, reason: "dev" });
    }
  }

  const list: Allowlist = {
    policy: DEFAULT_POLICY,
    packages,
  };
  await writeAllowlist(list, cwd);
  return list;
}

export interface PolicyViolation {
  name: string;
  range: string;
  reason: "not-on-allowlist" | "wildcard-blocked";
  kind: "runtime" | "dev";
}

export interface SecretPolicyViolation {
  key: string;
  reason: "no-policy-entry" | "no-spend-cap" | "no-scope" | "ttl-too-long";
  detail: string;
}

/**
 * Reports packages in package.json that are missing from the allowlist
 * (or that use a wildcard `*` range when policy.allow_wildcards is false).
 * Does not check version-range *satisfaction* — that's npm's job; this is
 * just a presence-and-shape gate suitable for CI.
 */
export async function checkAllowlist(
  cwd: string = process.cwd(),
): Promise<{ list: Allowlist | null; violations: PolicyViolation[] }> {
  const list = await readAllowlist(cwd);
  if (!list) return { list: null, violations: [] };

  const pkg = await readPackageJson(cwd);
  if (!pkg) return { list, violations: [] };

  const allowed = new Map(list.packages.map((p) => [p.name, p]));
  const violations: PolicyViolation[] = [];

  const check = (
    deps: Record<string, string> | undefined,
    kind: "runtime" | "dev",
    enforce: boolean,
  ): void => {
    if (!enforce || !deps) return;
    for (const [name, range] of Object.entries(deps)) {
      const entry = allowed.get(name);
      if (!entry) {
        violations.push({ name, range, reason: "not-on-allowlist", kind });
        continue;
      }
      if (!list.policy.allow_wildcards && (entry.range === "*" || range === "*")) {
        violations.push({ name, range, reason: "wildcard-blocked", kind });
      }
    }
  };

  check(pkg.dependencies, "runtime", list.policy.enforce_runtime);
  check(pkg.devDependencies, "dev", list.policy.enforce_dev);

  return { list, violations };
}

/**
 * Audits the secrets section of an allowlist against the keys actually
 * referenced in `[secrets.keys]` of the user's `.kit.toml`. Returns one
 * violation per gap.
 *
 * Strictness depends on policy.enforce_secrets:
 *   true  → every secrets.keys entry must have a matching policy entry.
 *   false → only secrets that DO have a partial policy are validated, so
 *           teams can opt-in gradually without instant-fail.
 */
export function checkSecretPolicy(
  list: Allowlist,
  configKeys: string[],
  paidServices: Set<string> = new Set(["STRIPE", "OPENAI", "ANTHROPIC", "RESEND", "VERCEL"]),
): SecretPolicyViolation[] {
  const violations: SecretPolicyViolation[] = [];
  const policyBlock = list.secrets ?? {};
  const enforce = list.policy.enforce_secrets ?? false;
  const defaultCap = list.policy.default_spend_cap_usd;

  for (const key of configKeys) {
    const entry = policyBlock[key];

    if (!entry) {
      if (enforce) {
        violations.push({
          key,
          reason: "no-policy-entry",
          detail: "Key is in [secrets.keys] but missing from allowlist.secrets",
        });
      }
      continue;
    }

    // Heuristic: is this key paid? Look at the prefix before the first `_`.
    const prefix = key.split("_")[0]?.toUpperCase() ?? "";
    const isPaid = paidServices.has(prefix);

    if (isPaid && entry.spend_cap_usd === undefined && defaultCap === undefined) {
      violations.push({
        key,
        reason: "no-spend-cap",
        detail: `${prefix} keys must declare spend_cap_usd (or set policy.default_spend_cap_usd)`,
      });
    }

    if (entry.scope === undefined && entry.require_restricted !== true) {
      violations.push({
        key,
        reason: "no-scope",
        detail: "Set scope (e.g. 'read', 'ReadOnlyAccess') or require_restricted=true",
      });
    }

    if (entry.max_ttl_hours !== undefined && entry.max_ttl_hours > 768) {
      // 768 hours = 32 days = HashiCorp Vault's default TTL ceiling; longer
      // than this is essentially "never expires" and undermines the policy.
      violations.push({
        key,
        reason: "ttl-too-long",
        detail: `max_ttl_hours=${entry.max_ttl_hours} > 768 (32d). Use rotation instead.`,
      });
    }
  }

  return violations;
}

/**
 * Adds a package to the allowlist with the version range from package.json.
 * Returns true if the package was added, false if it was already there.
 */
export async function addToAllowlist(
  pkgName: string,
  cwd: string = process.cwd(),
): Promise<{ added: boolean; entry: AllowlistEntry | null }> {
  let list = await readAllowlist(cwd);
  if (!list) {
    list = { policy: DEFAULT_POLICY, packages: [] };
  }
  if (list.packages.find((p) => p.name === pkgName)) {
    return { added: false, entry: list.packages.find((p) => p.name === pkgName)! };
  }
  const pkg = await readPackageJson(cwd);
  if (!pkg) return { added: false, entry: null };
  const range = pkg.dependencies?.[pkgName] ?? pkg.devDependencies?.[pkgName] ?? "*";
  const kind = pkg.dependencies?.[pkgName] ? "runtime" : "dev";
  const entry: AllowlistEntry = { name: pkgName, range, reason: kind };
  list.packages.push(entry);
  await writeAllowlist(list, cwd);
  return { added: true, entry };
}
