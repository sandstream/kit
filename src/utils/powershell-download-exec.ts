/**
 * PowerShell's download-and-execute shapes: `irm <url> | iex` and `iex (irm <url>)`, with
 * `iwr`/`Invoke-WebRequest`/`Invoke-RestMethod` or `(New-Object Net.WebClient).DownloadString`
 * as the download and `iex`/`Invoke-Expression` as the interpreter.
 *
 * `agent-audit` flagged these in hook and skill files while `gate-bash` passed the same command
 * (kit-research `decepticon-vs-kit`), so both read them from here. Text-level and bounded: a
 * long line cannot make a pattern backtrack. Pure.
 */
const DOWNLOAD_CMDLET = "iwr|irm|invoke-webrequest|invoke-restmethod";
const WEBCLIENT = "new-object\\s+(?:system\\.)?net\\.webclient";
const IEX = "iex|invoke-expression";

/** A download piped into Invoke-Expression: `irm https://… | iex`. */
export const PS_DOWNLOAD_PIPE_IEX = new RegExp(
  `(?<dl>\\b(?:${DOWNLOAD_CMDLET})\\b|${WEBCLIENT})[^\\n|]{0,400}\\|\\s*(?<ex>${IEX})\\b`,
  "i",
);

/** Invoke-Expression over a download: `iex (irm https://…)`. */
export const PS_IEX_OF_DOWNLOAD = new RegExp(
  `\\b(?<ex>${IEX})\\b[\\s(]{0,20}(?<dl>(?:${DOWNLOAD_CMDLET})\\b|\\(?\\s*${WEBCLIENT})`,
  "i",
);

/** One download-and-execute: the download's and the interpreter's names, and the URLs it reads. */
export interface PowerShellDownloadExec {
  download: string;
  exec: string;
  urls: string[];
}

const URL_RE = /https?:\/\/[^\s"'`<>|;)]+/gi;

function nameOf(word: string): string {
  return /webclient/i.test(word) ? "Net.WebClient" : word.toLowerCase();
}

/** Every download-and-execute in `text`, one per line that holds one. */
export function powershellDownloadExecs(text: string): PowerShellDownloadExec[] {
  const out: PowerShellDownloadExec[] = [];
  for (const line of text.slice(0, 100_000).split("\n")) {
    const m = PS_DOWNLOAD_PIPE_IEX.exec(line) ?? PS_IEX_OF_DOWNLOAD.exec(line);
    if (!m?.groups) continue;
    const span = line.slice(m.index, m.index + m[0].length + 400);
    out.push({
      download: nameOf(m.groups.dl!.replace(/^\(\s*/, "")),
      exec: m.groups.ex!.toLowerCase(),
      urls: span.match(URL_RE) ?? [],
    });
  }
  return out;
}
