/**
 * Decoded or downloaded text that an interpreter runs as its program.
 *
 * `echo <b64> | base64 -d | sh`, `curl … | python3`, `wget -O- … | node` and
 * `zsh -c "$(… | base64 -d)"` passed `gate-bash` silently (kit-research
 * `clickfix-vs-kit-install-gate` M03, M04, M08, M09; `binance-2026-10-29-incident-vs-kit`). The
 * gate cannot read the program before it runs, so the owner chose to refuse it (fail closed)
 * rather than decode it and gate the result.
 *
 * A download from GitHub is triaged as its repository, as `curl … | sh` already was (#531). A
 * download from any other host is refused, for a shell as for any other interpreter: the owner
 * chose to stop exempting vanity installers (`curl https://mise.run | sh`), because nothing ties
 * that script to a repository triage could read. Download it, read it, then run the file.
 *
 * An interpreter that reads its program from an argument (`python3 -m json.tool`, `node -e …`,
 * `perl -ne …`, `bash -c …`, `python3 script.py`) reads the pipe as data, and is not a hit.
 *
 * Read without execution. Pure.
 */
import { bin } from "./install-gate-hooks.js";
import { unwrapCommandWrappers } from "./install-gate-wrappers.js";
import { shellPipelines, shellWords, shellWordValue } from "./install-gate-words.js";

/** What a pipeline feeds an interpreter: GitHub refs to triage, and refusals. */
export interface PipedPayloads {
  refs: string[];
  refused: string[];
}

interface Spec {
  /** Short options whose value is program text: a hit only when that text is a substitution. */
  code: string;
  /** Short options that take a value (glued, or the next word). */
  value: string;
  /** Long options that carry program text, and long options that take the next word. */
  codeLong: string[];
  valueLong: string[];
  /** A short option that makes the shell read its program from stdin despite arguments. */
  stdin?: string;
}

const SHELL: Spec = {
  code: "c",
  value: "oOC",
  codeLong: ["--command"],
  valueLong: ["--rcfile", "--init-file", "--init-command"],
  stdin: "s",
};
const PYTHON: Spec = { code: "cm", value: "WX", codeLong: [], valueLong: [] };
const NODE: Spec = {
  code: "ep",
  value: "rC",
  codeLong: ["--eval", "--print"],
  valueLong: ["--require", "--import", "--loader", "--experimental-loader", "--conditions"],
};
const PERL: Spec = { code: "eE", value: "", codeLong: [], valueLong: [] };
const RUBY: Spec = { code: "e", value: "rICE", codeLong: [], valueLong: [] };
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "fish"]);

function specOf(head: string): Spec | null {
  if (SHELL_NAMES.has(head)) return SHELL;
  if (/^(python|pypy)(\d+(\.\d+)*)?$/.test(head)) return PYTHON;
  if (head === "node" || head === "nodejs") return NODE;
  if (head === "perl") return PERL;
  return head === "ruby" ? RUBY : null;
}

/** One pipeline stage: values for reading, raw words for substitutions, aligned. */
interface Stage {
  head: string;
  args: string[];
  raw: string[];
}

const REDIRECT = /^(\d*(>>?|<<?<?)|&>>?|>&)(.*)$/;

function stageOf(text: string): Stage | null {
  const raw: string[] = [];
  const words = shellWords(text);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const r = REDIRECT.exec(w);
    if (r && !r[3]) i++; // `> file`: the target is the next word
    if (!r) raw.push(w);
  }
  let start = 0;
  while (start < raw.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[start]!)) start++;
  const values = raw.slice(start).map(shellWordValue);
  const { argv } = unwrapCommandWrappers(values);
  if (argv.length === 0) return null;
  const from = raw.length - argv.length;
  return { head: bin(argv[0]!), args: argv.slice(1), raw: raw.slice(from + 1) };
}

/** curl writes to stdout unless `-o <file>` / `-O` names a file. */
const CURL_VALUE = "AbcCdDeEFHKmoPQrtTuUwxXyYz";

function curlToStdout(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--remote-name" || a === "--remote-name-all") return false;
    const long = /^--output(?:=(.*))?$/.exec(a);
    if (long) return (long[1] ?? args[i + 1]) === "-";
    if (!/^-[A-Za-z]/.test(a)) continue;
    for (let k = 1; k < a.length; k++) {
      const letter = a[k]!;
      if (letter === "O") return false;
      if (!CURL_VALUE.includes(letter)) continue;
      const value = k + 1 < a.length ? a.slice(k + 1) : args[++i];
      if (letter === "o") return value === "-";
      break;
    }
  }
  return true;
}

/** wget writes to stdout only with `-O -` (or `-O /dev/stdout`). */
function wgetToStdout(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const m = /^--output-document(?:=(.*))?$/.exec(a) ?? /^-[A-Za-z]*O(.*)$/.exec(a);
    if (!m) continue;
    const value = m[1] || args[i + 1];
    return value === "-" || value === "/dev/stdout";
  }
  return false;
}

const URL_RE = /^https?:\/\//i;

/** A stage whose stdout is decoded or downloaded text: its name, and any URLs it fetches. */
function producerOf(stage: Stage): { name: string; urls: string[] } | null {
  const { head, args } = stage;
  if (head === "base64" && args.some((a) => a === "--decode" || /^-[A-Za-z]*[dD]/.test(a))) {
    return { name: args.includes("--decode") ? "base64 --decode" : "base64 -d", urls: [] };
  }
  const fetch = (head === "curl" && curlToStdout(args)) || (head === "wget" && wgetToStdout(args));
  return fetch ? { name: head, urls: args.filter((a) => URL_RE.test(a)) } : null;
}

/** What one option says: stdin is the program, the program text follows, or a value follows. */
interface Cluster {
  stdin: boolean;
  code?: "glued" | "next";
  skip: boolean;
}

