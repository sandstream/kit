// Output-escapers for CI integration formats. Shared so every emitter (the CLI's
// self-audit/ci output and the MCP server's `kit_ci` github format) escapes
// config-controlled strings the same way — an unescaped emitter is an annotation
// /XML forgery hole (the class kit's R7 self-audit rule enforces).

// Escape data interpolated into GitHub Actions workflow commands (`::error::` etc).
// CR/LF would otherwise let attacker-controlled detail strings forge or hide
// additional annotation lines. Order matters: `%` must be escaped first.
export function escapeWorkflowCmd(s: string): string {
  return String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

// Escape data interpolated into the JUnit XML. Without this, attacker-controlled
// name/category/detail strings could close attributes/elements and forge or delete
// testcases. `&` must be replaced first; `"` is only needed inside attributes.
export function xmlEscape(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
