/**
 * GitHub actions an agent's token reaches, which the person decides on.
 *
 * `gate-bash` refuses `git push origin main`, yet `gh pr merge --admin` lands the same change on
 * the default branch past the review, and passed with exit 0. So did changing a repository secret
 * or variable, running or switching off a workflow, and printing or replacing the token itself
 * (kit-research `agent-vm-yolo-herdr-paseo-vs-kit`). A scoped token allows all of them; that the
 * token allows an action does not make it the agent's decision. The gate names the action and asks
 * the agent to hand it to the person.
 *
 * Refused: every `gh pr merge` (plain, `--auto` and `--admin`: each lands or queues a change on the
 * base branch), `gh secret set|delete`, `gh variable set|delete`, `gh workflow run|enable|disable`,
 * `gh auth token|refresh|login|switch`, `gh auth status --show-token`, an alias that expands to one
 * of these, and the same writes through `gh api`: a non-GET request to a pull request's `/merge`,
 * `/merges`, its `ccr/auto_merge`, a `secrets` or `variables` path, a workflow's `dispatches|enable|disable` or a
 * repository `dispatches`, and the GraphQL merge mutations.
 *
 * Allowed: reads (`gh api` GETs, `gh pr view|list|checks`, `gh run view`, `gh secret list`) and
 * `gh pr create`, which is how an agent hands work over.
 *
 * Read without execution, through the carriers in `gate-bash-carriers`.
 */
import { readThroughCarriers } from "./gate-bash-carriers.js";
import { bin } from "./install-gate-hooks.js";
import { shellWords, shellWordValue } from "./install-gate-words.js";

/** What was caught: the class of action, and the command as the refusal names it. */
export interface GhTokenAction {
  kind: string;
  named: string;
}

const MERGE = "merges into the base branch";
const SECRET = "changes a secret";
const VARIABLE = "changes a configuration variable";
const WORKFLOW = "runs or switches a workflow";
const TOKEN = "reads or replaces the GitHub token";

const SUBCOMMANDS = new Map<string, Map<string, string>>([
  ["pr", new Map([["merge", MERGE]])],
  [
    "secret",
    new Map([
      ["set", SECRET],
      ["delete", SECRET],
      ["remove", SECRET],
    ]),
  ],
  [
    "variable",
    new Map([
      ["set", VARIABLE],
      ["delete", VARIABLE],
      ["remove", VARIABLE],
    ]),
  ],
  [
    "workflow",
    new Map([
      ["run", WORKFLOW],
      ["enable", WORKFLOW],
      ["disable", WORKFLOW],
    ]),
  ],
  [
    "auth",
    new Map([
      ["token", TOKEN],
      ["refresh", TOKEN],
      ["login", TOKEN],
      ["switch", TOKEN],
    ]),
  ],
]);

// Options that take a separate value, before or between `gh`'s command words.
const GH_VALUE_OPTIONS = new Set(["-R", "--repo", "--hostname"]);
// `gh api` options that take a separate value.
const API_VALUE_OPTIONS = new Set([
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
]);
const API_BODY = /^(-[fF]|--field|--raw-field|--input)(=|$)|^-[fF]./;

// REST paths that write a GitHub-layer setting when the method is not GET.
const API_WRITES: Array<[RegExp, string]> = [
  [/^repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/merge$/, MERGE],
  [/^repos\/[^/]+\/[^/]+\/merges$/, MERGE],
  [/^repos\/[^/]+\/[^/]+\/pulls\/[^/]+\/ccr\/auto_merge$/, MERGE],
  [/^(repos|orgs|user|organizations|repositories)\/.*\/secrets(\/|$)/, SECRET],
  [/^(repos|orgs|organizations|repositories)\/.*\/variables(\/|$)/, VARIABLE],
  [/^repos\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+\/(dispatches|enable|disable)$/, WORKFLOW],
  [/^repos\/[^/]+\/[^/]+\/dispatches$/, WORKFLOW],
];
const GRAPHQL_MERGE = /\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\b/;

