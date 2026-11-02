/**
 * Make text safe for one cell of a markdown table. Line breaks would start a new
 * row and an unescaped `|` would start a new cell. A backslash is escaped first so
 * that one in the input cannot cancel the escape added for a pipe.
 */
export function markdownCell(text: string): string {
  return String(text)
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}
