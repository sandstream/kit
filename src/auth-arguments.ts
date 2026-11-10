import { BARE_GLOBAL_FLAGS, environmentFlag, GLOBAL_FLAGS } from "./utils/flags.js";

export const AUTH_FLAGS: Readonly<Record<string, readonly string[]>> = {
  elevate: ["--scope", "--ttl-minutes", "--list-scopes", "--json"],
  status: ["--json"],
  revoke: [],
  "setup-totp": ["--issuer", "--account", "--overwrite"],
};

const valueFlags = new Set(["--scope", "--ttl-minutes", "--issuer", "--account"]);

export function authBareFlags(subcommand: string): readonly string[] {
  return Object.hasOwn(AUTH_FLAGS, subcommand)
    ? AUTH_FLAGS[subcommand].filter((flag) => !valueFlags.has(flag))
    : [];
}

const usage = "usage: kit auth <elevate|status|revoke|setup-totp>";

/** Return the extra tokens a global flag consumes, an error, or undefined for another option. */
function globalFlagWidth(token: string, name: string, equals: number): number | string | undefined {
  if (!GLOBAL_FLAGS.some((flag) => flag === name)) return undefined;
  if (BARE_GLOBAL_FLAGS.some((flag) => flag === name) && equals >= 0)
    return `${usage}: invalid global flag value.`;
  return token === "--env" ? 1 : 0;
}

function parseAuthOptions(
  options: readonly string[],
  allowed: readonly string[],
): Map<string, string | true> | string {
  const values = new Map<string, string | true>();
  const end = options.at(-1) === "--" ? options.length - 1 : options.length;
  for (let index = 0; index < end; index++) {
    const token = options[index];
    const equals = token.indexOf("=");
    const name = equals < 0 ? token : token.slice(0, equals);
    const skipped = globalFlagWidth(token, name, equals);
    if (typeof skipped === "string") return skipped;
    if (skipped !== undefined) {
      index += skipped;
      continue;
    }
    if (!allowed.includes(name) || values.has(name))
      return `${usage}: unsupported or repeated option.`;
    if (!valueFlags.has(name)) {
      if (equals >= 0) return `${usage}: ${name} does not accept a value.`;
      values.set(name, true);
      continue;
    }
    const value = equals < 0 ? options[++index] : token.slice(equals + 1);
    if (!value?.trim() || value.startsWith("-")) return `${usage}: ${name} requires a value.`;
    values.set(name, value);
  }
  return values;
}

/** Reject malformed authorization input before prompts, policy activation, or storage. */
export function authArgumentError(args: readonly string[]): string | undefined {
  if (args[0] !== "auth") return undefined;
  const [, sub, ...options] = args;
  if (!Object.hasOwn(AUTH_FLAGS, sub)) return usage;
  if (environmentFlag(args).kind === "invalid") return `${usage}: invalid environment option.`;
  const values = parseAuthOptions(options, AUTH_FLAGS[sub]);
  if (typeof values === "string") return values;
  const ttl = values.get("--ttl-minutes");
  if (typeof ttl === "string" && (!/^\d+$/.test(ttl) || Number(ttl) < 1 || Number(ttl) > 240)) {
    return `${usage}: --ttl-minutes must be an integer between 1 and 240.`;
  }
  if (sub === "elevate") {
    if (values.has("--list-scopes") && (values.has("--scope") || values.has("--ttl-minutes"))) {
      return `${usage}: --list-scopes cannot be combined with a grant request.`;
    }
    if (values.has("--json") && !values.has("--list-scopes")) {
      return `${usage}: elevate --json requires --list-scopes.`;
    }
  }
  return undefined;
}
