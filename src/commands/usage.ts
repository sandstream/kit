/**
 * `kit usage` — what kit knows, and that it knows it the same way every time.
 *
 * Deliberately NOT a token or money report. There is no counterfactual for "what would this have
 * cost without kit", and a saved-you-N number without one is invented — which would break the
 * rule the rest of this codebase enforces. What is measurable is the reliability axis:
 *
 *   - how many checks are ENUMERATED, and how many of those could not run — with reasons;
 *   - how many operations the floor refused, and whether the log can even tell who did them;
 *   - what was triaged before it was installed;
 *   - how many repos on this machine kit has sealed a log in.
 *
 * The twelve "could not run" rows on kit's own repo are the point, not the footnote: an agent
 * asked "is this safe?" improvises a subset, returns a verdict with no denominator, and leaves no
 * record of what it skipped. The denominator is the product.
 *
 * Layout follows the boxed, tabbed shape of the harness it runs inside. Interactive only on a
 * TTY: kit runs in CI and inside hooks, and a view that waits for a keypress there hangs a build.
 */

import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import type { UsageFacts } from "../usage-report.js";

const TABS = ["floor", "coverage", "memory", "triage", "machine", "proof"] as const;
type Tab = (typeof TABS)[number];

const WIDTH = 66;

/** Visible length: padding maths has to ignore the colour escapes, or the box comes out ragged. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * One row of the box, padded to exactly WIDTH visible columns between the borders. Overlong
 * content is truncated rather than allowed to push the right border out: a ragged box reads as a
 * broken tool, and a report that looks broken does not get read.
 */
function line(left: string, right = ""): string {
  let l = left;
  let r = right;
  if (plain(l).length + plain(r).length + 1 > WIDTH) {
    // Trim the left side first — the right column is the number, which must stay exact.
    const room = WIDTH - plain(r).length - 2;
    if (room <= 0) {
      r = "";
      l = plain(l).slice(0, WIDTH - 1);
    } else {
      l = plain(l).slice(0, room);
    }
  }
  const pad = Math.max(1, WIDTH - plain(l).length - plain(r).length);
  return `${c.dim}│${c.reset} ${l}${" ".repeat(pad)}${r} ${c.dim}│${c.reset}`;
}

function rule(title = ""): string {
  const t = title ? ` ${title} ` : "";
  const dashes = "─".repeat(Math.max(0, WIDTH + 2 - plain(t).length));
  return `${c.dim}├${t}${dashes}┤${c.reset}`;
}

