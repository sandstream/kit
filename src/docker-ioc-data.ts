/**
 * Known-bad container images, for the `local docker image IOCs` row of `kit check`. Data only:
 * check-docker-ioc.ts compares these with `docker image ls --digests` and never fetches or runs
 * anything. Each entry cites where it comes from. Add an entry only from a published analysis,
 * and only with a value `docker image ls` can show: a repository name or a registry digest (an
 * image index or a manifest). Layer and file hashes are not listed, because `image ls` cannot
 * show them.
 */
export interface DockerIoc {
  /** `repository` matches the image name; `digest` matches the registry digest it was pulled by. */
  kind: "repository" | "digest";
  /** A lower-case Docker Hub name (`owner/name`), or `sha256:` and 64 hex characters. */
  value: string;
  /** What the value is, in a few words. */
  what: string;
  /** The incident the image belongs to. */
  incident: string;
  /** Where the value was published: a document and the revision that was read. */
  source: string;
}

const ARTEX = "ARTEX image with an unauthenticated root RCE backdoor (FBI FLASH 2026-11-13)";
const ARTEX_SOURCE =
  "darkfibr/artex-forensics evidence/iocs.csv at ec0389cf (2026-11-14); kit-research artex-forensics-vs-kit";

export const DOCKER_IOCS: readonly DockerIoc[] = [
  {
    kind: "repository",
    value: "tomicdd/artex",
    what: "backdoored image repository (8,817 pulls by 2026-11-04; now 404 on Docker Hub)",
    incident: ARTEX,
    source: ARTEX_SOURCE,
  },
  {
    kind: "digest",
    value: "sha256:ce85d8369ccc1a85423f1f75d2f3afaa2fab759e580da37a6891af2f7392745e",
    what: "image index digest of tomicdd/artex:latest",
    incident: ARTEX,
    source: ARTEX_SOURCE,
  },
  {
    kind: "digest",
    value: "sha256:cb85a7206290dc1813e3203e044741054b26c7a7c557c7d9d6d91af20aeb232b",
    what: "amd64 manifest digest of tomicdd/artex:latest",
    incident: ARTEX,
    source: ARTEX_SOURCE,
  },
];
