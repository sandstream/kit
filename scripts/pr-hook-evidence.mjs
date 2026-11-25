import { execFileSync } from "node:child_process";

const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).trim();
}

function hasHookMarker(commit) {
  const [tree, ...markers] = git(
    "show",
    "-s",
    "--format=%T%n%(trailers:key=Kit-Hook-Tree,valueonly)",
    commit,
    "--",
  ).split("\n");
  return markers.length === 1 && markers[0] === tree;
}

function report(base, head) {
  if (!objectId.test(base) || !objectId.test(head)) throw new Error("Invalid PR endpoints");
  if (git("rev-parse", "--is-shallow-repository") !== "false")
    throw new Error("Incomplete commit history");
  const commits = git("rev-list", `${base}..${head}`, "--").split("\n").filter(Boolean);
  if (commits.some((commit) => !objectId.test(commit))) throw new Error("Invalid commit list");
  const missing = commits.filter((commit) => !hasHookMarker(commit));
  if (!missing.length) {
    console.log(`Local hook markers present for ${commits.length} PR commit(s).`);
    return;
  }
  console.log(
    `::warning title=Missing local Kit hook markers::${missing.length} of ${commits.length} PR commit(s) lack a matching hook marker.`,
  );
  for (const commit of missing) console.log(commit);
}

try {
  report(process.argv[2], process.argv[3]);
} catch {
  console.log(
    "::warning title=Local Kit hook markers unverified::Could not inspect the complete PR commit range.",
  );
}
