/**
 * `kit check` host result: is an image on this machine one that a published analysis names as
 * malicious? Reads `docker image ls --digests` (read-only: it lists, it does not pull, inspect a
 * registry or run anything) and compares each repository name and registry digest with
 * DOCKER_IOCS. A match is exact by construction, so this catches only the images the list names;
 * it is not a scanner. No docker CLI, or no daemon, is a plain skip.
 */
import { execFile } from "node:child_process";
import type { SecurityCheckResult } from "./check-security.js";
import { DOCKER_IOCS, type DockerIoc } from "./docker-ioc-data.js";

export const DOCKER_IOC_NAME = "local docker image IOCs";
const LIST_ARGS = ["image", "ls", "--digests", "--no-trunc", "--format", "{{json .}}"];

/** One local image row, as `docker image ls --format '{{json .}}'` prints it. */
export interface LocalImage {
  repository: string;
  tag: string;
  digest: string;
  id: string;
}

/** Runs `docker` with the given arguments and resolves its stdout; injected in tests. */
export type DockerLister = (args: string[]) => Promise<string>;

const defaultLister: DockerLister = (args) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      "docker",
      args,
      { timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolvePromise(stdout)),
    );
  });

const result = (r: Omit<SecurityCheckResult, "category" | "name">): SecurityCheckResult => ({
  category: "supply-chain",
  name: DOCKER_IOC_NAME,
  ...r,
});

/** Parse `{{json .}}` lines; a line that is not an object with a Repository is ignored. */
export function parseImageList(stdout: string): LocalImage[] {
  const images: LocalImage[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!row || typeof row.Repository !== "string") continue;
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    images.push({
      repository: row.Repository,
      tag: text(row.Tag),
      digest: text(row.Digest),
      id: text(row.ID),
    });
  }
  return images;
}

/** `docker.io/tomicdd/artex` and `index.docker.io/…` are the Hub name `tomicdd/artex`. */
function hubName(repository: string): string {
  return repository
    .toLowerCase()
    .replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "");
}

interface IocMatch {
  image: LocalImage;
  ioc: DockerIoc;
}

export function matchIocs(
  images: LocalImage[],
  iocs: readonly DockerIoc[] = DOCKER_IOCS,
): IocMatch[] {
  const matches: IocMatch[] = [];
  for (const image of images) {
    const name = hubName(image.repository);
    const digest = image.digest.toLowerCase();
    for (const ioc of iocs) {
      if (ioc.kind === "repository" ? name === ioc.value : digest === ioc.value)
        matches.push({ image, ioc });
    }
  }
  return matches;
}

const shown = (i: LocalImage) =>
  `${i.repository}${i.tag && i.tag !== "<none>" ? `:${i.tag}` : ""}`.replace(/[^\x20-\x7e]/g, "?");

function failed(matches: IocMatch[]): SecurityCheckResult {
  const lines = matches.map(
    ({ image, ioc }) =>
      `${shown(image)} matches ${ioc.kind} ${ioc.value} (${ioc.what}; ${ioc.incident}; source: ${ioc.source})`,
  );
  const ids = [...new Set(matches.map((m) => m.image.id).filter(Boolean))];
  return result({
    status: "fail",
    severity: "critical",
    detail: `${matches.length} local image row(s) match a published IOC: ${lines.join("; ")}`,
    suggestion: `do not run it; remove it (docker image rm ${ids.join(" ") || "<image>"}) and treat every container started from it, and the machine it ran on, as compromised`,
  });
}

/** Why `docker image ls` did not answer, as one plain line. */
function skipReason(err: unknown): string {
  const e = err as { code?: unknown; stderr?: unknown };
  if (e?.code === "ENOENT") return "docker CLI not installed; no local images to compare";
  return "docker did not list images (daemon not running or not reachable); local images not compared";
}

export async function checkDockerIocs(
  list: DockerLister = defaultLister,
): Promise<SecurityCheckResult> {
  let stdout: string;
  try {
    stdout = await list(LIST_ARGS);
  } catch (err) {
    return result({ status: "skip", detail: skipReason(err) });
  }
  const images = parseImageList(stdout);
  const matches = matchIocs(images);
  if (matches.length) return failed(matches);
  return result({
    status: "pass",
    detail: `${images.length} local image row(s) compared with ${DOCKER_IOCS.length} published image IOC(s) by name and registry digest; none match. Exact matches only: this is not a malware scan.`,
  });
}
