/**
 * Repository references that installers fetch: the shared reduction to `owner/repo`, and the
 * Claude Code plugin commands that add third-party code to the agent itself.
 */
import type { InstallProbe } from "./install-gate.js";

/**
 * Reduce every spelling of a repo argument to `owner/repo`, or null when the token is not one.
 *
 * The gate recognised ONE form and the tool documents two. `skills add --help` lists both
 * `vercel-labs/agent-skills` and `https://github.com/vercel-labs/agent-skills`, and measured
 * against 6.7.0 the short form was BLOCKED while every equivalent form went through:
 *
 *     npx skills add cursor/plugins                        → BLOCKED
 *     npx skills add https://github.com/cursor/plugins     → allowed
 *     npx skills add github.com/cursor/plugins             → allowed
 *     npx skills add git@github.com:cursor/plugins.git     → allowed
 *
 * So the bypass ran through the invocation the tool's own help recommends. The fix normalises
 * BEFORE matching rather than widening the pattern: a looser regex would start matching npm
 * scopes and file paths, and the defect was never that the pattern was too strict — it was that
 * one form was implemented and its equivalents were not.
 *
 * Deliberately kept out: `@scope/name` (an npm package, not a repo) and anything that does not
 * reduce to exactly two path segments after the host.
 */
export function ownerRepoArg(tok: string): string | null {
  if (!tok || tok.startsWith("-")) return null;
  if (tok.startsWith("@")) return null; // npm scope, not a repo
  // A filesystem path is not a repo reference. Without this, `./local/path/file.txt` reduced to
  // `./local` — caught by the table test, and exactly the kind of over-eager match that
  // widening the regex would have produced everywhere.
  if (/^[./~]/.test(tok)) return null;

  let t = tok.trim();
  // scp-style SSH: git@host:owner/repo(.git) — the colon separates host from path.
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(t);
  if (scp) {
    t = scp[2];
  } else {
    // Any scheme (https, http, ssh, git, git+ssh) plus optional user@host, then the path.
    t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[\w.-]+@/, "");
    // A leading host segment: something with a dot (github.com, gitlab.example.com) or
    // localhost, optionally with a port. Bare `owner/repo` has neither and is left alone.
    t = t.replace(/^(?:localhost|[\w-]+(?:\.[\w-]+)+)(?::\d+)?\//, "");
  }

  t = t
    .replace(/\.git$/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const parts = t.split("/").filter(Boolean);
  // Exactly two segments. A deeper URL (…/tree/main/sub) still names the repo it fetches, so
  // the first two win; a single segment is not a repo reference.
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  if (owner.startsWith("@")) return null;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  return /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(repo) ? `${owner}/${repo}` : null;
}

const PLUGIN_BINS = new Set(["plugin", "plugins"]);

/**
 * `claude plugin marketplace add <source>` and `claude plugin install <plugin> --marketplace
 * <source>` add a marketplace: a repo whose plugins run INSIDE the agent. A plugin's hooks module
 * can drop a prompt, submit text as the user and send billed model requests, more authority than
 * most npm packages, and `claude plugin install` passed this gate silently while `npx skills add`
 * did not. Adding the marketplace is the trust decision, so that is what is triaged:
 *
 *   - a GitHub repo (`owner/repo`, `https://github.com/owner/repo`, `git@github.com:…`) → `github:` ref;
 *   - a local path → the user's own code, nothing to triage;
 *   - anything else (another host, a URL to a marketplace.json) → unverifiable, fail-closed.
 *
 * `claude plugin install <plugin>@<marketplace>` names a marketplace added earlier, which was
 * triaged when it was added, so it is not an add. `/plugin install` typed inside Claude Code is a
 * slash command and never reaches a Bash hook; this covers the shell form only.
 */
export function claudePluginInstall(tokens: readonly string[], probe: InstallProbe): boolean {
  if (tokens[0] !== "claude" || !PLUGIN_BINS.has(tokens[1] ?? "")) return false;
  const rest = tokens.slice(2);
  let source: string | undefined;
  if (rest[0] === "marketplace" && rest[1] === "add") {
    source = rest.slice(2).find((t) => !t.startsWith("-"));
    if (source === undefined) {
      probe.isInstall = true;
      probe.unverifiable.push("claude-plugin-marketplace:<none>");
      return true;
    }
  } else if (rest[0] === "install" || rest[0] === "i") {
    source = marketplaceFlag(rest);
    if (source === undefined) return true; // a marketplace added (and triaged) earlier
  } else {
    return true; // list, remove, update, validate: nothing new is fetched from a new source
  }
  if (/^[./~]/.test(source)) return true; // the user's own marketplace on disk
  probe.isInstall = true;
  const repo = githubOnly(source);
  if (repo) probe.refs.push(`github:${repo}`);
  else probe.unverifiable.push(`claude-plugin-marketplace:${source}`);
  return true;
}

function marketplaceFlag(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const eq = /^--marketplace=(.+)$/.exec(args[i]);
    if (eq) return eq[1];
    if (args[i] === "--marketplace") return args[i + 1] ?? "";
  }
  return undefined;
}

/** `owner/repo` only when the source is on GitHub; another host must not become a github: ref. */
function githubOnly(source: string): string | null {
  const host = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[\w.-]+@)?([\w-]+(?:\.[\w-]+)+)[:/]/i.exec(source);
  if (host && host[1].toLowerCase().replace(/^www\./, "") !== "github.com") return null;
  if (/\.json$/i.test(source)) return null;
  return ownerRepoArg(source);
}
