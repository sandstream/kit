/**
 * `kit usage --markdown`: the same facts as the boxed terminal view, as Markdown headings and
 * tables. The box is 66 fixed columns of box-drawing characters; on a phone, or in a chat or
 * PR comment, it wraps into noise. Markdown tables are reflowed by whatever renders them.
 *
 * Pure: it reads only the gathered facts, never the disk.
 */
import type { UsageFacts } from "./usage-report.js";

const num = (n: number): string => n.toLocaleString("en-US");

/** A ten-cell bar for a share of a whole, readable in any font. */
function bar(part: number, whole: number): string {
  const filled = whole > 0 ? Math.round((part / whole) * 10) : 0;
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
}

/** Escape a cell so a `\` or `|` in a name cannot break the table: backslashes first. */
const cell = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

function table(head: [string, string, string?], rows: string[][]): string[] {
  const cols = head.filter((h): h is string => h !== undefined);
  return [
    `| ${cols.join(" | ")} |`,
    `| ${cols.map((_, i) => (i === 0 ? "---" : "---:")).join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ];
}

function floor(f: UsageFacts): string[] {
  const fl = f.floor;
  const out = [
    "## Floor",
    "",
    `**${num(fl.events)}** audited operations · **${num(fl.refusals)}** refused`,
    "",
  ];
  if (fl.byOperation.length > 0) {
    out.push(
      ...table(
        ["Refused by", "Count", ""],
        fl.byOperation.map(([op, n]) => [`\`${op}\``, num(n), bar(n, fl.refusals)]),
      ),
      "",
    );
  }
  if (fl.byReason.length > 0) {
    out.push(
      ...table(
        ["Reason", "Gate", "Count"],
        fl.byReason.map((g) => [g.reason, `\`${g.operation}\``, num(g.count)]),
      ),
      "",
    );
  }
  if (fl.bypassedCommits > 0) {
    out.push(`⚠️ **${num(fl.bypassedCommits)}** commits bypassed the pre-commit hook.`, "");
  }
  if (fl.controls > 0) {
    out.push(
      `_${num(fl.controls)} refusals by kit's own negative controls (\`kit check\`, \`kit usage --prove\`) are not counted._`,
      "",
    );
  }
  if (fl.actorUnknown) {
    out.push("_Entries carry no cwd, so operator and test activity are counted together._", "");
  }
  return out;
}

function proof(f: UsageFacts): string[] {
  const p = f.proof;
  if (!p) {
    return [
      "## Proof",
      "",
      "_Not run. `kit usage --prove` runs the floor against inputs it must refuse._",
      "",
    ];
  }
  const icon = (ok: boolean, verdict: string): string =>
    ok ? "✅" : verdict === "inconclusive" ? "➖" : "❌";
  return [
    "## Proof",
    "",
    ...table(
      ["Control", "Observed"],
      p.controls.map((c) => [`${icon(c.ok, c.verdict)} ${c.name}`, c.observed]),
    ),
    "",
    p.ok
      ? "**Every control held.**"
      : "**A control did not hold: the floor is not doing what it claims.**",
    ...(p.note ? ["", `_${p.note}_`] : []),
    "",
  ];
}

function coverage(f: UsageFacts): string[] {
  const cv = f.coverage;
  if (!cv.at) return ["## Coverage", "", "_No saved check run. Run `kit check` once._", ""];
  const out = [
    "## Coverage",
    "",
    `Last run ${cv.at.slice(0, 16).replace("T", " ")} · **${num(cv.enumerated)}** checks`,
    "",
    ...table(
      ["Result", "Checks", ""],
      [
        ["✅ pass", num(cv.pass), bar(cv.pass, cv.enumerated)],
        ["⚠️ warn", num(cv.warn), bar(cv.warn, cv.enumerated)],
        ["❌ fail", num(cv.fail), bar(cv.fail, cv.enumerated)],
        ["➖ could not run", num(cv.couldNotRun.length), bar(cv.couldNotRun.length, cv.enumerated)],
      ],
    ),
    "",
  ];
  return out;
}

function standards(f: UsageFacts): string[] {
  const st = f.standards;
  if (!st.at || st.standards.length === 0) return [];
  return [
    "## Standards",
    "",
    ...table(
      ["Standard", "Verified", ""],
      st.standards.map((s) => [
        `${s.label} ${s.version}`,
        `${num(s.verified)} / ${num(s.total)}`,
        bar(s.verified, s.total),
      ]),
    ),
    "",
  ];
}

function triage(f: UsageFacts): string[] {
  const t = f.triage;
  const out = ["## Triage", "", `**${num(t.runs)}** packages triaged before install`, ""];
  if (t.byType.length > 0) {
    out.push(
      ...table(
        ["Ecosystem", "Triaged", ""],
        t.byType.map(([k, n]) => [k, num(n), bar(n, t.runs)]),
      ),
      "",
    );
  }
  if (t.latest) out.push(`Latest: \`${t.latest.type} ${t.latest.target}\``, "");
  return out;
}

function memoryAndMachine(f: UsageFacts): string[] {
  const m = f.memory;
  const mc = f.machine;
  return [
    "## Memory and machine",
    "",
    ...table(
      ["", "Value"],
      [
        ["Messages", num(m.messages)],
        ["Sessions", num(m.sessions)],
        ["Memory store on disk", `${Math.round(m.bytes / 1024)} kB`],
        ["Sync", m.syncConfigured ? "on" : "off, nothing leaves this machine"],
        ["Repos with a sealed audit log", `${num(mc.sealedRepos)} (${num(mc.liveRepos)} on disk)`],
        ["Curated shared decisions", num(mc.sharedEntries)],
      ],
    ),
    "",
  ];
}

function keys(f: UsageFacts): string[] {
  const k = f.keys;
  if (k.declared === 0)
    return ["## Keys", "", "_No `[secrets.keys]` declared in `.kit.toml`._", ""];
  return [
    "## Keys",
    "",
    `**${num(k.declared)}** declared` +
      (k.available === null ? "" : ` · **${num(k.available)}** available`) +
      (k.missing.length ? ` · missing: ${k.missing.map((x) => `\`${x}\``).join(", ")}` : ""),
    "",
    "_Names only: this report never reads a key's value._",
    "",
  ];
}

/** The whole report as Markdown. */
export function renderUsageMarkdown(f: UsageFacts): string {
  return [
    "# kit usage",
    "",
    ...floor(f),
    ...proof(f),
    ...coverage(f),
    ...standards(f),
    ...triage(f),
    ...keys(f),
    ...memoryAndMachine(f),
  ]
    .join("\n")
    .trimEnd()
    .concat("\n");
}
