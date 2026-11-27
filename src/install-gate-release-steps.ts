/**
 * The steps of a prebuilt-binary install, read from one command's tokens: a fetch to a file
 * (curl, wget, `gh release download`, PowerShell `Invoke-WebRequest -OutFile`,
 * `Start-BitsTransfer`), an extraction (tar, unzip, 7z, gunzip and friends, `Expand-Archive`),
 * and the steps that run what was fetched: make it executable, run it, put it on PATH, or build
 * it. `install-gate-release.ts` chains them. Pure: no I/O, nothing executed or expanded.
 *
 * A value the shell would expand (`$URL`, a backtick) is never guessed at: it is "dynamic", and
 * the chain treats it as possibly the fetched file (fail-closed).
 */
import { PREFIX_BINS, skipWrapperArgs } from "./install-gate-flags.js";
import { shellWords, stripRedirections } from "./install-gate-words.js";

/** What a fetch saved: file names (lower-case basenames), or "any" when the name is chosen at run time. */
export interface Fetch {
  url: string | null;
  /** Why the URL could not be read, when `url` is null. */
  why?: string;
  names: Set<string> | "any";
  stdout?: boolean;
}

/** Shell or PowerShell expansion, or a cmd `%VAR%`. A URL's own `%20` is not one. */
export const DYNAMIC = /[$`]|%[A-Za-z_][A-Za-z0-9_()]*%/;
/** A token that is an expansion in an operand position (`$URL`, `${URL}`, `$(…)`, a backtick). */
const EXPANDED = /^["']?[$`]/;
const KEYWORDS = new Set(["then", "do", "else", "{", "(", "!", "time"]);

/**
 * The command's argv: quotes removed, redirections, wrappers and leading assignments dropped.
 * Backslashes are kept: in PowerShell and cmd they separate paths (`.\tool.exe`), and a POSIX
 * escape left in place can only make a name match less often in a command that has no fetch.
 */
export function commandWords(stage: string): string[] {
  const raw = stripRedirections(shellWords(stage)).map((w) => w.replace(/["']/g, ""));
  let i = 0;
  while (i < raw.length) {
    const t = raw[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || KEYWORDS.has(t)) i++;
    else if (PREFIX_BINS.has(headName(t))) i = skipWrapperArgs(raw, i + 1);
    else break;
  }
  return raw.slice(i).filter((t) => t !== "");
}

/** A command name as matched: last path component, lower-case, without `.exe`. */
export function headName(token: string): string {
  const base =
    token
      .replace(/^\\+(?=[^\\])/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  return base.toLowerCase().replace(/\.exe$/, "");
}

/** A file name as matched against what was fetched: last path component, lower-case. */
export function fileName(path: string): string {
  return (path.split(/[\\/]/).pop() ?? "").toLowerCase();
}

function urlName(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  } catch {
    return "";
  }
}

const isUrl = (t: string): boolean => /^https?:\/\//i.test(t);
const urlOperand = (t: string): boolean => isUrl(t) || EXPANDED.test(t);

/** curl options whose value is the next token. `-K`/`--config` can name URLs and outputs: unreadable. */
const CURL_VALUED = new Set(
  "-H -d -u -A -e -X -T -F -b -c -x -w -m -r -C -E -U --header --data --data-binary --data-raw --data-urlencode --user --user-agent --referer --request --form --cookie --cookie-jar --proxy --max-time --connect-timeout --retry --write-out --output-dir --cacert --cert --key --range --create-dirs-mode".split(
    " ",
  ),
);
/** wget options whose value is the next token (`-o` is wget's log file, not its output). */
const WGET_VALUED = new Set(
  "-o -a -P -t -T -U -e -w --header --user --password --user-agent --directory-prefix --tries --timeout --execute --wait --output-file --append-output".split(
    " ",
  ),
);

function fetchOf(url: string | null, name: string | undefined | "any"): Fetch {
  const dynamicUrl = url !== null && DYNAMIC.test(url);
  const known = url !== null && !dynamicUrl ? url : null;
  const why = known
    ? undefined
    : dynamicUrl
      ? `the URL ${url} is expanded at run time`
      : "no literal URL";
  if (name === undefined) return { url: known, why, names: new Set(), stdout: true };
  const base = name === "any" ? "" : fileName(name);
  const names = base === "" || DYNAMIC.test(base) ? "any" : new Set([base]);
  return { url: known, why, names };
}

interface CurlOutputs {
  outputs: string[];
  remote: boolean;
  headerName: boolean;
  config?: boolean;
  urls: string[];
}

/** A short-option cluster (`-fsSLo`, `-OJ`): `-o` takes the rest of the cluster or the next token. */
function curlCluster(cluster: string, next: string | undefined, o: CurlOutputs): number {
  if (cluster.includes("J")) o.headerName = true;
  const at = cluster.indexOf("o");
  if (cluster.includes("O") && (at < 0 || cluster.indexOf("O") < at)) o.remote = true;
  if (at < 0) return 0;
  const glued = cluster.slice(at + 1);
  if (glued) o.outputs.push(glued);
  else if (next !== undefined) o.outputs.push(next);
  return glued || next === undefined ? 0 : 1;
}

/** One curl option, read into `o`. Returns how many extra tokens it consumed. */
function curlOption(t: string, next: string | undefined, o: CurlOutputs): number {
  if (t === "--output" || t === "--url") {
    if (next !== undefined) (t === "--url" ? o.urls : o.outputs).push(next);
    return 1;
  }
  if (t.startsWith("--output=")) o.outputs.push(t.slice(9));
  else if (t === "--remote-name" || t === "--remote-name-all") o.remote = true;
  else if (t === "--remote-header-name") o.headerName = true;
  else if (/^-[A-Za-z]+/.test(t) && !t.startsWith("--")) return curlCluster(t.slice(1), next, o);
  return 0;
}

function curlFetches(argv: string[]): Fetch[] {
  const o: CurlOutputs = { outputs: [], remote: false, headerName: false, urls: [] };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i]!;
    if (CURL_VALUED.has(t)) i++;
    else if (t === "-K" || t === "--config" || t.startsWith("--config=")) o.config = true;
    else if (urlOperand(t)) o.urls.push(t);
    else i += curlOption(t, argv[i + 1], o);
  }
  const fetches = o.urls.map((url, k) => {
    if (o.outputs[k] !== undefined) return fetchOf(url, o.outputs[k]);
    if (o.headerName) return fetchOf(url, "any");
    return o.remote ? fetchOf(url, urlName(url) || "any") : fetchOf(url, undefined);
  });
  if (o.config)
    fetches.push({ url: null, why: "curl reads URLs from a config file", names: "any" });
  return fetches;
}

function wgetFetches(argv: string[]): Fetch[] {
  let output: string | undefined;
  let any = false;
  const urls: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i]!;
    if (WGET_VALUED.has(t)) i++;
    else if (t === "-O" || t === "--output-document") output = argv[++i];
    else if (t.startsWith("--output-document=")) output = t.slice(18);
    else if (/^-[A-Za-z]*O./.test(t) && !t.startsWith("--")) output = t.slice(t.indexOf("O") + 1);
    else if (t === "--content-disposition" || t === "-i" || t.startsWith("--input-file"))
      any = true;
    else if (urlOperand(t)) urls.push(t);
  }
  if (output === "-") return urls.map((u) => fetchOf(u, undefined));
  if (urls.length === 0 && any)
    return [{ url: null, why: "wget reads its URLs from a file", names: "any" }];
  return urls.map((u) => fetchOf(u, output ?? (any ? "any" : urlName(u) || "any")));
}

