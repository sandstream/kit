/**
 * `kit rig plant --from-fix <sha> --split tune|holdout` — turn a historical fix into a planted
 * defect (see src/rig/plant.ts). It writes the planted patch next to the manifest and prints the
 * `[[defect]]` block to append; it never edits rig.toml itself, so the corpus owner reviews
 * every defect before it counts.
 *
 * The pinned commit comes from `--pinned <sha>` or rig.toml's `[input] commit`. A corpus being
 * built may not have a single defect yet, so only that one field is read here; `kit rig plan`
 * validates the whole manifest later.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { c } from "../utils/colors.js";
import { flagValue, GLOBAL_FLAGS, hasFlag, rejectUnknownFlags } from "../utils/flags.js";
import { defectToml, plantFromFix, PlantRefused } from "../rig/plant.js";

export const PLANT_FLAGS = [
  "--from-fix",
  "--split",
  "--id",
  "--kind",
  "--repo",
  "--path",
  "--pinned",
  "--manifest",
  "--json",
  ...GLOBAL_FLAGS,
];

function fail(msg: string): false {
  console.error(`${c.red}kit rig plant: ${msg}${c.reset}`);
  return false;
}

/** `[input] commit` from a manifest, or null when absent or unreadable. */
function pinnedFromManifest(path: string): string | null {
  try {
    const doc = parseToml(readFileSync(path, "utf8")) as { input?: { commit?: unknown } };
    return typeof doc.input?.commit === "string" ? doc.input.commit : null;
  } catch {
    return null;
  }
}

interface PlantArgs {
  fix: string;
  split: "tune" | "holdout";
  manifest: string;
  pinned: string;
  id: string;
}

/** Read and check the flags. Returns the arguments, or the problem to report. */
function readArgs(argv: readonly string[]): PlantArgs | string {
  const fix = flagValue(argv, "--from-fix");
  const split = flagValue(argv, "--split");
  if (!fix) return "--from-fix <sha> is required";
  if (split !== "tune" && split !== "holdout") return '--split must be "tune" or "holdout"';
  const manifest = resolve(flagValue(argv, "--manifest") ?? "rig.toml");
  const pinned = flagValue(argv, "--pinned") ?? pinnedFromManifest(manifest);
  if (!pinned) return `no pinned commit: pass --pinned <sha> or set [input] commit in ${manifest}`;
  const id = flagValue(argv, "--id") ?? `fix-${fix.slice(0, 12)}`;
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return "--id may use letters, digits, '.', '_' and '-' only";
  return { fix, split, manifest, pinned, id };
}

export async function cmdRigPlant(): Promise<boolean> {
  if (rejectUnknownFlags("kit rig plant", PLANT_FLAGS)) return false;
  const args = readArgs(process.argv);
  if (typeof args === "string") return fail(args);
  const patchPath = `defects/${args.id}.diff`;
  const out = join(dirname(args.manifest), "defects", `${args.id}.diff`);
  let planted;
  try {
    planted = plantFromFix(
      resolve(flagValue(process.argv, "--repo") ?? "."),
      args.pinned,
      args.fix,
      flagValue(process.argv, "--path"),
    );
  } catch (err) {
    if (err instanceof PlantRefused) return fail(err.message);
    return fail("git failed; is --repo a git repository that contains both commits?");
  }
  mkdirSync(dirname(out), { recursive: true });
  try {
    // "wx" creates the file or fails if it exists: one atomic step, no check-then-write race.
    writeFileSync(out, planted.patch, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return fail(`${patchPath} already exists; choose another --id`);
    }
    return fail(`${patchPath} could not be written`);
  }
  const block = defectToml(planted, {
    id: args.id,
    split: args.split,
    patchPath,
    kind: flagValue(process.argv, "--kind"),
  });
  if (hasFlag(process.argv, "--json")) {
    const { patch: _patch, ...where } = planted;
    const body = { id: args.id, split: args.split, patch: patchPath, ...where, toml: block };
    console.log(JSON.stringify(body, null, 2));
  } else {
    console.log(`wrote ${patchPath}; append this to the manifest:\n`);
    console.log(block);
  }
  return true;
}
