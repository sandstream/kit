import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTemp } from "./temp-cleanup.test-support.js";

/** Neutral fixture identities; no real address appears in a test. */
export const GIT_EMAIL = "alice@example.com";
export const GIT_NAME = "Alice Fixture";
export const ACCOUNT_EMAIL = "carol@example.org";

export interface IdentityFixture {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** Write one transcript, a line per entry, under `~/.claude/projects/<slug>/`. */
  transcript(name: string, entries: unknown[], slug?: string): string;
}

/** One assistant message with a single `tool_use` block. */
export function toolUse(name: string, input: unknown): unknown {
  return { type: "assistant", message: { content: [{ type: "tool_use", name, input }] } };
}

/** A git project with the fixture identities, an isolated HOME and a Claude Code account. */
export function identityFixture(t: { after(fn: () => void): void }): IdentityFixture {
  const base = mkdtempSync(join(tmpdir(), "kit-transcript-id-"));
  t.after(() => rmTemp(base));
  const root = join(base, "project");
  const home = join(base, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("GIT_") || k === "CLAUDE_CONFIG_DIR") delete env[k];
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  });
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, env, stdio: "ignore" });
  };
  git("init", "-q");
  git("config", "user.email", GIT_EMAIL);
  git("config", "user.name", GIT_NAME);
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: ACCOUNT_EMAIL } }),
  );
  const transcript = (name: string, entries: unknown[], slug = "-project"): string => {
    const dir = join(home, ".claude", "projects", slug);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return file;
  };
  return { root, home, env, transcript };
}
