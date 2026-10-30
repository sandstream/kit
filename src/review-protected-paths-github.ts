/** Read protection rules from the PR's pinned base and head commits. */
import {
  classifyProtectedPaths,
  DEFAULT_PROTECTED_PATH_RULES,
  parseProtectedPathRules,
  unionProtectedPathRules,
} from "./review-protected-paths.js";
import type { ReadCommand } from "./review-receipt-io.js";

const SHA = /^[a-f0-9]{40}$/;
const RULE_PATH = ".github/kit-protected-paths.json";
const REFS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){defaultBranchRef{name target{oid}} pullRequest(number:$number){number headRefOid baseRefName baseRef{target{oid}}}}}`;
const QUERY = `query($owner:String!,$name:String!,$base:String!,$head:String!,$defaultHead:String!,$baseFile:String!,$headFile:String!,$defaultFile:String!){repository(owner:$owner,name:$name){baseCommit:object(expression:$base){... on Commit{oid}} headCommit:object(expression:$head){... on Commit{oid}} defaultCommit:object(expression:$defaultHead){... on Commit{oid}} baseFile:object(expression:$baseFile){__typename ... on Blob{text isTruncated}} headFile:object(expression:$headFile){__typename ... on Blob{text isTruncated}} defaultFile:object(expression:$defaultFile){__typename ... on Blob{text isTruncated}}}}`;

type RecordValue = Record<string, unknown>;
function object(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`invalid ${label}`);
  return value as RecordValue;
}

interface PrRefs {
  number: number;
  head: string;
  base: string;
  baseName: string;
  defaultName: string;
  defaultHead: string;
}

export function readPrRefs(root: string, repo: string, number: number, run: ReadCommand): PrRefs {
  const [owner, name] = repo.split("/");
  const response = object(
    JSON.parse(
      run(
        "gh",
        [
          "api",
          "graphql",
          "-F",
          `owner=${owner}`,
          "-F",
          `name=${name}`,
          "-F",
          `number=${number}`,
          "-f",
          `query=${REFS_QUERY}`,
        ],
        root,
      ),
    ),
    "GitHub response",
  );
  if (response.errors !== undefined) throw new Error("PR refs unavailable");
  const repoData = object(object(response.data, "GitHub data").repository, "GitHub repository");
  const data = object(repoData.pullRequest, "PR refs");
  const defaultRef = object(repoData.defaultBranchRef, "default branch");
  const defaultHead = object(defaultRef.target, "default branch target").oid;
  const base = object(object(data.baseRef, "PR base ref").target, "PR base target").oid;
  if (
    !Number.isSafeInteger(data.number) ||
    (data.number as number) < 1 ||
    typeof data.headRefOid !== "string" ||
    !SHA.test(data.headRefOid) ||
    typeof base !== "string" ||
    !SHA.test(base) ||
    data.number !== number ||
    typeof data.baseRefName !== "string" ||
    !data.baseRefName.trim() ||
    typeof defaultRef.name !== "string" ||
    !defaultRef.name.trim() ||
    typeof defaultHead !== "string" ||
    !SHA.test(defaultHead)
  ) {
    throw new Error("invalid or unavailable PR base and head");
  }
  return {
    number: data.number as number,
    head: data.headRefOid,
    base,
    baseName: data.baseRefName,
    defaultName: defaultRef.name,
    defaultHead,
  };
}

export function assertPrRefsUnchanged(
  expected: PrRefs,
  root: string,
  repo: string,
  run: ReadCommand,
): void {
  const current = readPrRefs(root, repo, expected.number, run);
  if (
    current.number !== expected.number ||
    current.head !== expected.head ||
    current.base !== expected.base ||
    current.baseName !== expected.baseName ||
    current.defaultName !== expected.defaultName ||
    current.defaultHead !== expected.defaultHead
  ) {
    throw new Error("PR base or head changed while collecting protection rules");
  }
}

function blob(value: unknown, label: string, required: boolean): string | null {
  if (value === null && !required) return null;
  const data = object(value, label);
  if (data.__typename !== "Blob" || data.isTruncated !== false || typeof data.text !== "string") {
    throw new Error(`invalid or incomplete ${label}`);
  }
  return data.text;
}

/** Include the old name of a renamed file in the protection decision. */
function protectionPaths(
  root: string,
  repo: string,
  number: number,
  paths: string[],
  run: ReadCommand,
): string[] {
  const endpoint = `repos/${repo}/pulls/${number}/files?per_page=100`;
  const pages: unknown = JSON.parse(run("gh", ["api", "--paginate", "--slurp", endpoint], root));
  if (!Array.isArray(pages) || !pages.length || !pages.every(Array.isArray))
    throw new Error("invalid PR file pages");
  const files = pages.flat() as unknown[];
  if (files.length !== paths.length || new Set(paths).size !== paths.length)
    throw new Error("incomplete PR file list");
  const remaining = new Set(paths);
  const all = [...paths];
  for (const entry of files) {
    const file = object(entry, "PR file");
    if (
      typeof file.filename !== "string" ||
      !remaining.delete(file.filename) ||
      typeof file.status !== "string"
    ) {
      throw new Error("invalid PR file identity");
    }
    if (file.status === "renamed") {
      if (typeof file.previous_filename !== "string" || !file.previous_filename)
        throw new Error("missing renamed file origin");
      if (!all.includes(file.previous_filename)) all.push(file.previous_filename);
    }
  }
  if (remaining.size) throw new Error("incomplete PR file list");
  return all;
}

export function collectPrProtectedPaths(
  root: string,
  identity: { repo: string; number: number; head: string },
  paths: string[],
  run: ReadCommand,
): { refs: PrRefs; protectedPaths: ReturnType<typeof classifyProtectedPaths> } {
  const { repo, number, head } = identity;
  const parts = repo.split("/");
  if (
    parts.length !== 2 ||
    !parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..")
  ) {
    throw new Error("invalid repository identity");
  }
  const refs = readPrRefs(root, repo, number, run);
  if (refs.number !== number || refs.head !== head)
    throw new Error("PR identity changed before collecting protection rules");
  const response = object(
    JSON.parse(
      run(
        "gh",
        [
          "api",
          "graphql",
          "-F",
          `owner=${parts[0]}`,
          "-F",
          `name=${parts[1]}`,
          "-F",
          `base=${refs.base}`,
          "-F",
          `head=${refs.head}`,
          "-F",
          `defaultHead=${refs.defaultHead}`,
          "-F",
          `baseFile=${refs.base}:${RULE_PATH}`,
          "-F",
          `headFile=${refs.head}:${RULE_PATH}`,
          "-F",
          `defaultFile=${refs.defaultHead}:${RULE_PATH}`,
          "-f",
          `query=${QUERY}`,
        ],
        root,
      ),
    ),
    "GitHub response",
  );
  if (response.errors !== undefined) throw new Error("GitHub protection rules unavailable");
  const data = object(response.data, "GitHub data");
  const repository = object(data.repository, "GitHub repository");
  if (
    object(repository.baseCommit, "base commit").oid !== refs.base ||
    object(repository.headCommit, "head commit").oid !== refs.head ||
    object(repository.defaultCommit, "default branch commit").oid !== refs.defaultHead
  )
    throw new Error("invalid protection rule commits");
  const base = blob(repository.baseFile, "base protection rules", false);
  const proposed = blob(repository.headFile, "head protection rules", false);
  const defaults = blob(repository.defaultFile, "default branch protection rules", false);
  const baseRules = unionProtectedPathRules(
    defaults === null ? DEFAULT_PROTECTED_PATH_RULES : parseProtectedPathRules(defaults),
    base === null ? DEFAULT_PROTECTED_PATH_RULES : parseProtectedPathRules(base),
  );
  const rules = unionProtectedPathRules(
    baseRules,
    proposed === null ? null : parseProtectedPathRules(proposed),
  );
  const allPaths = protectionPaths(root, repo, number, paths, run);
  assertPrRefsUnchanged(refs, root, repo, run);
  return { refs, protectedPaths: classifyProtectedPaths(allPaths, rules) };
}
