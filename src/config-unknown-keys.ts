// Keys of [browser] that kit reads; anything else is warned about, not rejected.
const KNOWN_BROWSER_KEYS = new Set(["app", "start", "build", "routes", "port", "cdp_url"]);

// loadConfig runs several times per command; warn once per file and key.
const warnedBrowserKeys = new Set<string>();

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
    if (!knownSections.has(key)) {
      console.warn(
        `Warning: unknown section [${key}] in .kit.toml (known: ${[...knownSections].join(", ")})`,
      );
    }
  }
  for (const key of Object.keys(browser ?? {})) {
    if (KNOWN_BROWSER_KEYS.has(key) || warnedBrowserKeys.has(`${path}\0${key}`)) continue;
    warnedBrowserKeys.add(`${path}\0${key}`);
    console.warn(
      `Warning: unknown key [browser].${key} in .kit.toml is ignored (known: ${[...KNOWN_BROWSER_KEYS].join(", ")})`,
    );
  }
}
