/**
 * A fake desktop app for the desktop monkey tests. Not a production entry point.
 *
 * It speaks the same eval-hook contract a real Tauri or Electron debug build does: it
 * polls `<hook>/cmd.js`, runs the body as an async function against a small fake DOM, and
 * writes the string result to `<hook>/out.txt`. It keeps its records under the data
 * folder the driver passes in. The mode (first argument) plants one known bug, so each
 * test can show that the driver finds exactly that bug:
 *
 * - `good`: atomic writes, and an interrupted summary is marked "interrupted" at startup.
 * - `torn`: the summary is written in two halves with a pause between them.
 * - `silent`: an interrupted summary disappears at startup without a mark.
 * - `realdir`: the app writes into the real data folder (`FAKE_REAL_DIR`).
 * - `panic`: the app logs a Rust-style panic on every start after the first.
 * - `crash`: the page throws an uncaught error when "New record" is clicked.
 * - `keepalive`: closing the window asks first ("Quit anyway?") and the app keeps
 *   running, as an app does that protects work in progress.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "./monkey-test-runner.test-support.js";

export type FakeDesktopMode =
  | "good"
  | "torn"
  | "silent"
  | "realdir"
  | "panic"
  | "crash"
  | "keepalive";

const FAKE_APP = String.raw`
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2] ?? "good";
const data = process.env.FAKE_DATA_DIR;
const hook = process.env.FAKE_HOOK_DIR;
if (!data || !hook) throw new Error("FAKE_DATA_DIR and FAKE_HOOK_DIR are required");
const records = join(data, "records");
mkdirSync(records, { recursive: true });

const startsFile = join(data, "starts.txt");
const starts = (existsSync(startsFile) ? Number(readFileSync(startsFile, "utf8")) : 0) + 1;
writeFileSync(startsFile, String(starts));
if (mode === "panic" && starts > 1) {
  console.error("thread 'main' panicked at src/lib.rs:10:5: summary state missing");
}
if (mode === "realdir" && process.env.FAKE_REAL_DIR) {
  writeFileSync(join(process.env.FAKE_REAL_DIR, "touched.txt"), String(starts));
}

const recordPath = (id) => join(records, id + ".json");
const writeAtomic = (path, value) => {
  writeFileSync(path + ".tmp", JSON.stringify(value));
  renameSync(path + ".tmp", path);
};
const list = () =>
  readdirSync(records)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(records, name), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);

// Startup recovery for a summary that was running when the app stopped. The silent
// mode has the bug this pack exists for: the work is dropped and the UI says nothing.
for (const record of list()) {
  if (record.summaryState !== "running") continue;
  const summaryState = mode === "silent" ? "none" : "interrupted";
  writeAtomic(recordPath(record.id), { ...record, summaryState });
}

let running = false;
function summarize() {
  if (running) return;
  const first = list()[0];
  if (!first) return;
  running = true;
  writeAtomic(recordPath(first.id), { ...first, summaryState: "running" });
  const done = { ...first, summary: "Decisions and actions.", summaryState: "done" };
  if (mode === "torn") {
    const text = JSON.stringify(done);
    writeFileSync(recordPath(first.id), text.slice(0, Math.floor(text.length / 2)));
    setTimeout(() => {
      writeFileSync(recordPath(first.id), text);
      running = false;
    }, 1500);
    return;
  }
  setTimeout(() => {
    writeAtomic(recordPath(first.id), done);
    running = false;
  }, 1500);
}

let win;
let created = 0;
let asking = false;
function newRecord() {
  if (mode === "crash") {
    for (const listener of win.listeners.error ?? []) listener({ message: "Cannot read properties of undefined (reading 'title')" });
    return;
  }
  created += 1;
  const id = "r" + String(starts).padStart(3, "0") + "-" + String(created).padStart(3, "0");
  writeAtomic(recordPath(id), { id, title: "Record " + id, summaryState: "none" });
}

class Event {
  constructor(type) {
    this.type = type;
  }
}

class Element {
  constructor(tag, text, onClick, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.textContent = text;
    this.onClick = onClick;
    this.attrs = attrs;
    this.type = attrs.type ?? "";
    this.disabled = false;
    this.value = "";
    this.labels = [];
    this.form = null;
  }
  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
  getBoundingClientRect() {
    return { width: 80, height: 20 };
  }
  closest() {
    return null;
  }
  click() {
    this.onClick?.();
  }
  focus() {}
  dispatchEvent() {
    return true;
  }
  get outerHTML() {
    const tag = this.tagName.toLowerCase();
    return "<" + tag + ">" + this.textContent + "</" + tag + ">";
  }
}

const controls = [
  new Element("button", "Summarize", summarize),
  new Element("button", "New record", newRecord),
  new Element("input", "", null, { type: "search", "aria-label": "Search records" }),
];

function render() {
  return [
    asking ? "A summary is running. Quit anyway?" : "Fake notes",
    ...list().map((record) => record.title + " | summary: " + record.summaryState),
  ].join("\n");
}

const document = {
  hidden: false,
  body: {
    get innerText() {
      return render();
    },
  },
  querySelectorAll(selector) {
    return selector.includes("button") ? [...controls] : [];
  },
};

function makeWindow() {
  const listeners = {};
  const fresh = {
    listeners,
    addEventListener(type, listener) {
      (listeners[type] ??= []).push(listener);
    },
    close() {
      if (mode === "keepalive" && running) {
        asking = true;
        return;
      }
      process.exit(0);
    },
    location: {
      reload() {
        win = makeWindow();
      },
    },
    console: { error() {} },
    navigator: {},
  };
  return fresh;
}
win = makeWindow();

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let busy = false;
setInterval(async () => {
  const cmd = join(hook, "cmd.js");
  if (busy || !existsSync(cmd)) return;
  busy = true;
  let out;
  try {
    const js = readFileSync(cmd, "utf8");
    unlinkSync(cmd);
    const run = new AsyncFunction("window", "document", "navigator", "getComputedStyle", "Event", "console", js);
    const current = win;
    const result = await run(current, document, current.navigator, () => ({ visibility: "visible", display: "block" }), Event, current.console);
    out = typeof result === "string" ? result : JSON.stringify(result);
  } catch (error) {
    out = "ERR " + error;
  }
  writeFileSync(join(hook, "out.tmp"), out ?? "");
  renameSync(join(hook, "out.tmp"), join(hook, "out.txt"));
  busy = false;
}, 15);
`;

const SEED = String.raw`
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const records = join(process.env.FAKE_DATA_DIR, "records");
mkdirSync(records, { recursive: true });
for (const [id, title] of [["a-weekly", "Weekly sync"], ["b-planning", "Planning"]]) {
  writeFileSync(join(records, id + ".json"), JSON.stringify({ id, title, summaryState: "none" }));
}
`;

export interface FakeDesktopRepo {
  root: string;
  realDir: string;
  configPath: string;
}

/** A repo with the fake app, a seed script, and a desktop config that drives it. */
export function fakeDesktopRepo(mode: FakeDesktopMode): FakeDesktopRepo {
  const root = mkdtempSync(join(tmpdir(), "kit-monkey-desktop-"));
  const realDir = join(root, "real-data");
  mkdirSync(realDir);
  writeFileSync(join(realDir, "settings.json"), '{"theme":"dark"}');
  writeFileSync(join(root, "fake-app.mjs"), FAKE_APP);
  writeFileSync(join(root, "seed.mjs"), SEED);
  const node = shellQuote(process.execPath);
  const config = {
    startCommand: `${node} fake-app.mjs ${mode}`,
    seedCommand: `${node} seed.mjs`,
    dataDirEnv: "FAKE_DATA_DIR",
    hookDirEnv: "FAKE_HOOK_DIR",
    realDataDirs: [realDir],
    dataFiles: ["records/*.json"],
    records:
      "return document.body.innerText.split('\\n').filter((line) => line.includes(' | ')).map((line) => line.split(' | ')[0]);",
    operations: [
      {
        name: "AI summary",
        start:
          "[...document.querySelectorAll('button')].find((b) => b.textContent === 'Summarize').click(); return 'ok';",
        outcome:
          "const m = /Weekly sync \\| summary: (\\w+)/.exec(document.body.innerText); return m && m[1] !== 'none' ? m[1] : 'lost';",
        // "running" makes the driver wait; "none" after a restart means the work vanished.
      },
    ],
    closeWindow: "window.close(); return 'ok';",
    startTimeoutMs: 10_000,
    stepTimeoutMs: 5_000,
  };
  const configPath = join(root, ".kit", "monkey-test", "desktop.json");
  mkdirSync(join(root, ".kit", "monkey-test"), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  process.env.FAKE_REAL_DIR = realDir;
  return { root, realDir, configPath };
}