/** A PowerShell parameter's value: `-Name value`, accepting any unambiguous prefix of at least `min` letters. */
export function psParam(argv: string[], name: string, min: number): string | undefined {
  for (let i = 1; i < argv.length - 1; i++) {
    const p = /^-([A-Za-z]+):?$/.exec(argv[i]!)?.[1]?.toLowerCase();
    if (p && p.length >= min && name.startsWith(p)) return argv[i + 1];
  }
  return undefined;
}

/** The first argument that is not a `-Param` or a parameter's value. */
export function psPositional(argv: string[], valued: string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const p = /^-([A-Za-z]+):?$/.exec(argv[i]!)?.[1]?.toLowerCase();
    if (!p) return argv[i];
    if (valued.some((v) => v.startsWith(p))) i++;
  }
  return undefined;
}

const PS_WEB = new Set(["invoke-webrequest", "iwr", "invoke-restmethod", "irm", "curl", "wget"]);

function powershellFetches(head: string, argv: string[]): Fetch[] | null {
  if (head === "start-bitstransfer") {
    const url = psParam(argv, "source", 1) ?? psPositional(argv, ["destination", "source"]);
    return [fetchOf(url ?? null, psParam(argv, "destination", 1) ?? "any")];
  }
  const out = psParam(argv, "outfile", 4);
  if (!PS_WEB.has(head) || out === undefined) return null;
  const url =
    psParam(argv, "uri", 2) ?? psPositional(argv, ["outfile", "method", "headers", "body"]);
  return [fetchOf(url ?? null, out)];
}

function ghReleaseDownload(argv: string[]): Fetch[] | null {
  if (headName(argv[0]!) !== "gh" || argv[1] !== "release" || argv[2] !== "download") return null;
  const opt = (short: string, long: string): string[] =>
    argv.flatMap((t, i) =>
      t === short || t === long
        ? [argv[i + 1] ?? ""]
        : t.startsWith(`${long}=`)
          ? [t.slice(long.length + 1)]
          : [],
    );
  const valued = new Set([
    "-R",
    "--repo",
    "-p",
    "--pattern",
    "-O",
    "--output",
    "-D",
    "--dir",
    "-A",
    "--archive",
  ]);
  const tag = argv.slice(3).find((t, i, a) => !t.startsWith("-") && !valued.has(a[i - 1] ?? ""));
  const repo = opt("-R", "--repo")[0];
  const patterns = opt("-p", "--pattern");
  const output = opt("-O", "--output")[0];
  if (
    !repo ||
    !tag ||
    patterns.length === 0 ||
    patterns.some((p) => /[*?[]/.test(p) || DYNAMIC.test(p))
  ) {
    return [
      {
        url: null,
        why: "gh release download without -R, a tag and literal -p asset names",
        names: "any",
      },
    ];
  }
  return patterns.map((p) =>
    fetchOf(`https://github.com/${repo}/releases/download/${tag}/${p}`, output ?? p),
  );
}

/** What one command fetches to a file or to stdout, or null when it fetches nothing. */
export function fetchesOf(argv: string[]): Fetch[] | null {
  const head = headName(argv[0] ?? "");
  const ps = powershellFetches(head, argv);
  if (ps) return ps;
  if (head === "curl") return curlFetches(argv);
  if (head === "wget") return wgetFetches(argv);
  return ghReleaseDownload(argv);
}