function num(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function bar(part: number, whole: number, width = 18): string {
  if (whole <= 0) return "";
  const filled = Math.round((part / whole) * width);
  return `${"█".repeat(filled)}${c.dim}${"░".repeat(width - filled)}${c.reset}`;
}

function renderCoverage(f: UsageFacts): string[] {
  const cv = f.coverage;
  if (cv.enumerated === 0) {
    return [
      line(`${c.dim}no saved check run in .kit/runs — run \`kit check\` once${c.reset}`),
      line(""),
      line(`${c.dim}Coverage is the difference kit exists to make: a declared set of${c.reset}`),
      line(`${c.dim}checks with a denominator, rather than whatever got improvised.${c.reset}`),
    ];
  }
  const out = [
    line(
      `${c.bold}${num(cv.enumerated)}${c.reset} checks enumerated`,
      cv.at ? `${c.dim}${cv.at.slice(0, 16).replace("T", " ")}${c.reset}` : "",
    ),
    line(""),
    line(
      `${c.green}pass${c.reset}          ${num(cv.pass).padStart(4)}  ${bar(cv.pass, cv.enumerated)}`,
    ),
    line(
      `${c.yellow}warn${c.reset}          ${num(cv.warn).padStart(4)}  ${bar(cv.warn, cv.enumerated)}`,
    ),
    line(
      `${c.red}fail${c.reset}          ${num(cv.fail).padStart(4)}  ${bar(cv.fail, cv.enumerated)}`,
    ),
    line(
      `${c.dim}could not run${c.reset} ${num(cv.couldNotRun.length).padStart(4)}  ${bar(cv.couldNotRun.length, cv.enumerated)}`,
    ),
    line(""),
    line(`${c.dim}what was NOT checked, and why:${c.reset}`),
  ];
  for (const r of cv.couldNotRun.slice(0, 6)) {
    out.push(
      line(
        `  ${c.dim}−${c.reset} ${r.name.slice(0, 34)}`,
        `${c.dim}${r.reason.slice(0, 24)}${c.reset}`,
      ),
    );
  }
  if (cv.couldNotRun.length > 6) {
    out.push(line(`  ${c.dim}… ${cv.couldNotRun.length - 6} more (--json for all)${c.reset}`));
  }
  return out;
}

function renderFloor(f: UsageFacts): string[] {
  const fl = f.floor;
  const out = [
    line(
      `${c.bold}${num(fl.events)}${c.reset} audited operations`,
      `${c.bold}${num(fl.refusals)}${c.reset} refused`,
    ),
    line(""),
  ];
  if (fl.events === 0) {
    out.push(
      line(`${c.dim}no .kit-audit.jsonl here — nothing has been audited in this repo${c.reset}`),
    );
    return out;
  }
  for (const [op, n] of fl.byOperation) {
    out.push(line(`  ${op.slice(0, 30)}`, `${num(n).padStart(6)}  ${bar(n, fl.refusals, 12)}`));
  }
  out.push(line(""));
  out.push(
    line(
      `  ${c.dim}hooks bypassed${c.reset}`,
      `${num(fl.bypassedCommits).padStart(6)}  ${c.dim}--no-verify${c.reset}`,
    ),
  );
  if (fl.actorUnknown) {
    // Say it rather than presenting test-generated events as operator activity.
    out.push(line(""));
    out.push(
      line(`${c.yellow}!${c.reset} ${c.dim}entries carry no cwd, so operator and test${c.reset}`),
    );
    out.push(line(`  ${c.dim}activity cannot be told apart in these totals${c.reset}`));
  }
  return out;
}

function renderTriage(f: UsageFacts): string[] {
  const t = f.triage;
  if (t.runs === 0) {
    return [line(`${c.dim}no triage runs recorded in this repo${c.reset}`)];
  }
  return [
    line(`${c.bold}${num(t.runs)}${c.reset} packages triaged before install`),
    line(""),
    ...t.byType.map(([type, n]) => line(`  ${type}`, `${num(n).padStart(6)}`)),
    line(""),
    ...(t.latest
      ? [
          line(
            `  ${c.dim}latest${c.reset}`,
            `${c.dim}${t.latest.type} ${t.latest.target.slice(0, 28)}${c.reset}`,
          ),
        ]
      : []),
  ];
}

function renderMachine(f: UsageFacts): string[] {
  const m = f.machine;
  return [
    line(
      `${c.bold}${num(m.sealedRepos)}${c.reset} repos with a sealed audit log`,
      `${c.dim}${num(m.liveRepos)} still on disk${c.reset}`,
    ),
    line(""),
    line(`  ${c.dim}curated shared decisions${c.reset}`, `${num(m.sharedEntries).padStart(6)}`),
    line(""),
    line(`${c.dim}The anchor record keys the HMAC tip per log path, so it is${c.reset}`),
    line(`${c.dim}an index of every repo this machine has sealed — read it${c.reset}`),
    line(`${c.dim}whole with \`kit audit verify --all\`.${c.reset}`),
  ];
}

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} kB`;
}

/**
 * Project keys are sanitised absolute paths, so a plain truncation leaves fragments like
 * "lopment-claude-code-kit-public". Drop the leading home-directory part and keep the tail that
 * actually names the project.
 */
function projectLabel(key: string): string {
  const cut = key.lastIndexOf("Development-");
  const tail = cut >= 0 ? key.slice(cut + "Development-".length) : key.replace(/^-+/, "");
  return tail.length > 30 ? tail.slice(-30) : tail;
}

function renderMemory(f: UsageFacts): string[] {
  const m = f.memory;
  if (!m.path) return [line(`${c.dim}no memory store on this machine${c.reset}`)];
  const out = [
    // The ownership claim, substantiated: a path and a size, not a tenant row in someone's cloud.
    line(
      `${c.bold}${num(m.messages)}${c.reset} messages`,
      `${c.bold}${num(m.sessions)}${c.reset} sessions`,
    ),
    line(
      `${c.dim}${m.path.replace(process.env.HOME ?? "~", "~")}${c.reset}`,
      `${c.dim}${bytes(m.bytes)} on your disk${c.reset}`,
    ),
    line(""),
  ];
  if (m.outputTokens !== null || m.cacheReadTokens !== null) {
    out.push(line(`${c.dim}last ${m.windowDays}d${c.reset}`, ""));
    if (m.outputTokens !== null)
      out.push(line(`  generated`, `${num(m.outputTokens).padStart(14)} tok`));
    if (m.cacheReadTokens !== null)
      out.push(line(`  context re-read`, `${num(m.cacheReadTokens).padStart(14)} tok`));
    if (m.outputTokens && m.cacheReadTokens) {
      const ratio = Math.round(m.cacheReadTokens / Math.max(1, m.outputTokens));
      out.push(line(`  ${c.dim}re-read : generated${c.reset}`, `${c.yellow}${ratio}:1${c.reset}`));
    }
    out.push(line(""));
  }
  out.push(line(`${c.dim}per project (last ${m.windowDays}d)${c.reset}`));
  for (const p of m.projects.slice(0, 5)) {
    out.push(
      line(
        `  ${projectLabel(p.project)}`,
        `${num(p.messages).padStart(6)} msg  ${p.outputTokens === null ? `${c.dim}—${c.reset}` : `${num(p.outputTokens).padStart(9)} tok`}`,
      ),
    );
  }
  out.push(line(""));
  out.push(
    line(
      `${c.dim}harnesses${c.reset}`,
      `${c.dim}${m.harnesses.map(([h, n]) => `${h} ${num(n)}`).join(" · ") || "—"}${c.reset}`,
    ),
  );
  out.push(
    line(
      m.syncConfigured
        ? `${c.dim}sync: your own transport, opt-in${c.reset}`
        : `${c.dim}sync: off — nothing leaves this machine${c.reset}`,
    ),
  );
  return out;
}

function renderProof(f: UsageFacts): string[] {
  const p = f.proof;
  if (!p) {
    return [
      line(`${c.dim}not run — the controls cost a few seconds${c.reset}`),
      line(""),
      line(`${c.dim}\`kit usage --prove\` hands the floor inputs it MUST refuse and${c.reset}`),
      line(`${c.dim}reports what happened. Counting recorded activity proves the${c.reset}`),
      line(`${c.dim}gate existed; a negative control proves it still works.${c.reset}`),
    ];
  }
  const out: string[] = [];
  for (const ctl of p.controls) {
    const icon = ctl.ok
      ? `${c.green}✓${c.reset}`
      : ctl.verdict === "inconclusive"
        ? `${c.dim}−${c.reset}`
        : `${c.red}✗${c.reset}`;
    out.push(line(`${icon} ${ctl.name.slice(0, 44)}`));
    out.push(line(`   ${c.dim}${ctl.observed.slice(0, 56)}${c.reset}`));
  }
  out.push(line(""));
  out.push(
    line(
      p.ok
        ? `${c.green}every control held${c.reset}`
        : `${c.red}a control did not hold — the floor is not doing what it claims${c.reset}`,
    ),
  );
  if (p.note) out.push(line(`${c.yellow}!${c.reset} ${c.dim}${p.note.slice(0, 58)}${c.reset}`));
  return out;
}

