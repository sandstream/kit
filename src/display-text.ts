/** Secret and terminal-control protection for diagnostic text. */
import { stripVTControlCharacters } from "node:util";
import { stripUnsafeChars } from "./memory/injection.js";
import { redactSecrets, SECRET_PATTERNS } from "./utils/redactSecrets.js";

// These patterns start with fixed provider prefixes and have no unbounded failing suffix.
// Generic assignments and JWTs need their boundaries to avoid repeated suffix searches.
const DISPLAY_PREFIX_LABELS = new Set([
  "stripe-key",
  "stripe-webhook-secret",
  "github-classic-pat",
  "github-oauth",
  "github-server-token",
  "github-fine-pat",
  "aws-access-key",
  "google-api-key",
  "slack-token",
  "ai-api-key",
  "openai-key",
  "resend-key",
  "azure-account-key",
  "sendgrid-key",
  "slack-app-token",
  "npm-token",
]);

// Display cleanup can erase a credential's word boundary. Detection remains unchanged.
const DISPLAY_SECRETS = SECRET_PATTERNS.map((pattern) => ({
  re: new RegExp(
    DISPLAY_PREFIX_LABELS.has(pattern.label)
      ? pattern.re.source.replaceAll("\\b", "")
      : pattern.re.source,
    pattern.re.flags,
  ),
  replacement: pattern.replacement ?? "[REDACTED]",
}));

function maskDisplaySecrets(text: string): string {
  for (const { re, replacement } of DISPLAY_SECRETS) text = text.replace(re, replacement);
  return text.replace(/[A-Za-z0-9_.-]+/g, maskJwtRun);
}

/** Mask the whole display run when three adjacent components have the shared JWT shape. */
function maskJwtRun(run: string): string {
  const parts = run.split(".");
  for (let i = 0; i + 2 < parts.length; i++) {
    const start = parts[i].indexOf("eyJ");
    if (
      start >= 0 &&
      parts[i].length - start >= 13 &&
      parts[i + 1].length >= 10 &&
      parts[i + 2].length >= 10
    ) {
      return "[REDACTED]";
    }
  }
  return run;
}

/** Sanitize display text only. Callers must retain raw file identities separately. */
export function sanitizeDisplayText(text: string): string {
  // Convert C1 sequence delimiters to the ESC forms understood by the Node helper.
  // Mask recognizable credentials while their original word boundaries still exist.
  const visible = redactSecrets(stripUnsafeChars(redactSecrets(text)))
    .replace(
      /[\u0090\u0098\u009b-\u009f]/g,
      (char) => "\x1b" + String.fromCharCode(char.charCodeAt(0) - 0x40),
    )
    // Keep ESC and BEL until sequence removal. Other controls can obscure a VT sequence.
    .replace(/[\u0000-\u0006\u0008-\u001a\u001c-\u001f\u007f-\u009f\u2028\u2029]/g, "");
  // Discard complete or unterminated VT control strings, including APC, PM and SOS.
  const withoutStrings = visible.replace(
    /\x1b(?:\][\s\S]*?(?:\x07|\x1b\\|$)|[PX^_][\s\S]*?(?:\x1b\\|$)|\\)/g,
    "",
  );
  // BEL terminates OSC above. Elsewhere it can occur inside a CSI sequence.
  const clean = stripVTControlCharacters(withoutStrings.replace(/\x07/g, "")).replace(
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    "",
  );
  // Control removal can join the pieces of a credential. Mask again after that join.
  return maskDisplaySecrets(clean).replace(/\s+/g, " ").trim();
}
