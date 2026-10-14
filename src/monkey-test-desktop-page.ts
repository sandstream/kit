/**
 * Code the desktop driver runs inside the app's main window through the eval hook.
 *
 * Every call is one short evaluation that returns at once. The page never waits on its
 * own timers, because a webview pauses timers while its window is hidden (a locked
 * screen, a covered window). The driver does all waiting between calls.
 *
 * The strings use only `window`, `document`, `navigator`, `getComputedStyle`, `Event`,
 * and `console`, so the same code runs in a real webview and in the test fake.
 */

/** Installs the error monitor once per page load. Returns "ok". */
export const PAGE_MONITOR = String.raw`
const w = window;
if (!w.__kitMonkey) {
  const state = { errors: [], trail: [] };
  w.__kitMonkey = state;
  const push = (kind, message) => state.errors.push({ kind: kind, message: String(message).slice(0, 400) });
  w.addEventListener('error', (event) => push('pageerror', event && event.message));
  w.addEventListener('unhandledrejection', (event) => push('unhandledrejection', event && event.reason && (event.reason.message || event.reason)));
  const original = console.error.bind(console);
  console.error = (...args) => { push('console', args.map(String).join(' ')); original(...args); };
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {}, readText: async () => '' } });
  } catch (error) {}
  w.alert = (message) => push('alert', message);
  w.confirm = () => true;
  w.prompt = () => null;
}
return 'ok';
`;

/** Defines check() and step(seed). Needs PAGE_MONITOR first. Returns "ok". */
export const PAGE_HELPERS = String.raw`
const K = window.__kitMonkey;
K.NASTY = ['', ' ', 'Monkey', '<b>x</b>', '<img src=x onerror="window.__kitMonkeyXss=1">', '../../etc/passwd', '/', '-1', '0', '99999', 'ÅÄÖ 🎉', 'x'.repeat(500)];
// The inputs above never contain these words, so a hit comes from the app itself.
K.FATAL = [/\bundefined\b/, /\bNaN\b/, /\[object Object\]/, /Uncaught/];
K.visible = (el) => {
  const box = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[inert],[aria-hidden=true]');
};
K.controls = () => [...document.querySelectorAll('button, a[href], input, select, textarea, [role=button]')].filter((el) => !el.disabled && K.visible(el));
K.label = (el) => (el.getAttribute('aria-label') || (el.labels && [...el.labels].map((l) => l.textContent).join(' ')) || el.getAttribute('placeholder') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim();
K.check = () => {
  const fail = [];
  const text = document.body.innerText;
  const hit = K.FATAL.find((pattern) => pattern.test(text));
  if (hit) fail.push({ kind: 'fatal-text', message: String(hit) });
  if (text.trim().length === 0) fail.push({ kind: 'blank', message: 'the page has no text' });
  if (window.__kitMonkeyXss) fail.push({ kind: 'xss', message: 'an input payload ran as script' });
  fail.push(...K.errors.splice(0));
  const errText = [...document.querySelectorAll('.error, [role=alert]')].map((el) => el.textContent.trim()).filter(Boolean);
  const unnamed = K.controls().filter((el) => !K.label(el) && el.type !== 'hidden').map((el) => el.outerHTML.slice(0, 120));
  return { fail: fail, errText: errText, unnamed: unnamed, last: K.trail.slice(-5), hidden: Boolean(document.hidden) };
};
K.step = (seed) => {
  const result = K.check();
  let s = seed >>> 0;
  const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const all = K.controls();
  if (!all.length) { result.fail.push({ kind: 'no-controls', message: 'no visible control to use' }); return JSON.stringify(result); }
  const el = pick(all);
  const tag = el.tagName.toLowerCase();
  const type = el.type || '';
  let action;
  if (tag === 'select') {
    const option = pick([...el.options]);
    el.value = option.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    action = 'select';
  } else if ((tag === 'input' && !['checkbox', 'radio', 'button', 'submit'].includes(type)) || tag === 'textarea') {
    const value = pick(K.NASTY);
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    action = 'type';
    if (rnd() < 0.4 && el.form) { el.form.requestSubmit(); action = 'type + submit'; }
  } else {
    el.click();
    action = 'click';
  }
  result.action = action + ' [' + tag + (type ? ':' + type : '') + '] ' + K.label(el).slice(0, 40);
  K.trail.push(result.action);
  return JSON.stringify(result);
};
return 'ok';
`;

export interface PageCheck {
  fail: { kind: string; message: string }[];
  errText: string[];
  unnamed: string[];
  last: string[];
  hidden: boolean;
  action?: string;
}

export const PAGE_CHECK = "return JSON.stringify(window.__kitMonkey.check());";

export function pageStep(seed: number): string {
  return `return window.__kitMonkey.step(${seed >>> 0});`;
}

/** Raw technical errors that should never reach the user. The UI should explain instead. */
export const TECHNICAL_ERROR_TEXT =
  /invalid (?:args|type)|expected (?:u32|i32|f32|a string)|missing field|serde|panicked|called `\w+::unwrap|os error \d+|stack trace|at [\w.]+ \(.+:\d+:\d+\)/i;
