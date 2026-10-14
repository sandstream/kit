/**
 * What to ask an installer about, given how a tool was declared and where its binary lives.
 *
 * The binary name is the wrong question for two installers. mise knows `aqua:boyter/scc`, not
 * `scc`; brew knows the keg that owns `psql` (`postgresql@16`), and a tapped formula only by
 * its full name (`stripe/stripe-cli/stripe`). Asking with the binary name failed and was then
 * reported as a lookup that "did not answer".
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolSource } from "./tool-provenance.js";

export type LatestQuery = { name: string } | { unsupported: string };

/** The brew package owning `binPath`, tap-qualified when it is not from homebrew/core. */
export function brewPackageFor(binPath: string): string | null {
  let real: string;
  try {
    real = realpathSync(binPath);
  } catch {
    return null;
  }
  const match = /^(.*)[\\/]Cellar[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]/.exec(real);
  if (!match) return null;
  const [, prefix, name, version] = match;
  try {
    const receipt = JSON.parse(
      readFileSync(join(prefix, "Cellar", name, version, "INSTALL_RECEIPT.json"), "utf8"),
    ) as { source?: { tap?: unknown } };
    const tap = receipt.source?.tap;
    if (typeof tap === "string" && tap && tap !== "homebrew/core") return `${tap}/${name}`;
  } catch {
    // No readable receipt: the keg name alone is still the right question for core formulae.
  }
  return name;
}

export function latestQueryFor(
  declaration: string,
  source: ToolSource,
  binPath: string | null,
): LatestQuery {
  if (source === "mise" || source === "asdf") return { name: declaration };
  if (source === "brew") {
    const pkg = binPath ? brewPackageFor(binPath) : null;
    return pkg
      ? { name: pkg }
      : {
          unsupported: `the binary is not inside a Homebrew Cellar (${binPath ? dirname(binPath) : "no path"}); likely a cask, so kit cannot tell which brew package to ask about`,
        };
  }
  const withoutBackend = declaration.includes(":")
    ? declaration.slice(declaration.indexOf(":") + 1)
    : declaration;
  return { name: withoutBackend };
}