const hit = (kind: string, named: string): GhTokenAction => ({ kind, named });

/** Command words, without options and the values of `GH_VALUE_OPTIONS`. */
function commandWords(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length && args[i] !== "--"; i++) {
    const a = args[i]!;
    if (GH_VALUE_OPTIONS.has(a)) i++;
    else if (!a.startsWith("-")) out.push(a);
  }
  return out;
}

/** The request method `gh api` would send: `-X`, else POST with a body, else GET. */
function apiMethod(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-X" || a === "--method") return (args[i + 1] ?? "").toUpperCase();
    const glued = /^(?:-X=?|--method=)(.+)$/.exec(a);
    if (glued) return glued[1]!.toUpperCase();
  }
  return args.some((a) => API_BODY.test(a)) ? "POST" : "GET";
}

/** The endpoint, without a scheme and host, a leading `/`, a query or a trailing `/`. */
function apiEndpoint(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (API_VALUE_OPTIONS.has(a)) i++;
    else if (!a.startsWith("-"))
      return a
        .replace(/^https?:\/\/[^/]+\//i, "")
        .replace(/[?#].*$/, "")
        .replace(/^\/+|\/+$/g, "");
  }
  return "";
}

function apiAction(args: string[]): GhTokenAction | null {
  const endpoint = apiEndpoint(args);
  if (endpoint === "graphql")
    return args.some((a) => GRAPHQL_MERGE.test(a)) ? hit(MERGE, "gh api graphql (merge)") : null;
  const method = apiMethod(args);
  if (method === "GET" || method === "HEAD") return null;
  const kind = API_WRITES.find(([path]) => path.test(endpoint))?.[1];
  return kind ? hit(kind, `gh api -X ${method} ${endpoint}`) : null;
}

/** `gh alias set <name> <expansion>`: the expansion runs as gh arguments, or as a shell command. */
function aliasAction(args: string[]): GhTokenAction | null {
  const [, , , expansion] = commandWords(args); // alias set <name> <expansion>
  if (!expansion) return null;
  if (args.includes("--shell") || args.includes("-s")) return ghTokenAction(expansion);
  return ghArgsAction(shellWords(expansion).map(shellWordValue));
}

/** The action in one `gh` argument list, or null. */
function ghArgsAction(args: string[]): GhTokenAction | null {
  const [group = "", sub = ""] = commandWords(args);
  if (group === "api") return apiAction(args.slice(args.indexOf("api") + 1));
  if (group === "alias" && sub === "set") return aliasAction(args);
  if (group === "auth" && sub === "status" && args.some((a) => a === "--show-token" || a === "-t"))
    return hit(TOKEN, "gh auth status --show-token");
  const kind = SUBCOMMANDS.get(group)?.get(sub);
  if (!kind) return null;
  const admin = group === "pr" && args.includes("--admin") ? " --admin" : "";
  return hit(kind, `gh ${group} ${sub}${admin}`);
}

/** The GitHub action in `command` that the person decides on, or null. Pure. */
export function ghTokenAction(command: string | readonly string[]): GhTokenAction | null {
  return readThroughCarriers(command, {
    isTarget: (word) => bin(word) === "gh",
    read: (_head, args) => ghArgsAction(args),
  });
}

/** The refusal: the action, its class, and who runs it. */
function ghTokenActionReason(found: GhTokenAction): string {
  return (
    `acts on GitHub with the session's token: ${found.kind} (${found.named}). Hand it to the ` +
    "person and ask them to run it themselves; that the token allows it does not make it the " +
    "agent's decision, as with a push to the default branch (fail-closed)"
  );
}

/** The gate's refusal for `decideBashGate`, read from the command with data-only here-documents removed. */
export function ghTokenRefusal(heredocs: { command: string; expansions: string[] }): string | null {
  const found = [heredocs.command, ...heredocs.expansions]
    .map((c) => ghTokenAction(c))
    .find(Boolean);
  return found ? ghTokenActionReason(found) : null;
}