const RENDER: Record<Tab, (f: UsageFacts) => string[]> = {
  memory: renderMemory,
  proof: renderProof,
  coverage: renderCoverage,
  floor: renderFloor,
  triage: renderTriage,
  machine: renderMachine,
};

const TITLE: Record<Tab, string> = {
  memory: "Memory",
  proof: "Proof",
  coverage: "Coverage",
  floor: "Floor",
  triage: "Triage",
  machine: "Machine",
};

export function renderTab(facts: UsageFacts, tab: Tab, opts: { interactive: boolean }): string {
  const head = `${c.dim}╭─${c.reset} ${c.bold}${c.cyan}kit usage${c.reset} ${c.dim}·${c.reset} ${TITLE[tab]} `;
  // A body row spends WIDTH + 4 visible columns: border, space, content, space, border. The
  // header must land on exactly the same total or the box comes out ragged.
  const headFill = Math.max(0, WIDTH + 3 - plain(head).length);
  const lines = [
    `${head}${c.dim}${"─".repeat(headFill)}╮${c.reset}`,
    line(""),
    ...RENDER[tab](facts),
    line(""),
  ];
  // Six tabs do not fit in bracket notation, and a wrapped tab row breaks the box. Numbers and
  // separators only, so the row stays inside WIDTH on an 80-column terminal.
  const tabRow = TABS.map((t, i) =>
    t === tab
      ? `${c.bold}${i + 1} ${TITLE[t]}${c.reset}`
      : `${c.dim}${i + 1} ${TITLE[t]}${c.reset}`,
  ).join(`${c.dim} · ${c.reset}`);
  lines.push(rule());
  lines.push(line(tabRow, opts.interactive ? `${c.dim}q ✕${c.reset}` : ""));
  lines.push(`${c.dim}╰${"─".repeat(WIDTH + 2)}╯${c.reset}`);
  return lines.join("\n");
}

