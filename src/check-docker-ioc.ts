import type { SecurityCheckResult } from "./check-security.js";
import {
  scannerEvidence,
  scannerGap,
  scannerObject,
  type ScannerGap,
} from "./check-scanner-evidence.js";
import { DOCKER_IOCS, type DockerIoc } from "./docker-ioc-data.js";
import { execFileNoThrow, type ExecResult } from "./utils/execFileNoThrow.js";

/** Read-only comparison of known indicators with the selected Docker context. */
const DOCKER_IOC_NAME = "local docker image IOCs";
const LIST_ARGS = ["image", "ls", "--all", "--digests", "--no-trunc", "--format", "{{json .}}"];
const COUNT_ARGS = ["info", "--format", "{{json .Images}}"];
const MAX_BUFFER = 16 * 1024 * 1024;
const TIMEOUT = 15_000;
const NO_VALUE = "<none>";
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/i;
const REPOSITORY =
  /^(?:(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::[0-9]+)?\/)?[a-z0-9]+(?:[._/-]+[a-z0-9]+)*$/i;
const TAG = /^[\w][\w.-]{0,127}$/;
const DAEMON_ABSENT =
  /^Cannot connect to the Docker daemon at [^\r\n]+\. Is the docker daemon running\?\r?\n?$/i;
const UNIX_SOCKET_ABSENT =
  /^failed to connect to the docker API at unix:\/\/[^;\r\n]+; check if the path is correct and if the daemon is running: dial unix [^\r\n]+: connect: (?:no such file or directory|connection refused)\r?\n?$/i;

interface LocalImage {
  repository: string;
  tag: string;
  digest: string;
  id: string;
}

type DockerLister = (args: string[], timeout: number) => Promise<ExecResult>;

const defaultLister: DockerLister = (args, timeout) =>
  execFileNoThrow("docker", args, { timeout, maxBuffer: MAX_BUFFER });

const base = { category: "supply-chain", name: DOCKER_IOC_NAME } as const;

function isRegistryDigest(value: string): boolean {
  return IMAGE_ID.test(value) || /^sha384:[0-9a-f]{96}$|^sha512:[0-9a-f]{128}$/i.test(value);
}

function checkedLabel(value: unknown, pattern: RegExp): string {
  return typeof value === "string" &&
    value.length <= 255 &&
    (value === NO_VALUE || pattern.test(value))
    ? value
    : "";
}

function readImage(row: Record<string, unknown>): LocalImage {
  const repository = checkedLabel(row.Repository, REPOSITORY);
  const tag = checkedLabel(row.Tag, TAG);
  const rawDigest = row.Digest;
  const digest =
    typeof rawDigest === "string" && (rawDigest === NO_VALUE || isRegistryDigest(rawDigest))
      ? rawDigest
      : "";
  const id = typeof row.ID === "string" && IMAGE_ID.test(row.ID) ? row.ID : "";
  return { repository, tag, digest, id };
}

function hasIdentifier(row: LocalImage): boolean {
  return !!row.repository || !!row.digest;
}

function completeImage(row: LocalImage): boolean {
  return !!row.repository && !!row.tag && !!row.digest && !!row.id;
}

export function parseImageList(stdout: string): { images: LocalImage[]; malformed: number } {
  const images: LocalImage[] = [];
  if (stdout === "") return { images, malformed: 0 };
  const lines = stdout.split(/\r?\n/);
  let malformed = lines.at(-1) === "" ? 0 : 1;
  if (malformed === 0) lines.pop();
  for (const line of lines) {
    const row = scannerObject(line);
    const image = row ? readImage(row) : undefined;
    if (!image || !completeImage(image)) malformed++;
    if (image && hasIdentifier(image)) images.push(image);
  }
  return { images, malformed };
}

/** Normalize Docker Hub name aliases as the CLI formatter does. */
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

function imageLabel(image: LocalImage): string {
  const tag = image.tag && image.tag !== NO_VALUE ? `:${image.tag}` : "";
  return `${image.repository || "unknown repository"}${tag}`;
}

