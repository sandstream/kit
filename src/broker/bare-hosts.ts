/**
 * kit exec-broker — the targets of network tools that take a bare host, not a URL.
 *
 * `nc h.example 443`, `ping h.example` and `nmap -sS 10.0.0.5` passed `gate-egress` with no
 * verified scope, where `curl https://h.example` was denied (kit-research `decepticon-vs-kit`).
 * The owner decided (2026-11-25) that these fail closed too. Decepticon met the same fail-open in
 * its own scope gate: a parser that read URLs only found no target in `nc evil.com 443`, so the
 * command passed.
 *
 * A word is a target only in the tool's target position: the tool must be the command of its
 * segment (after `sudo`, `env`, `timeout` and the like), the word must not be an option or an
 * option's value, and it must be host-shaped (a domain, an IPv4 address or range, or
 * `localhost`). `git commit -m "ping h.example"`, `echo nc h.example` and `grep nmap file` hold
 * no target. `bash -c "…"` and `powershell -c "…"` are read one level in.
 *
 * `curl`/`wget` take a URL without a scheme as their positional. Their domain targets were read by
 * extract.ts; a bare address (`curl 10.0.0.5`, `curl localhost:3000`, `curl -g [::1]:3000`) was
 * not, and passed with no verified scope where `curl http://127.0.0.1` was denied. The owner
 * decided (2026-11-26) that these fail closed too, so curl and wget are read here like the rest.
 *
 * Still not a boundary: a host in a variable, a file of targets (`nmap -iL hosts.txt`), a tool
 * not listed here, or a program that opens its own sockets passes. Pure and deterministic.
 */
import { unwrapCommandWrappers } from "../install-gate-wrappers.js";
import { shellSegments, shellWords, shellWordValue } from "../install-gate-words.js";

/** How a tool names its target: every positional, every positional as a URL (no address
 *  ranges), the first one, `[user@]host:path` words (scp), socat address specs, or only through
 *  `target` options. */
type Take = "all" | "url" | "first" | "remote" | "socat" | "named";

interface ToolSpec {
  take: Take;
  /** Options that consume the next word as a value that is not a target. */
  values: string;
  /** Options whose value is a target. */
  target?: string;
}

const NC: ToolSpec = {
  take: "all",
  values:
    "-p -s -w -i -q -X -e -c -o -O -T -V -W -I -m -g -G --source --source-port --wait --exec --sh-exec --lua-exec --output --hex-dump --append-output --proxy-type --proxy-auth",
  target: "-x --proxy",
};
const PING: ToolSpec = { take: "all", values: "-c -i -I -W -w -s -t -l -p -Q -M -S -m -n" };
const NMAP: ToolSpec = {
  take: "all",
  values:
    "-p -oN -oX -oG -oA -oS -oM -iL -iR -e -S -D -g --script --script-args --exclude --excludefile --top-ports --max-retries --host-timeout --min-rate --max-rate --data-length --source-port --ttl --datadir --resume --stylesheet --proxies --dns-servers",
};
const SSH: ToolSpec = {
  take: "first",
  values: "-b -c -D -E -e -F -I -i -L -l -m -O -o -p -Q -R -S -W -w -B",
  target: "-J",
};
const SCP: ToolSpec = { take: "remote", values: "-c -F -i -l -o -P -S -X -D", target: "-J" };
const SFTP: ToolSpec = {
  take: "first",
  values: "-B -b -c -D -F -i -l -o -P -R -S -s -X",
  target: "-J",
};
const DNS: ToolSpec = { take: "all", values: "-b -c -f -k -p -q -t -x -y -N -R -W -m" };
const PS_TNC: ToolSpec = {
  take: "first",
  values:
    "-port -commontcpport -informationlevel -hops -constrainsourceaddress -constraininterface",
  target: "-computername",
};
const PS_WEB: ToolSpec = {
  take: "first",
  values:
    "-outfile -method -body -headers -contenttype -useragent -credential -websession -sessionvariable -timeoutsec -maximumredirection -infile -form -certificate -certificatethumbprint",
  target: "-uri -proxy",
};

/** curl options that consume the next word as a value that is not a target (`-o out.json`,
 *  `--data 10.0.0.5`, `--noproxy localhost`). A proxy (`-x`) is a network target, so it is read. */
