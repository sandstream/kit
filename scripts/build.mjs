// The build, as one script instead of sixteen chained `npm run` calls.
//
//   node scripts/build.mjs                 full build (what `npm run build` runs)
//   node scripts/build.mjs --prod          full build without tests (tsconfig.prod.json)
//   node scripts/build.mjs --incremental   development build: recompile what changed
//
// Measured on 4 cores before this script (kit-research `fast-anything-vs-kit`, the owner's remark
// that the build is what is slow): 39 s per build, every time, of which 23 s was the root compile
// and the rest thirteen workspace compiles run one after another, each behind an `npm run`.
//
// What changes, and what does not:
//   - Order. `adapter-sdk` first, then `kit-plugin-supabase`: the root imports those two. The root
//     and the other plugins then compile at the same time. Nothing else imports across packages.
//   - `tsc` is started with this node directly (no `npm run`, no `.cmd` shim on Windows).
//   - A full build still starts from an empty `dist/` everywhere (`clean-dist.mjs`), so a deleted
//     source can leave no compiled test behind. That is why the wipe exists, and it stays.
//   - `--incremental` keeps `dist/`, uses tsc's incremental state, and removes compiled files
//     whose source is gone, which is the same guarantee reached without the wipe. Its state lives
//     in `node_modules/.cache/kit-build/` (never published). A full build deletes that state, so
//     the two modes cannot disagree about what is on disk. CI and release builds stay full.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");
const CACHE = join(ROOT, "node_modules", ".cache", "kit-build");
const FIRST = ["adapter-sdk", "kit-plugin-supabase"];

const args = process.argv.slice(2);
const prod = args.includes("--prod");
const incremental = args.includes("--incremental");
if (prod && incremental) {
  console.error("build: --prod is always a full build; drop --incremental");
  process.exit(2);
}

function runScript(name) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", name)], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** One tsc run; resolves with its exit code and output, so parallel runs do not interleave. */
function tsc(label, cwd, extra = []) {
  const flags = incremental
    ? ["--incremental", "--tsBuildInfoFile", join(CACHE, `${label}.tsbuildinfo`)]
    : [];
  return new Promise((done) => {
    const child = spawn(process.execPath, [TSC, ...extra, ...flags], { cwd });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => done({ label, code: 1, out: String(err) }));
    child.on("close", (code) => done({ label, code: code ?? 1, out }));
  });
}

async function all(jobs, limit) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

function report(results) {
  const failed = results.filter((r) => r.code !== 0);
  for (const r of failed) console.error(`\n[build] ${r.label} failed:\n${r.out.trimEnd()}`);
  if (failed.length > 0) process.exit(1);
}

/** Compiled files under `dist` whose `.ts` source no longer exists: removed, and counted. */
function pruneStale(distDir, srcDir) {
  if (!existsSync(distDir)) return 0;
  let removed = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const m = entry.name.match(/^(.*?)(\.d\.ts\.map|\.d\.ts|\.js\.map|\.js)$/);
      if (!m) continue;
      const source = join(srcDir, relative(distDir, dir), `${m[1]}.ts`);
      if (!existsSync(source)) {
        rmSync(full, { force: true });
        removed++;
      }
    }
  };
  walk(distDir);
  return removed;
}

const started = Date.now();
runScript("check-conflict-copies.mjs");

const packages = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ROOT, "packages", d.name, "tsconfig.json")))
  .map((d) => d.name)
  .sort();
const missing = FIRST.filter((name) => !packages.includes(name));
if (missing.length > 0) {
  console.error(`build: expected packages/${missing.join(", packages/")} (the root imports them)`);
  process.exit(1);
}

// Incremental state is only trusted next to the output it describes.
const usable = incremental && existsSync(join(ROOT, "dist", "cli.js")) && existsSync(CACHE);
if (usable) {
  let pruned = pruneStale(join(ROOT, "dist"), join(ROOT, "src"));
  for (const name of packages) {
    pruned += pruneStale(join(ROOT, "packages", name, "dist"), join(ROOT, "packages", name, "src"));
  }
  if (pruned > 0) console.log(`[build] removed ${pruned} compiled file(s) whose source is gone`);
} else {
  rmSync(CACHE, { recursive: true, force: true });
  runScript("clean-dist.mjs");
}
if (incremental) mkdirSync(CACHE, { recursive: true });

const pkg = (name) => () => tsc(name, join(ROOT, "packages", name));
for (const name of FIRST) report([await pkg(name)()]);

const rootJob = () => tsc("root", ROOT, prod ? ["-p", "tsconfig.prod.json"] : []);
const rest = packages.filter((name) => !FIRST.includes(name)).map(pkg);
report(await all([rootJob, ...rest], Math.max(2, availableParallelism())));

runScript("chmod-cli.mjs");
const mode = incremental ? (usable ? "incremental" : "incremental (first run: full)") : "full";
const where = ROOT.split(sep).pop();
console.log(`[build] ${where}: ${mode}, ${((Date.now() - started) / 1000).toFixed(1)} s`);