function failed(matches: IocMatch[]): SecurityCheckResult {
  const lines = matches.map(
    ({ image, ioc }) =>
      `${imageLabel(image)} matches ${ioc.kind} ${ioc.value} (${ioc.what}). ${ioc.incident}. Source ${ioc.source}`,
  );
  const ids = [...new Set(matches.map((match) => match.image.id).filter(Boolean))];
  return {
    ...base,
    status: "fail",
    severity: "critical",
    detail: `${matches.length} image row(s) match published indicators. ${lines.join(". ")}`,
    suggestion: ids.length
      ? `Remove the listed images with docker image rm ${ids.join(" ")}. Treat containers and hosts that ran them as compromised.`
      : "Confirm the affected image IDs before removal. Treat containers and hosts that ran them as compromised.",
  };
}

function optionalDockerScope(listing: ExecResult): SecurityCheckResult | undefined {
  const row = { ...base, status: "skip", evidenceStatus: "missing" } as const;
  if (listing.stdout || listing.timedOut || listing.truncated) return undefined;
  if (listing.didNotStart && listing.spawnErrorCode === "ENOENT")
    return { ...row, detail: "Docker CLI is not installed. Kit did not compare images." };
  if (
    !listing.ok &&
    listing.exitCode === 1 &&
    (DAEMON_ABSENT.test(listing.stderr) || UNIX_SOCKET_ABSENT.test(listing.stderr))
  )
    return { ...row, detail: "Docker daemon is not reachable. Kit did not compare images." };
  return undefined;
}

function listingGap(listing: ExecResult, images: LocalImage[], malformed: number) {
  const processGap = scannerGap({ count: images.length }, listing);
  if (processGap) return processGap;
  if (listing.stderr)
    return {
      status: "partial",
      reason: "Docker reported diagnostics during image listing",
    } as const;
  if (malformed)
    return {
      status: images.length ? "partial" : "malformed",
      reason: "Docker returned incomplete or invalid image rows",
    } as const;
  return undefined;
}

async function compareInventoryCount(
  list: DockerLister,
  images: LocalImage[],
  timeout: number,
): Promise<ScannerGap | undefined> {
  const unconfirmed = "Docker did not confirm the number of images in the selected context";
  if (timeout <= 0) return { status: "partial", reason: unconfirmed };
  const count = await list(COUNT_ARGS, timeout);
  const incomplete = scannerGap({ count: images.length }, count);
  if (incomplete) return { ...incomplete, reason: `${unconfirmed}. ${incomplete.reason}` };
  if (!count.stdout && !count.stderr)
    return { status: images.length ? "partial" : "missing", reason: unconfirmed };
  const daemonCount = Number(count.stdout);
  if (
    count.stderr ||
    !/^(?:0|[1-9]\d*)\r?\n$/.test(count.stdout) ||
    !Number.isSafeInteger(daemonCount)
  )
    return { status: images.length ? "partial" : "malformed", reason: unconfirmed };

  // A repository or tag alias can appear on several rows for the same image.
  // Reconcile unique image IDs with the independent daemon count.
  const listed = new Set(images.map((image) => image.id.toLowerCase())).size;
  if (listed !== daemonCount)
    return { status: "partial", reason: "Docker image rows do not match the daemon image count" };
  return undefined;
}

export async function checkDockerIocs(
  list: DockerLister = defaultLister,
): Promise<SecurityCheckResult> {
  const started = performance.now();
  const listing = await list(LIST_ARGS, TIMEOUT);
  const absent = optionalDockerScope(listing);
  if (absent) return absent;

  const { images, malformed } = parseImageList(listing.stdout);
  const matches = matchIocs(images);
  const gap =
    listingGap(listing, images, malformed) ??
    (await compareInventoryCount(
      list,
      images,
      Math.floor(TIMEOUT - (performance.now() - started)),
    ));
  const clean = {
    ...base,
    status: "pass" as const,
    detail: `${images.length} image row(s) in the selected Docker context compared with ${DOCKER_IOCS.length} published indicators. No exact match. This check does not scan image content.`,
  };
  return scannerEvidence(matches.length ? failed(matches) : clean, matches.length, gap);
}
