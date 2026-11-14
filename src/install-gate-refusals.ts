/** Explain unresolved commands without suggesting a package triage that cannot resolve them. */
function explainCarrier(tokens: readonly string[]): string | null {
  const wrapper = tokens.find(
    (token) => token.startsWith("wrapper-command:") || token.startsWith("wrapper-option:"),
  );
  if (wrapper) {
    return (
      `UNVERIFIED COMMAND: ${wrapper}. Use explicit command arguments without this wrapper option. ` +
      `Kit cannot determine the command that this option runs.`
    );
  }
  const config = tokens.find(
    (token) =>
      token.endsWith(" source-configuration") ||
      /^alt-registry:(--config-file|--config|-c|--pip-args)$/.test(token),
  );
  if (config) {
    return (
      `UNVERIFIED SOURCE: ${config}. Remove the source configuration to use the default registry. ` +
      `Kit cannot verify installs with this option. Package triage does not verify the unread configuration.`
    );
  }
  return null;
}

/**
 * Explain an `indirect-bin:` refusal in terms of the HAZARD, not the machinery.
 *
 * The generic wording ("cannot reduce to a triage target … run `kit triage`") is accurate about
 * kit's internals and useless about the command, and it was read as a false positive: a
 * `git commit -m "… \`deployment:env:view\` …"` was blocked, and the operator concluded the gate
 * had mis-parsed a commit message. It had not. Backticks inside DOUBLE quotes are command
 * substitution, so that command never commits that text — the shell runs the backticked token
 * and splices its output in, silently deleting the words:
 *
 *     $ bash -c 'echo "... the permission `deployment:env:view` ..."'
 *     bash: deployment:env:view: command not found
 *     ... the permission  ...
 *
 * The gate caught a real silent corruption and got distrusted for it, because the message
 * described a triage target instead of the substitution. `kit triage` / `kit pkg` are nonsense
 * advice for this command, and following the workaround (write the message to a file, use `-F`)
 * hides the defect rather than fixing it. So: name it, and give the fix.
 */
export function explainUnverifiable(tokens: readonly string[]): string | null {
  const carrier = explainCarrier(tokens);
  if (carrier) return carrier;
  const sources = tokens.filter((t) => t.startsWith("repo-source:"));
  if (sources.length > 0) {
    return (
      `unsupported repository source: ${sources.map((t) => t.slice("repo-source:".length)).join(", ")}. ` +
      "The gate can verify only unambiguous GitHub repository sources. Refusing this install (fail-closed)."
    );
  }
  const substitution = tokens.find(
    (t) => t.startsWith("indirect-bin:`") || t.startsWith("indirect-bin:$("),
  );
  if (!substitution) return null;
  const tok = substitution.slice("indirect-bin:".length);
  const backtick = tok.startsWith("`");
  return (
    `${tok} is COMMAND SUBSTITUTION, not text: the shell runs it and splices its output into ` +
    `the argument, so the characters you typed never reach the command` +
    (backtick
      ? ` (backticks substitute inside double quotes too — single quotes are literal).`
      : `.`) +
    ` If you meant it literally, use single quotes, or pass the text via a file ` +
    `(e.g. \`git commit -F <file>\`). If you meant to run it, run it as its own command so ` +
    `kit can see what installs.`
  );
}
