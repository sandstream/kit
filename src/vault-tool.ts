/**
 * The CLI a project's chosen secrets vault is logged in through. A UI (the kit-health mod) shows
 * "<vault> is not logged in" for exactly this tool, and does not list other tools kit merely found
 * on the machine: a project whose vault is Infisical is not told to sign in to 1Password.
 * A store with no CLI login (`env`, `dotenvx`, `config`) has no tool.
 */
const VAULT_TOOLS: Readonly<Record<string, string>> = {
  "1password": "op",
  "aws-sm": "aws",
  bitwarden: "bw",
  doppler: "doppler",
  infisical: "infisical",
  vault: "vault",
};

export function vaultToolFor(store: string | undefined): string | null {
  return store !== undefined && Object.hasOwn(VAULT_TOOLS, store) ? VAULT_TOOLS[store]! : null;
}