const CURL: ToolSpec = {
  take: "url",
  values:
    "-o --output -T --upload-file -d --data --data-raw --data-binary --data-urlencode --data-ascii --json -H --header -F --form --form-string -A --user-agent -e --referer -u --user -b --cookie -c --cookie-jar -w --write-out -E --cert --key --cacert --capath -K --config -m --max-time --connect-timeout --retry --retry-delay --retry-max-time -X --request -r --range -z --time-cond -D --dump-header --trace --trace-ascii --stderr --noproxy --interface --local-port --dns-servers --dns-interface --dns-ipv4-addr --dns-ipv6-addr --haproxy-clientip --limit-rate -Y --speed-limit -y --speed-time --resolve --connect-to",
};
/** wget options that consume the next word as a value that is not a target. */
const WGET: ToolSpec = {
  take: "url",
  values:
    "-a --append-output -o --output-file -O --output-document -P --directory-prefix -U --user-agent -T --timeout -t --tries -w --wait -Q --quota -e --execute -i --input-file -l --level -D --domains -A --accept -R --reject -I --include-directories -X --exclude-directories --user --password --header --referer --post-data --post-file --body-data --body-file --method --certificate --private-key --ca-certificate --ca-directory --load-cookies --save-cookies --bind-address --exclude-domains",
};

const TOOLS: Record<string, ToolSpec> = {
  curl: CURL,
  wget: WGET,
  nc: NC,
  ncat: NC,
  netcat: NC,
  ping: PING,
  ping6: PING,
  nmap: NMAP,
  ssh: SSH,
  scp: SCP,
  sftp: SFTP,
  telnet: { take: "first", values: "-l -n -b -e -X" },
  ftp: { take: "first", values: "" },
  socat: { take: "socat", values: "-d -lf -lp" },
  dig: DNS,
  nslookup: DNS,
  host: DNS,
  openssl: { take: "named", values: "", target: "-connect -proxy" },
  "test-netconnection": PS_TNC,
  tnc: PS_TNC,
  "invoke-webrequest": PS_WEB,
  iwr: PS_WEB,
  "invoke-restmethod": PS_WEB,
  irm: PS_WEB,
};

/** PowerShell's parameters are case-insensitive; POSIX tools' are not (`-o` is not `-O`). */
const POWERSHELL_TOOLS = new Set([
  "test-netconnection",
  "tnc",
  "invoke-webrequest",
  "iwr",
  "invoke-restmethod",
  "irm",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "powershell", "pwsh"]);

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** An nmap-style range or block: `10.0.0.1-50`, `10.0.0.*`, `10.0.0.0/24`. */
const IPV4_RANGE = /^\d{1,3}(?:[-,*\d]*)(?:\.[-,*\d]+){3}(?:\/\d{1,2})?$/;
const SOCAT_ADDRESS =
  /^(?:tcp|tcp4|tcp6|udp|udp4|udp6|sctp|openssl|ssl|proxy|socks4a?)(?:-connect|-sendto|-datagram)?:([^:,]+)/i;

/** An IPv6 literal in the form a URL's hostname takes (`[::1]`), or null. */
function ipv6Host(text: string): string | null {
  if (!/^[0-9a-f]*:[0-9a-f]*:[0-9a-f:.]*$/i.test(text)) return null;
  try {
    return new URL(`http://[${text}]/`).hostname;
  } catch {
    return null;
  }
}

/**
 * The host a target word names, or null when the word is not host-shaped. `user@` and a `:port`
 * or `/path` suffix are dropped; an IPv6 literal, bracketed or not, comes back bracketed as a URL
 * names it. An address range is kept whole, so no scope entry matches it; with `ranges` false
 * (a URL, where `10.0.0.5/24` is a path) none is read.
 */
export function bareTargetHost(word: string, ranges = true): string | null {
  const at = word.lastIndexOf("@");
  const rest = at >= 0 ? word.slice(at + 1) : word;
  const bracketed = /^\[([^\]]+)\](?:[:/].*)?$/.exec(rest);
  if (bracketed) return ipv6Host(bracketed[1]!);
  const v6 = ipv6Host(rest);
  if (v6) return v6;
  if (ranges && IPV4_RANGE.test(rest) && !IPV4.test(rest)) return rest;
  const host = rest.replace(/[:/].*$/, "").replace(/\.$/, "");
  if (/^localhost$/i.test(host)) return "localhost";
  if (IPV4.test(host) || DOMAIN.test(host)) return host.toLowerCase();
  return null;
}

