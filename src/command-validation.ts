import { flagsForCommand, flagsWithoutValuesForCommand } from "./flag-surface.js";
import { sanitizeDisplayText } from "./display-text.js";
import { authArgumentError } from "./auth-arguments.js";
import {
  BARE_GLOBAL_FLAGS,
  environmentFlag,
  GLOBAL_FLAGS,
  rejectUnknownFlags,
  splitLeadingGlobalFlags,
} from "./utils/flags.js";

/** Keep Kit flags before the separator and preserve the child's argument sequence. */
export function normalizeCommandArgs(rawArgs: readonly string[]) {
  const { leading, rest } = splitLeadingGlobalFlags(rawArgs);
  if (rest[0] === "guard-observe") {
    // Legacy shims omit `--`. The first tool token still owns every argument after it.
    let boundary = 1;
    while (boundary < rest.length && rest[boundary].startsWith("-")) {
      if (rest[boundary] === "--") break;
      const takesValue =
        rest[boundary] === "--env" &&
        rest[boundary + 1] !== undefined &&
        !rest[boundary + 1].startsWith("-");
      boundary += takesValue ? 2 : 1;
    }
    const ownArgs = [...rest.slice(0, boundary), ...leading];
    const payload = rest.slice(boundary + (rest[boundary] === "--" ? 1 : 0));
    return { args: [...ownArgs, "--", ...payload], ownArgs, command: rest[0] };
  }
  const separator = rest.indexOf("--");
  const positional = separator < 0 ? rest : rest.slice(0, separator);
  const ownArgs = [...positional, ...leading];
  const args = [...ownArgs, ...(separator < 0 ? [] : rest.slice(separator))];
  return { args, ownArgs, command: positional[0] };
}

const PREVIEW_FORMS = new Set([
  "heal",
  "config migrate",
  "escalate feed",
  "secrets sync",
  "secrets migrate",
  "secrets vault-migrate",
  "secrets rotate",
]);

/** Reject preview flags before policy initialization or command dispatch can write state. */
function dryRunError(args: readonly string[]): string | undefined {
  const separator = args.indexOf("--");
  const ownArgs = separator < 0 ? args : args.slice(0, separator);
  const preview = ownArgs.find((arg) => arg === "--dry-run" || arg.startsWith("--dry-run="));
  if (!preview) return undefined;
  if (preview !== "--dry-run") {
    return "--dry-run does not accept a value. Use the bare flag on a supported command.";
  }
  const supported =
    PREVIEW_FORMS.has(args[0] ?? "") || PREVIEW_FORMS.has(args.slice(0, 2).join(" "));
  return supported ? undefined : "--dry-run is not supported for this command. No command was run.";
}

/** A recognized flag name must not hide an unsupported inline value. */
function bareFlagValueError(args: readonly string[]): string | undefined {
  const separator = args.indexOf("--");
  const ownArgs = separator < 0 ? args : args.slice(0, separator);
  const bareFlags = new Set([
    ...BARE_GLOBAL_FLAGS,
    ...(flagsWithoutValuesForCommand(ownArgs[0] ?? "") ?? []),
  ]);
  for (const argument of ownArgs) {
    const equals = argument.indexOf("=");
    if (equals < 0) continue;
    const name = argument.slice(0, equals);
    if (bareFlags.has(name)) return `${name} does not accept a value. Use the bare flag.`;
  }
  return undefined;
}

/** Inspection accepts only its documented alias, without a child command. */
function inspectionArgumentError(args: readonly string[]): string | undefined {
  const usage = new Map([
    ["whoami", "usage: kit whoami [--json]"],
    ["governance", "usage: kit governance [status]"],
  ]).get(args[0]);
  if (!usage) return undefined;
  const allowed = new Set([...(flagsForCommand(args[0]) ?? []), ...GLOBAL_FLAGS]);
  const positional = args[0] === "governance" ? ["status"] : [];
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (token === "--") {
      if (index === args.length - 1) return undefined;
      break;
    }
    if (token === "--env") {
      index++;
      continue;
    }
    if (token.startsWith("--")) {
      // Unknown long options retain the shared flag-floor diagnostic and exit code.
      if (!allowed.has(token.split("=")[0])) return undefined;
      continue;
    }
    if (token === positional[0]) {
      positional.shift();
      continue;
    }
    return usage;
  }
  return args.includes("--") ? usage : undefined;
}

/** Hook commands have no short options. Refuse them before policy activation. */
function hookArgumentError(args: readonly string[]): string | undefined {
  if (!["gate-bash", "gate-env", "gate-egress", "gate-fs"].includes(args[0])) return undefined;
  const flag = args.slice(1).find((token) => /^-[^-]/.test(token));
  return flag ? sanitizeDisplayText(`unknown flag for kit ${args[0]}: ${flag}`) : undefined;
}

/** Refuse invalid Kit arguments before any command or policy side effect. */
export function commandUsageError(
  args: readonly string[],
  allArgs: readonly string[] = args,
): string | undefined {
  if (["version", "-v"].includes(args[0] ?? "") || args.includes("--version")) return undefined;
  const environment = environmentFlag(args);
  return environment.kind === "invalid"
    ? environment.reason
    : (bareFlagValueError(args) ??
        dryRunError(args) ??
        inspectionArgumentError(allArgs) ??
        authArgumentError(allArgs) ??
        hookArgumentError(args));
}

/** Apply the declared flag names without treating them as proof of flag behavior. */
export function rejectCommandFlags(command: string): boolean {
  const allowedFlags = flagsForCommand(command);
  return (
    allowedFlags !== null &&
    rejectUnknownFlags(
      `kit ${command}`,
      [...allowedFlags, ...GLOBAL_FLAGS],
      process.argv,
      (message) => console.error(sanitizeDisplayText(message)),
    )
  );
}
