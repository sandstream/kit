/**
 * What this kit can do that a UI (a Claude Code mod, a shell prompt) may not assume. A UI built
 * against a newer kit than the installed one would offer a command that is not there, so
 * `kit statusline --json` carries this list and the UI offers only what is in it. A kit that
 * predates the list has no `features` field, which a UI reads as "none of these".
 *
 * Add a name here in the same change that adds the capability, never ahead of it.
 */
export const KIT_FEATURES: readonly string[] = [
  /** Images named in `[scan].images` are scanned by `kit scan`. */
  "image-scan",
  /** `kit upstream check`: latest versions of services and runtimes. */
  "upstream",
];