export async function cmdUsage(): Promise<boolean> {
  const { gatherUsage } = await import("../usage-report.js");
  const facts = gatherUsage();

  // The controls spawn real gate invocations, so they are opt-in: a dashboard that costs seconds
  // every time it opens is a dashboard nobody opens.
  if (hasFlag(process.argv, "--prove")) {
    const { proveFloor } = await import("../usage-prove.js");
    facts.proof = proveFloor(process.cwd(), { deep: hasFlag(process.argv, "--deep") });
  }

  if (hasFlag(process.argv, "--json")) {
    console.log(JSON.stringify(facts, null, 2));
    return true;
  }

  const requested = (flagValue(process.argv, "--tab") ?? "").toLowerCase();
  if (requested && !TABS.includes(requested as Tab)) {
    console.error(`${c.red}unknown tab: ${requested}${c.reset}`);
    console.error(`${c.dim}available: ${TABS.join(" ")}${c.reset}`);
    return false;
  }
  let tab: Tab = (requested as Tab) || "floor";

  // Non-TTY (CI, a hook, a pipe): print once and leave. A view that waits for a keypress there
  // hangs the job it was meant to inform.
  const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true;
  if (!interactive) {
    // An explicit --tab is honoured even here; without one, print every tab, so a piped reader is
    // not silently handed one sixth of the report and left to think that was all of it.
    const wanted = requested ? [tab] : TABS;
    console.log(wanted.map((t) => renderTab(facts, t, { interactive: false })).join("\n"));
    return true;
  }

  // Raw stdin directly, no readline: readline consumes the data events this needs, and it adds
  // nothing when the only input is a single keystroke. Measured through a pty, the readline
  // version swallowed the keypress and never restored the screen.
  //
  // The restore is registered BEFORE the alternate screen is entered, and runs on exit and on a
  // signal as well as on `q`. A view that leaves the terminal in the alternate screen with raw
  // mode still on is worse than no view: the operator's shell looks dead.
  const { writeSync } = await import("node:fs");
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    // writeSync, not process.stdout.write: on the Ctrl-C path the process exits immediately after
    // this call, and a buffered write is lost — measured, with the terminal left in the alternate
    // screen. The bytes that give the operator their shell back must not be queued.
    writeSync(1, "\x1b[?1049l");
  };
  process.once("exit", restore);
  process.once("SIGINT", () => {
    restore();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    restore();
    process.exit(143);
  });

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?1049h");

  const draw = (): void => {
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(renderTab(facts, tab, { interactive: true }) + "\n");
  };
  draw();

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      process.stdin.off("data", onKey);
      process.stdin.off("end", finish);
      restore();
      resolve();
    };
    const onKey = (buf: Buffer): void => {
      const k = buf.toString();
      // q, Ctrl-C, Esc — and Ctrl-D, because a terminal that only answers to one key is a trap.
      if (k === "q" || k === "\x03" || k === "\x1b" || k === "\x04") return void finish();
      const n = Number.parseInt(k, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= TABS.length) {
        tab = TABS[n - 1];
        draw();
      }
    };
    process.stdin.on("data", onKey);
    // EOF: stdin closed under us (a pty test, a wrapper, a closed pipe). Leave rather than hang.
    process.stdin.once("end", finish);
  });

  // Print the tab the operator left on, so the terminal keeps a record of what they looked at.
  console.log(renderTab(facts, tab, { interactive: false }));
  return true;
}
