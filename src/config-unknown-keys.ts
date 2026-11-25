import { sanitizeDisplayText } from "./display-text.js";

// Keys of [browser] that kit reads; anything else is warned about, not rejected.
const KNOWN_BROWSER_KEYS = new Set(["app", "start", "build", "routes", "port", "cdp_url"]);

// loadConfig runs several times per command (an unknown section printed 6-9 times in one
// `kit check`); warn once per process, file and key.
const warned = new Set<string>();

/** True the first time this file and key are seen in this process. */
function firstWarning(path: string, key: string): boolean {
  if (warned.has(`${path}\0${key}`)) return false;
  warned.add(`${path}\0${key}`);
  return true;
}

/**
 * Warn about config keys kit ignores. Sections and [browser] keep passthrough for forward
 * compatibility, so a typo would otherwise be accepted silently (BH-12 for [browser]).
 */
export function warnUnknownConfigKeys(
  path: string,
  raw: Record<string, unknown>,
  knownSections: ReadonlySet<string>,
  browser: object | undefined,
): void {
  // Typos like [tolls] vs [tools]
  for (const key of Object.keys(raw)) {
    if (!knownSections.has(key) && firstWarning(path, `[${key}]`)) {
      console.warn(
        `Warning: unknown section [${sanitizeDisplayText(key)}] in .kit.toml (known: ${[...knownSections].join(", ")})`,
      );
    }
  }
  for (const key of Object.keys(browser ?? {})) {
    if (KNOWN_BROWSER_KEYS.has(key) || !firstWarning(path, `browser.${key}`)) continue;
    console.warn(
      `Warning: unknown key [browser].${sanitizeDisplayText(key)} in .kit.toml is ignored (known: ${[...KNOWN_BROWSER_KEYS].join(", ")})`,
    );
  }
}