function hasFlag(list: string | undefined, flag: string): boolean {
  return (list ?? "").split(" ").includes(flag);
}

/** Whether a curl/wget option consumes the next word as a value (extract.ts reads their domains). */
export function fetchTakesValue(tool: string, flag: string): boolean {
  return hasFlag((tool === "wget" ? WGET : CURL).values, flag);
}

/** The word a positional argument names as a target, or "" when it names none. */
function positionalTarget(tool: string, spec: ToolSpec, word: string, index: number): string {
  if (tool === "dig" && word.startsWith("@")) return word.slice(1);
  if (spec.take === "socat") return SOCAT_ADDRESS.exec(word)?.[1] ?? "";
  if (spec.take === "remote") return /^[^/:]+:/.test(word) ? word.split(":")[0]! : "";
  return spec.take === "all" || spec.take === "url" || (spec.take === "first" && index === 0)
    ? word
    : "";
}

/** `--opt=value` (and PowerShell's `-Opt:value`) as [flag, value]; else [word, undefined]. */
function splitInline(word: string, ps: boolean): [string, string | undefined] {
  const m = (ps ? /^(-[a-z][\w-]*)[=:](.*)$/ : /^(--[A-Za-z][\w-]*)=(.*)$/).exec(word);
  return m ? [m[1]!, m[2]!] : [word, undefined];
}

/** The words a tool's spec reads as targets, from its arguments. */
function targetWords(tool: string, spec: ToolSpec, args: readonly string[]): string[] {
  const out: string[] = [];
  const ps = POWERSHELL_TOOLS.has(tool);
  if (tool === "openssl" && !args.includes("s_client")) return out;
  let positional = 0;
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!;
    if (!raw.startsWith("-")) {
      out.push(positionalTarget(tool, spec, raw, positional++));
      continue;
    }
    const [flag, inline] = splitInline(ps ? raw.toLowerCase() : raw, ps);
    if (hasFlag(spec.target, flag)) out.push(...(inline ?? args[++i] ?? "").split(","));
    else if (inline === undefined && hasFlag(spec.values, flag)) i++;
  }
  return out;
}

function addTargets(tool: string, spec: ToolSpec, args: readonly string[], hosts: Set<string>) {
  for (const word of targetWords(tool, spec, args)) {
    const host = bareTargetHost(word, spec.take !== "url");
    if (host) hosts.add(host);
  }
}

/** The program text a shell runs from `-c`/`-Command`, if any. */
function shellProgram(args: readonly string[]): string | null {
  const i = args.findIndex((a) => /^-(?:c|command)$/i.test(a));
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

function segmentHosts(segment: string, hosts: Set<string>, depth: number): void {
  const words = shellWords(segment).map(shellWordValue);
  let start = 0;
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!)) start++;
  const { argv } = unwrapCommandWrappers(words.slice(start));
  const head = (argv[0] ?? "").replace(/^[({!]+/, "");
  const tool = head
    .replaceAll("\\", "/")
    .split("/")
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, "");
  const args = argv.slice(1);
  if (SHELLS.has(tool)) {
    const program = shellProgram(args);
    if (program !== null && depth < 2) commandHosts(program, hosts, depth + 1);
    return;
  }
  const spec = Object.hasOwn(TOOLS, tool) ? TOOLS[tool] : undefined;
  if (!spec) return;
  addTargets(tool, spec, args, hosts);
}

function commandHosts(command: string, hosts: Set<string>, depth: number): void {
  for (const segment of shellSegments(command)) segmentHosts(segment, hosts, depth);
}

/** Add the bare-host targets of the network tools in `command` to `hosts`. */
export function addBareToolHosts(command: string, hosts: Set<string>): void {
  if (command.length > 100_000) return;
  commandHosts(command, hosts, 0);
}

/** The same, for an argv that runs without a shell (`kit run -- nc h.example 443`). */
export function addBareToolHostsFromArgs(args: readonly string[], hosts: Set<string>): void {
  const tool = (args[0] ?? "").replaceAll("\\", "/").split("/").pop()!.toLowerCase();
  const name = tool.replace(/\.exe$/, "");
  const spec = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
  if (!spec) return;
  addTargets(name, spec, args.slice(1), hosts);
}
