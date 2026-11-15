/**
 * Drawing primitives for `kit usage`'s boxed terminal view: a fixed-width row, a titled rule,
 * a number and a bar. Kept apart from the tabs that use them so `src/commands/usage.ts` holds
 * what the report says, and this file holds how a row is laid out.
 */
import { c } from "./utils/colors.js";

/** Visible columns between the box's borders. */
export const WIDTH = 66;

/** Visible length: padding maths has to ignore the colour escapes, or the box comes out ragged. */
export function plain(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Cut text to `max` visible columns, ending in "…" when anything was cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * One row of the box, padded to exactly WIDTH visible columns between the borders. Overlong
 * content is truncated rather than allowed to push the right border out: a ragged box reads as a
 * broken tool, and a report that looks broken does not get read.
 */
export function line(left: string, right = ""): string {
  let l = left;
  let r = right;
  if (plain(l).length + plain(r).length + 1 > WIDTH) {
    // Trim the left side first — the right column is the number, which must stay exact.
    const room = WIDTH - plain(r).length - 2;
    if (room <= 0) {
      r = "";
      l = clip(plain(l), WIDTH - 1);
    } else {
      l = clip(plain(l), room);
    }
  }
  const pad = Math.max(1, WIDTH - plain(l).length - plain(r).length);
  return `${c.dim}│${c.reset} ${l}${" ".repeat(pad)}${r} ${c.dim}│${c.reset}`;
}

/** A horizontal rule across the box, with an optional title set into it. */
export function rule(title = ""): string {
  const t = title ? ` ${title} ` : "";
  const dashes = "─".repeat(Math.max(0, WIDTH + 2 - plain(t).length));
  return `${c.dim}├${t}${dashes}┤${c.reset}`;
}

export function num(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** A share of a whole as a bar `width` cells wide; empty when there is no whole. */
export function bar(part: number, whole: number, width = 18): string {
  if (whole <= 0) return "";
  const filled = Math.round((part / whole) * width);
  return `${"█".repeat(filled)}${c.dim}${"░".repeat(width - filled)}${c.reset}`;
}
