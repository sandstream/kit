/**
 * kit exec-broker — conservative network-target extraction (Pillar 3 step 4).
 *
 * Design: `pillar3-exec-broker-5.0.md` §3.3 / §6.2 — the egress-gate inspects a pending Bash
 * command for its network targets. Extraction is deliberately CONSERVATIVE and unambiguous:
 * only explicit `http://` / `https://` URLs are parsed (via the WHATWG URL parser), because a
 * bare word like `api.acme.com` in a command is ambiguous (an argument? a filename?) and a
 * false "network target" would break legitimate work. A command that reaches the network
 * without an explicit URL is out of this extractor's reach — honest limitation, documented,
 * not papered over. Pure + deterministic: same command → same hosts (unique, sorted).
 */

const URL_RE = /https?:\/\/[^\s"'`<>\\)\];]+/gi;

/** Unique, sorted, lowercased hostnames of every explicit http(s) URL in a shell command. */
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
  return [...hosts].sort();
}
