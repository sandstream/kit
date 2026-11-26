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
 * curl's URL globbing (`curl 10.0.0.[1-5]`, `curl http://h[1-3].example`) is expanded into its
 * targets when it names at most 64 (broker/curl-glob.ts); a larger or malformed pattern is
 * unreadable and denied.
 *
 * The tools that parse options with getopt read a bundle of short options the same way: the first
 * letter that takes a value ends the bundle, with the rest of the word or else the next word as its
 * value. In `ssh -vp 22 h.example` the target is `h.example`, not `22`; in `curl -sSo out.json` the
 * file is not a target. An option that takes a value in one variant of a tool and none in another
 * (`ping -n` on Windows and Linux, `nc -c` in ncat and OpenBSD nc) consumes the next word only when
 * that word is not host-shaped, so the reading fails closed.
 *
 * Still not a boundary: a host in a variable, a file of targets (`nmap -iL hosts.txt`), a tool
 * not listed here, or a program that opens its own sockets passes. Pure and deterministic.
 */
import { unwrapCommandWrappers } from "../install-gate-wrappers.js";
import { shellSegments, shellWords, shellWordValue } from "../install-gate-words.js";
import { expandCurlGlob } from "./curl-glob.js";

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
  /** Options that take a value in some variants of the tool and none in others. */
  either?: string;
  /** Short options whose value is optional and only ever attached (nmap's `-Pn`, `-sV`). */
  inline?: string;
  /** The tool reads a bundle of short options (`-vp 22`) as getopt does. */
  bundles?: boolean;
  /** The tool also takes its long options after one dash (nmap's `-script`, getopt_long_only). */
  longOnly?: boolean;
}

/** nc, ncat and netcat. `-c`, `-C`, `-d` and `-Z` take a value in ncat or LibreSSL nc and none
 *  in OpenBSD/Debian nc, so they are `either`. */
const NC: ToolSpec = {
  take: "all",
  bundles: true,
  either: "-c -C -d -Z",
  values:
    "-p -s -w -i -q -X -e -o -O -T -V -W -I -m -M -g -G -P -K -R -H --source --source-port --wait --exec --sh-exec --lua-exec --output --hex-dump --append-output --proxy-type --proxy-auth",
  target: "-x --proxy",
};
/** iputils and BSD ping. Windows ping's `-n count` is `-n` (numeric output) elsewhere, and
 *  macOS's `-b boundif` and `-h sweepincr` are flags in iputils, so those are `either`. */
const PING: ToolSpec = {
  take: "all",
  bundles: true,
  either: "-n -b -h",
  values: "-c -i -I -W -w -s -t -T -l -p -Q -M -S -m -F -e -g -G -k -z -P",
};
/** nmap's getopt string is `46Ab:D:d::e:Ffg:hIi:M:m:nO::o:P::p:qRrS:s::T:Vv::`, read with
 *  getopt_long_only, so `-oN`, `-iL` and `-script` are long options. */
