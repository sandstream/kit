import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw new Error(`${command} could not run: ${result.error.message}`);
  return result;
}

function git(args) {
  const result = run("git", args);
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function publishedHead(name, version) {
  const spec = `${name}@${version}`;
  const result = run("npm", ["view", spec, "gitHead", "--json"]);
  if (result.status !== 0) {
    if (/\bE404\b/.test(result.stderr)) return null;
    throw new Error(`registry lookup failed for ${spec}: ${result.stderr.trim()}`);
  }
  let head;
  try {
    head = JSON.parse(result.stdout);
  } catch {
    throw new Error(`registry returned invalid gitHead for ${spec}`);
  }
  if (typeof head !== "string" || !/^[0-9a-f]{40}$/i.test(head)) {
    throw new Error(`registry has no usable gitHead for ${spec}; cannot safely reuse its version`);
  }
  return head;
}

function verifyWorkspace(dir, currentHead) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const prior = publishedHead(pkg.name, pkg.version);
  if (prior === null) return;
  const knownCommit = run("git", ["cat-file", "-e", `${prior}^{commit}`]);
  if (knownCommit.status !== 0) {
    throw new Error(`${pkg.name}@${pkg.version} was published from ${prior}, which is absent from this checkout`);
  }
  const diff = run("git", ["diff", "--quiet", prior, currentHead, "--", dir]);
  if (diff.status === 1) {
    throw new Error(`${pkg.name}@${pkg.version} changed since publication at ${prior}; bump its version`);
  }
  if (diff.status !== 0) {
    throw new Error(`git diff failed for ${pkg.name}@${pkg.version}: ${diff.stderr.trim()}`);
  }
  console.log(`${pkg.name}@${pkg.version}: existing registry version matches its published source`);
}

try {
  const currentHead = git(["rev-parse", "HEAD"]);
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  const rootPrior = publishedHead(root.name, root.version);
  if (rootPrior !== null && rootPrior !== currentHead) {
    throw new Error(
      `${root.name}@${root.version} already belongs to different commit ${rootPrior}; bump its version`,
    );
  }
  if (rootPrior !== null) {
    console.log(`${root.name}@${root.version}: existing registry version matches tag commit`);
  }

  for (const entry of readdirSync("packages", { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    verifyWorkspace(join("packages", entry.name), currentHead);
  }
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
