/**
 * CI pipeline-snippet generation for non-GitHub hosts (#145).
 *
 * `kit ci` is host-agnostic ("run → exit code + JUnit report"), so the only
 * host-specific piece is the pipeline file that invokes it. This emits a ready
 * `.gitlab-ci.yml` job and `bitbucket-pipelines.yml` step that run `kit ci`.
 *
 * The snippets are written to pass kit's OWN ci-audit: container images use a
 * concrete version tag (never `:latest`/untagged), no remote `include:`, and no
 * pipe-to-shell. Pure (host → {file, content}); the CLI handles stdout/--write.
 *
 * GitHub is intentionally not generated here — kit ships its own SHA-pinned
 * Actions and the gha-audit would (correctly) flag a hand-written unpinned one;
 * see docs/CI_AND_GIT_HOSTS.md for the GitHub path.
 */
export type CiHost = "gitlab" | "bitbucket";

export const CI_HOSTS: readonly CiHost[] = ["gitlab", "bitbucket"];

export function isCiHost(value: string): value is CiHost {
  return (CI_HOSTS as readonly string[]).includes(value);
}

export interface PipelineSnippet {
  /** Conventional pipeline file for the host. */
  file: string;
  /** The snippet to place in that file. */
  content: string;
}

/** Node image pinned to a concrete major tag (ci-audit-clean: not :latest/untagged). */
const NODE_IMAGE = "node:22";

const GITLAB = `# kit security gate — runs \`kit ci\` and publishes a JUnit report.
# Make this a required check on protected branches:
#   Settings → Merge requests → "Pipelines must succeed".
kit-ci:
  image: ${NODE_IMAGE}
  script:
    - npx --yes sandstream-kit ci --format gitlab
  artifacts:
    when: always
    reports:
      junit: kit-report.xml
`;

const BITBUCKET = `# kit security gate — runs \`kit ci\`.
# Add a required merge check in repo settings:
#   Repository settings → Merge checks → "Minimum successful builds".
image: ${NODE_IMAGE}
pipelines:
  default:
    - step:
        name: kit ci
        script:
          - npx --yes sandstream-kit ci
`;

export function pipelineSnippet(host: CiHost): PipelineSnippet {
  switch (host) {
    case "gitlab":
      return { file: ".gitlab-ci.yml", content: GITLAB };
    case "bitbucket":
      return { file: "bitbucket-pipelines.yml", content: BITBUCKET };
  }
}