const NMAP: ToolSpec = {
  take: "all",
  bundles: true,
  longOnly: true,
  inline: "-d -O -P -s -v",
  values:
    "-b -i -M -m -o -T -p -oN -oX -oG -oA -oS -oM -iL -iR -e -S -D -g --script --script-args --exclude --excludefile --top-ports --max-retries --host-timeout --min-rate --max-rate --data-length --source-port --ttl --datadir --resume --stylesheet --proxies --dns-servers",
};
/** OpenSSH: `1246ab:c:e:fgi:kl:m:no:p:qstvxAB:CD:E:F:GI:J:KL:MNO:P:Q:R:S:TVw:W:XYy`. */
const SSH: ToolSpec = {
  take: "first",
  bundles: true,
  values: "-b -c -D -E -e -F -I -i -L -l -m -O -o -p -P -Q -R -S -W -w -B",
  target: "-J",
};
const SCP: ToolSpec = {
  take: "remote",
  bundles: true,
  values: "-c -F -i -l -o -P -S -X -D",
  target: "-J",
};
const SFTP: ToolSpec = {
  take: "first",
  bundles: true,
  values: "-B -b -c -D -F -i -l -o -P -R -S -s -X",
  target: "-J",
};
const DNS_VALUES = "-b -c -f -k -p -q -t -x -y -N -R -W -m";
/** dig and host bundle short options; nslookup takes `-option=value` words and does not. */
const DNS: ToolSpec = { take: "all", bundles: true, values: DNS_VALUES };
const NSLOOKUP: ToolSpec = { take: "all", values: DNS_VALUES };
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
  bundles: true,
  values:
    "-o --output -T --upload-file -d --data --data-raw --data-binary --data-urlencode --data-ascii --json -H --header -F --form --form-string -A --user-agent -e --referer -u --user -b --cookie -c --cookie-jar -w --write-out -E --cert --key --cacert --capath -K --config -m --max-time --connect-timeout --retry --retry-delay --retry-max-time -X --request -r --range -z --time-cond -D --dump-header --trace --trace-ascii --stderr --noproxy --interface --local-port --dns-servers --dns-interface --dns-ipv4-addr --dns-ipv6-addr --haproxy-clientip --limit-rate -Y --speed-limit -y --speed-time --resolve --connect-to",
};
/** wget options that consume the next word as a value that is not a target. */
const WGET: ToolSpec = {
  take: "url",
  bundles: true,
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
  telnet: { take: "first", bundles: true, values: "-l -n -b -e -X" },
  /** tnftp/BSD ftp: `-P port`, `-o output`, `-N netrc`, …; netkit and inetutils ftp take none. */
  ftp: { take: "first", bundles: true, values: "-N -o -P -q -r -s -T -u" },
  /** socat's `-d` raises the log level and takes no value; its options do not bundle. */
  socat: { take: "socat", values: "-lf -lp -T -t -b -L -W" },
  dig: DNS,
  nslookup: NSLOOKUP,
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

/** What an option does with the next word: consumes it as a value, reads it as a target,
 *  consumes it unless it is host-shaped (`either`), takes only an attached value, or nothing. */
type OptionKind = "value" | "target" | "either" | "inline" | "";

function optionKind(spec: ToolSpec, flag: string): OptionKind {
  if (hasFlag(spec.target, flag)) return "target";
  if (hasFlag(spec.values, flag)) return "value";
  if (hasFlag(spec.either, flag)) return "either";
  if (hasFlag(spec.inline, flag)) return "inline";
  return "";
}

/**
 * A bundle of short options read as getopt does: the letters that are options (up to and
 * including the first that takes a value), that option, and what is left of the word as its
 * value, whatever it holds. `-sSo out.json` ends at `-o` with nothing left; `-4vp22` ends at `-p`
 * with `22`; `-vJjump.example` ends at `-J` with `jump.example`.
 */
function shortBundle(
  spec: ToolSpec,
  flag: string,
): { letters: string; end: string; rest: string } | null {
  if (!spec.bundles || !/^-[A-Za-z0-9#:]/.test(flag)) return null;
  const body = flag.slice(1);
  const k = [...body].findIndex((letter) => optionKind(spec, `-${letter}`) !== "");
  const letters = k < 0 ? body : body.slice(0, k + 1);
  if (!/^[A-Za-z0-9#:]+$/.test(letters)) return null;
  return k < 0
    ? { letters, end: "", rest: "" }
    : { letters, end: `-${body[k]}`, rest: body.slice(k + 1) };
}

/** The option an option word names and its attached value: the word itself (or its long form,
 *  for a long-only tool), else the option that ends its short bundle. */
function readOption(spec: ToolSpec, flag: string): { kind: OptionKind; rest: string } {
  const exact = optionKind(spec, flag);
  if (exact) return { kind: exact, rest: "" };
  const long = spec.longOnly && /^-[a-z]{2,}/i.test(flag) ? optionKind(spec, `-${flag}`) : "";
  if (long) return { kind: long, rest: "" };
  const bundle = shortBundle(spec, flag);
  return bundle?.end
    ? { kind: optionKind(spec, bundle.end), rest: bundle.rest }
    : { kind: "", rest: "" };
}

/** Whether an option consumes `next` as its value (a target value is consumed and read). */
function consumesNext(spec: ToolSpec, flag: string, next: string | undefined): boolean {
  const { kind, rest } = readOption(spec, flag);
  if (rest || kind === "" || kind === "inline") return false;
  if (kind === "either") return next !== undefined && bareTargetHost(next) === null;
  return true;
}

/** Whether a curl/wget option consumes the next word as a value (extract.ts reads their domains). */
export function fetchTakesValue(tool: string, flag: string): boolean {
  return consumesNext(tool === "wget" ? WGET : CURL, flag, undefined);
}

/** Whether curl globs its URLs: `-g`/`--globoff` (alone or in a bundle) turns it off. */
function curlGlobs(args: readonly string[]): boolean {
  let on = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--globoff" || arg === "--no-globoff") on = arg === "--no-globoff";
    else if (shortBundle(CURL, arg)?.letters.includes("g")) on = false;
    if (consumesNext(CURL, arg, args[i + 1])) i++;
  }
  return on;
}

/** The host part of a URL word, for naming a pattern that is not read. */
function rawHost(word: string): string {
  const rest = word.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  return rest.slice(rest.lastIndexOf("@", rest.search(/[/?#]|$/)) + 1).replace(/[/?#].*$/, "");
}

/**
 * Add the hosts a curl URL names once its glob is expanded. A pattern only after the host
 * (`h.example/img[1-100].png`) leaves the word as it is. A malformed pattern, or one that names
 * more than 64 URLs, adds a label that no URL parser reads, so no scope entry matches it and the
 * gate denies it.
 */
function addCurlGlobHosts(word: string, hosts: Set<string>): void {
  const host = rawHost(word);
  const hostOnly = expandCurlGlob(host);
  const fixed = hostOnly?.length === 1 && hostOnly[0] === host;
  const urls = fixed ? [word] : expandCurlGlob(word);
  if (!urls) {
    hosts.add(`${host} (unexpanded curl glob)`);
    return;
  }
  for (const url of urls) {
    const h = bareTargetHost(url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""), false);
    if (h) hosts.add(h);
  }
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
    const { kind, rest } = readOption(spec, flag);
    if (kind === "target") out.push(...(inline ?? (rest || args[++i]) ?? "").split(","));
    else if (inline === undefined && consumesNext(spec, flag, args[i + 1])) i++;
  }
  return out;
}

function addTargets(tool: string, spec: ToolSpec, args: readonly string[], hosts: Set<string>) {
  const globs = tool === "curl" && curlGlobs(args);
  for (const word of targetWords(tool, spec, args)) {
    if (globs && /[[{]/.test(word)) {
      addCurlGlobHosts(word, hosts);
      continue;
    }
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
