import { exec } from "./utils/exec.js";

export interface OnePasswordStatus {
  installed: boolean;
  authenticated: boolean;
  error?: string;
}

export interface OnePasswordVault {
  id: string;
  name: string;
  type: string;
}

export interface OnePasswordItem {
  id: string;
  title: string;
  vault: { id: string; name: string };
  fields: Array<{ id: string; label: string; type: string }>;
}

/**
 * Check if 1Password CLI (op) is installed and authenticated
 */
export async function check1PasswordStatus(): Promise<OnePasswordStatus> {
  try {
    // Test if op CLI is available
    const { stdout: versionOutput } = await exec("op", ["--version"], {
      timeout: 5000,
    });

    if (!versionOutput) {
      return {
        installed: false,
        authenticated: false,
        error: "op CLI returned no version information",
      };
    }

    // Test if user is authenticated
    try {
      await exec("op", ["whoami"], { timeout: 5000 });
      return {
        installed: true,
        authenticated: true,
      };
    } catch {
      return {
        installed: true,
        authenticated: false,
        error: "op CLI is installed but you are not signed in. Run 'op signin' to authenticate.",
      };
    }
  } catch {
    return {
      installed: false,
      authenticated: false,
      error:
        "op CLI not found. Install 1Password CLI: https://developer.1password.com/docs/cli/get-started/",
    };
  }
}

export interface OnePasswordAccount {
  account_uuid?: string;
  user_uuid?: string;
  url: string;
  email: string;
  user_type?: string;
  shorthand?: string;
}

/**
 * Lists configured 1Password accounts (`op account list`). Returns [] if op
 * is missing, no account has been added yet, or the call fails. Used to
 * distinguish "user has no account configured" from "user signed out" —
 * the two need different remediation paths.
 */
export async function list1PasswordAccounts(): Promise<OnePasswordAccount[]> {
  try {
    const { stdout } = await exec("op", ["account", "list", "--format=json"], {
      timeout: 5000,
    });
    if (!stdout.trim()) return [];
    return JSON.parse(stdout) as OnePasswordAccount[];
  } catch {
    return [];
  }
}

/**
 * Reports which 1Password authentication mode the host is configured for.
 * - "service-account": OP_SERVICE_ACCOUNT_TOKEN env var is set — fully headless
 * - "desktop-integration": op responds without a session var (`op whoami` works) —
 *   the desktop app is brokering biometric auth
 * - "eval-signin": op is installed and accounts exist, but `op whoami` fails
 *   AND no service-account token is present. User must run `eval $(op signin)`
 *   to set OP_SESSION_<shorthand> in their parent shell.
 * - "no-account": op installed but no account has been added (run `op account add`)
 * - "not-installed": op CLI itself is missing
 */
export type OnePasswordMode =
  | "service-account"
  | "desktop-integration"
  | "eval-signin"
  | "no-account"
  | "not-installed";

export async function detect1PasswordMode(): Promise<{ mode: OnePasswordMode; hint: string }> {
  if (process.env.OP_SERVICE_ACCOUNT_TOKEN) {
    return {
      mode: "service-account",
      hint: "OP_SERVICE_ACCOUNT_TOKEN is set — using headless mode.",
    };
  }

  const status = await check1PasswordStatus();
  if (!status.installed) {
    return {
      mode: "not-installed",
      hint: "Install: https://developer.1password.com/docs/cli/get-started/",
    };
  }

  const accounts = await list1PasswordAccounts();
  if (accounts.length === 0) {
    return {
      mode: "no-account",
      hint: "Run 'op account add' first (one-time), then re-run kit.",
    };
  }

  if (status.authenticated) {
    return {
      mode: "desktop-integration",
      hint: "Authenticated via desktop app or active OP_SESSION.",
    };
  }

  return {
    mode: "eval-signin",
    hint:
      "Either enable 1Password 8 → Developer → 'Connect with CLI' for biometric, " +
      "or run `eval $(op signin)` in your shell before re-running kit.",
  };
}

/**
 * List available 1Password vaults
 */
export async function list1PasswordVaults(): Promise<OnePasswordVault[]> {
  try {
    const { stdout } = await exec("op", ["vault", "list", "--format=json"], {
      timeout: 10000,
    });
    const vaults = JSON.parse(stdout) as OnePasswordVault[];
    return vaults;
  } catch {
    return [];
  }
}

/**
 * List items in a specific vault
 */
export async function list1PasswordItems(vaultId: string): Promise<OnePasswordItem[]> {
  try {
    const { stdout } = await exec("op", ["item", "list", "--vault", vaultId, "--format=json"], {
      timeout: 10000,
    });
    const items = JSON.parse(stdout) as OnePasswordItem[];
    return items;
  } catch {
    return [];
  }
}

/**
 * Generate a reference string for a 1Password item
 * Helps users construct proper ref strings for config
 */
export function generate1PasswordRef(vault: string, item: string, field?: string): string {
  if (field) {
    return `op://${vault}/${item}/${field}`;
  }
  return `op://${vault}/${item}`;
}

/**
 * Validate a 1Password reference string format
 */
export function validate1PasswordRef(ref: string): boolean {
  // ref should be op://vault/item or op://vault/item/field
  const pattern = /^op:\/\/[^/]+\/[^/]+(\/.+)?$/;
  return pattern.test(ref);
}
