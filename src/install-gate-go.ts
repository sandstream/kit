/**
 * `go install <package>@<version>` and `go run <package>@<version>` go through the install gate.
 *
 * Both download a module, build it and put a program on the machine (or run it at once), and the
 * gate passed them with no output. Each versioned package becomes a `gomod:<path>@<version>` ref
 * that `gateInstall` triages (`kit triage go`): `@latest` is resolved by the triage, as `go` does.
 *
 * A package with no `@version` (`go install .`, `./cmd/x`, `./...`, or an import path) is built
 * from the module on disk: no fetch by this command, so it passes. An environment word that moves
 * the fetch off the default proxy or drops the checksum database (`GOPROXY=`, `GOFLAGS=`, ...) is
 * refused as `go-source:`, because the triage reads proxy.golang.org. Pure.
 */
import type { GemProbe } from "./install-gate-gem.js";

const MODULE_PATH = /^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9.-]+(\/[A-Za-z0-9._~-]+)*$/;
const VERSION_QUERY = /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/;

/** Build flags that take the next word as their value (`-flag value`; `-flag=value` is one word). */
const GO_VALUE = new Set([
  "-C",
  "-p",
  "-asmflags",
  "-buildmode",
  "-buildvcs",
  "-compiler",
  "-covermode",
  "-coverpkg",
  "-exec",
  "-gccgoflags",
  "-gcflags",
  "-installsuffix",
  "-ldflags",
  "-mod",
  "-modfile",
  "-overlay",
  "-pgo",
  "-pkgdir",
  "-tags",
  "-toolexec",
]);
/** Environment that changes where modules come from, or whether their checksums are verified. */
const GO_SOURCE_ENV =
  /^(GOPROXY|GONOPROXY|GOPRIVATE|GOINSECURE|GONOSUMDB|GONOSUMCHECK|GOSUMDB|GOFLAGS)=/;

/** The words after the subcommand, or null when the command is not `go install` / `go run`. */
function verbArgs(tokens: readonly string[]): { verb: string; args: readonly string[] } | null {
  if (tokens[0] !== "go") return null;
  // `-C <dir>` is the one flag go takes before its subcommand.
  const start = tokens[1] === "-C" ? 3 : /^--?C=/.test(tokens[1] ?? "") ? 2 : 1;
  const verb = tokens[start];
  if (verb !== "install" && verb !== "run") return null;
  return { verb, args: tokens.slice(start + 1) };
}

/** The package operands: every one for `install`, only the first for `run` (the rest are the program's). */
function packages(verb: string, args: readonly string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "--")
      return found.concat(verb === "run" ? args.slice(i + 1, i + 2) : args.slice(i + 1));
    if (tok.startsWith("-")) {
      // go reads `--flag` as `-flag`.
      if (!tok.includes("=") && GO_VALUE.has(tok.replace(/^--/, "-"))) i++;
      continue;
    }
    found.push(tok);
    if (verb === "run") break;
  }
  return found;
}

/** `path@query` as a ref, or null when it is not a module path and a version query. */
function moduleRef(tok: string): string | null {
  const [path, query, extra] = tok.split("@");
  if (extra !== undefined || !MODULE_PATH.test(path ?? "")) return null;
  return VERSION_QUERY.test(query ?? "") ? `gomod:${path}@${query}` : null;
}

/**
 * Record a `go install` / `go run` segment on `probe`. `tokens` are the segment's words,
 * de-quoted, with the binary's base name first; `env` holds the words before the command
 * (assignments and wrappers). Returns true when the segment was one.
 */
export function goInstall(
  tokens: readonly string[],
  probe: GemProbe,
  env: readonly string[] = [],
): boolean {
  const command = verbArgs(tokens);
  if (!command) return false;
  const refs: string[] = [];
  const refused: string[] = [];
  for (const tok of packages(command.verb, command.args)) {
    if (!tok.includes("@")) continue; // built from the module on disk
    const ref = moduleRef(tok);
    if (ref) refs.push(ref);
    else refused.push(`gomod:${tok}`);
  }
  if (refs.length === 0 && refused.length === 0) return true;
  for (const word of env)
    if (GO_SOURCE_ENV.test(word)) refused.push(`go-source:${word.split("=", 1)[0]}`);
  probe.isInstall = true;
  probe.refs.push(...refs);
  probe.unverifiable.push(...refused);
  return true;
}
