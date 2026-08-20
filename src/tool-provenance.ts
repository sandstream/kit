/**
 * Which installer actually owns the binary on PATH.
 *
 * `cli-lock.json` claimed provenance it never measured. Both writers — `fix.ts` and
 * `commands/setup.ts` — did this, identically:
 *
 *     tools[name] = { version, source: "mise" };   // version = the DECLARED string
 *
 * so a lock entry read `{ "vercel": { "version": "latest", "source": "mise" } }` while the
 * binary was `/opt/homebrew/bin/vercel` and `mise ls` did not mention it. `kit check` then said
 * `✓ cli-lock.json in sync`, because the only comparison it made was "does an entry exist for
 * this name" (#500). A lock file whose purpose is provenance was recording a guess.
 *
 * This module measures it instead, from the resolved path. Pure and injectable so every branch
 * is testable without the machine it was written on: the classifier takes the path plus the few
 * environment facts it needs (home dir, npm global prefix), never reading them itself.
 *
 * It answers WHERE FROM, not whether that is good. A tool coming from `system` is not a finding;
 * a lock that says `mise` for it is.
 */

import { posix, win32 } from "node:path";

/**
 * Installers kit can recognise. `kit-shim` is kit's own PATH shim (the install gate) and is a
 * WRAPPER, not an origin — see `shimmed` below.
 */
export type ToolSource =
  | "brew"
  | "mise"
  | "asdf"
  | "npm-global"
  | "pipx"
  | "cargo"
  | "go"
  | "kit-shim"
  | "system"
  | "unknown";

export interface ToolProvenance {
  /** The resolved executable path, as given. */
  path: string;
  source: ToolSource;
  /**
   * True when the path is a kit PATH shim: the real installer is whatever the shim delegates to,
   * which this classifier cannot see from the path alone. Reported rather than guessed.
   */
  shimmed: boolean;
  /** Short human note — why this classification, when it is not obvious from the path. */
  detail?: string;
}

export interface ClassifyEnv {
  /** The user's home directory. */
  home: string;
  /** `npm prefix -g`, when known: its `bin` is where `npm i -g` puts binaries. */
  npmPrefix?: string;
  /** Windows paths use backslashes; the caller says which separator applies. */
  platform?: "posix" | "win32";
}

/** Case-insensitive on win32, exact elsewhere — mirrors how the two filesystems behave. */
function contains(haystack: string, needle: string, win: boolean): boolean {
  return win ? haystack.toLowerCase().includes(needle.toLowerCase()) : haystack.includes(needle);
}

/**
 * Classify a resolved executable path to the installer that owns it.
 *
 * Ordering matters and is deliberate: the kit shim and the mise shims dir both sit under `$HOME`
 * and would both match a naive "in home dir" rule, and Homebrew's Cellar is reached through
 * `/opt/homebrew/bin` symlinks, so the bin dir has to count as brew too.
 */
export function classifyToolPath(path: string, env: ClassifyEnv): ToolProvenance {
  const win = env.platform === "win32";
  const p = win ? path : path;
  const sep = win ? win32.sep : posix.sep;
  const home = env.home.endsWith(sep) ? env.home.slice(0, -sep.length) : env.home;
  const under = (...parts: string[]): string => [home, ...parts].join(sep);

  // kit's own shim first: it is the PATH entry kit installs to gate installs, and it wraps
  // whatever the real installer is. Classifying it as "unknown" would hide that a shim exists.
  if (contains(p, under(".kit", "shims"), win) || contains(p, under(".kit-shims"), win)) {
    return {
      path,
      source: "kit-shim",
      shimmed: true,
      detail: "kit PATH shim — the real installer is whatever the shim delegates to",
    };
  }

  if (
    contains(p, under(".local", "share", "mise"), win) ||
    contains(p, under(".mise"), win) ||
    contains(p, `${sep}mise${sep}installs${sep}`, win) ||
    contains(p, `${sep}mise${sep}shims${sep}`, win)
  ) {
    return { path, source: "mise", shimmed: contains(p, `${sep}shims${sep}`, win) };
  }

  if (contains(p, under(".asdf"), win)) return { path, source: "asdf", shimmed: true };

  // Homebrew: /opt/homebrew (Apple Silicon), /usr/local/Cellar (Intel), linuxbrew.
  if (
    contains(p, `${sep}opt${sep}homebrew${sep}`, win) ||
    contains(p, `${sep}Cellar${sep}`, win) ||
    contains(p, `linuxbrew`, win)
  ) {
    return { path, source: "brew", shimmed: false };
  }

  if (env.npmPrefix && contains(p, env.npmPrefix, win)) {
    return { path, source: "npm-global", shimmed: false };
  }
  // Common npm -g layouts when the prefix was not resolvable.
  if (
    contains(p, under(".npm-global"), win) ||
    contains(p, under(".npm", "bin"), win) ||
    contains(p, `${sep}lib${sep}node_modules${sep}`, win)
  ) {
    return { path, source: "npm-global", shimmed: false, detail: "npm global layout" };
  }

  if (contains(p, under(".local", "pipx"), win)) return { path, source: "pipx", shimmed: false };
  if (contains(p, under(".cargo", "bin"), win)) return { path, source: "cargo", shimmed: false };
  if (contains(p, under("go", "bin"), win)) return { path, source: "go", shimmed: false };

  // ~/.local/bin is pipx's default target but also a general dumping ground, so it is reported
  // as pipx only with the hedge in `detail` — a wrong-but-confident source is what this module
  // exists to stop.
  if (contains(p, under(".local", "bin"), win)) {
    return {
      path,
      source: "pipx",
      shimmed: false,
      detail: "~/.local/bin — pipx's default target, but not exclusive to it",
    };
  }

  if (
    p.startsWith(`${sep}usr${sep}bin${sep}`) ||
    p.startsWith(`${sep}bin${sep}`) ||
    p.startsWith(`${sep}usr${sep}sbin${sep}`) ||
    p.startsWith(`${sep}sbin${sep}`) ||
    (win && contains(p, `${sep}Windows${sep}`, win))
  ) {
    return { path, source: "system", shimmed: false };
  }

  return { path, source: "unknown", shimmed: false };
}

/**
 * Does a lock entry's recorded source contradict the measured one?
 *
 * `kit-shim` never contradicts: the shim delegates, so the lock naming the underlying installer
 * is right. Everything else is compared exactly — that comparison is the whole point, since the
 * old lock said `mise` for a brew binary and nothing looked.
 */
export function provenanceMismatch(
  recorded: string | undefined,
  measured: ToolProvenance,
): { mismatch: boolean; reason?: string } {
  if (!recorded) return { mismatch: false };
  if (measured.source === "unknown" || measured.source === "kit-shim") return { mismatch: false };
  // The lock's vocabulary is narrower than the classifier's ("manual" is its catch-all).
  const normalised = recorded === "manual" ? "unknown" : recorded;
  if (normalised === measured.source) return { mismatch: false };
  return {
    mismatch: true,
    reason: `lock says ${recorded}, but ${measured.path} comes from ${measured.source}`,
  };
}