/** One short-option cluster (`-uc`, `-Wignore`). */
function shortCluster(a: string, spec: Spec): Cluster {
  let stdin = false;
  for (let k = 1; k < a.length; k++) {
    const letter = a[k]!;
    if (spec.stdin === letter) stdin = true;
    if (spec.code.includes(letter)) {
      return { stdin, code: k + 1 < a.length ? "glued" : "next", skip: false };
    }
    if (spec.value.includes(letter)) return { stdin, skip: k + 1 === a.length };
  }
  return { stdin, skip: false };
}

/** A long option, read like a short-option cluster. */
function longOption(a: string, spec: Spec): Cluster {
  if (spec.codeLong.includes(a)) return { stdin: false, code: "next", skip: false };
  if (spec.codeLong.some((l) => a.startsWith(`${l}=`))) {
    return { stdin: false, code: "glued", skip: false };
  }
  return { stdin: false, skip: spec.valueLong.includes(a) };
}

/** How an interpreter stage reads its program: stdin, an argument, or the index of its text. */
function programSource(stage: Stage, spec: Spec): "stdin" | "argument" | number {
  let stdin = false;
  for (let i = 0; i < stage.args.length; i++) {
    const a = stage.args[i]!;
    if (a === "-") return "stdin";
    if (a === "--") return stdin || i + 1 === stage.args.length ? "stdin" : i + 1;
    if (!/^[-+][A-Za-z-]/.test(a)) return stdin ? "stdin" : i;
    const option = a.startsWith("--") ? longOption(a, spec) : shortCluster(a, spec);
    stdin ||= option.stdin;
    if (option.code) return option.code === "glued" ? "argument" : i + 1;
    if (option.skip) i++;
  }
  return "stdin";
}

const SUBSTITUTION = /\$\(([^()]{1,2000})\)|`([^`]{1,2000})`|<\(([^()]{1,2000})\)/g;

const PLACEHOLDER = /\u0000kitsub(\d+)\u0000/g;

/** The producer behind a `$(…)`, backtick or `<(…)` in a raw word, if any. */
function substitutedProducer(
  word: string,
  subs: readonly string[],
): { name: string; urls: string[] } | null {
  for (const m of word.matchAll(PLACEHOLDER)) {
    for (const stages of shellPipelines(subs[Number(m[1])] ?? "")) {
      for (const text of stages) {
        const stage = stageOf(text);
        const found = stage && producerOf(stage);
        if (found) return found;
      }
    }
  }
  return null;
}

/** `github:<owner>/<repo>` for a github.com or raw.githubusercontent.com URL, else null. */
export function githubRepoRef(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl.replace(/[),.]+$/, ""));
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "github.com" && host !== "raw.githubusercontent.com") return null;
    const [owner, repo] = u.pathname.split("/").filter(Boolean);
    const name = repo?.replace(/\.git$/, "");
    if (!owner || !name || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;
    return `github:${owner}/${name}`;
  } catch {
    return null;
  }
}

function record(
  out: PipedPayloads,
  producer: { name: string; urls: string[] },
  interp: string,
): void {
  const refs = producer.urls.map(githubRepoRef).filter((r): r is string => r !== null);
  if (refs.length > 0) {
    out.refs.push(...refs);
    return;
  }
  out.refused.push(`piped-payload:${producer.name} | ${interp}`);
}

/** `eval "$(…)"` and `source <(…)` run their argument as shell text. */
function evalStage(stage: Stage, subs: readonly string[], out: PipedPayloads): void {
  if (stage.head !== "eval" && stage.head !== "source" && stage.head !== ".") return;
  for (const word of stage.raw) {
    const producer = substitutedProducer(word, subs);
    if (producer) record(out, producer, stage.head);
  }
}

function scanPipeline(stages: string[], subs: readonly string[], out: PipedPayloads): void {
  let upstream: { name: string; urls: string[] } | null = null;
  for (const text of stages) {
    const stage = stageOf(text);
    if (!stage) continue;
    evalStage(stage, subs, out);
    const spec = specOf(stage.head);
    const source = spec ? programSource(stage, spec) : null;
    if (source === "stdin" && upstream) record(out, upstream, stage.head);
    if (typeof source === "number" && source < stage.raw.length) {
      const producer = substitutedProducer(stage.raw[source]!, subs);
      if (producer) record(out, producer, stage.head);
    }
    upstream = upstream ?? producerOf(stage);
  }
}

/** Decoded or downloaded text that `command` pipes or substitutes into an interpreter. */
export function pipedPayloads(command: string): PipedPayloads {
  const out: PipedPayloads = { refs: [], refused: [] };
  if (!command || command.length > 100_000) return out;
  // A substitution can hold spaces and pipes, so each one becomes a single word first.
  const subs: string[] = [];
  const masked = command.replace(SUBSTITUTION, (_m, a?: string, b?: string, c?: string) => {
    subs.push(a ?? b ?? c ?? "");
    return `\u0000kitsub${subs.length - 1}\u0000`;
  });
  for (const text of [masked, ...subs]) {
    for (const stages of shellPipelines(text)) scanPipeline(stages, subs, out);
  }
  return { refs: [...new Set(out.refs)], refused: [...new Set(out.refused)] };
}

/** Add `command`'s piped payloads to an install probe: refs to triage, refusals as unverifiable. */
export function notePipedPayloads(
  command: string,
  probe: { isInstall: boolean; refs: string[]; unverifiable: string[] },
): void {
  const { refs, refused } = pipedPayloads(command);
  if (refs.length + refused.length === 0) return;
  probe.isInstall = true;
  probe.refs.push(...refs);
  probe.unverifiable.push(...refused);
}
