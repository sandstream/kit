// `kit config` commands — config-file inspection + schema migration.
//
// Migration is a one-way door done safely: --dry-run (the inspection default for
// a stale config) writes nothing; a real run backs the original up to
// .kit.toml.backup (refusing to clobber an existing backup without --force),
// writes the migrated file, then RE-PARSES + VALIDATES it under the Zod schema
// and restores the original if validation fails. A corrupt config is never left
// on disk.
import { readFile, writeFile, access } from "node:fs/promises";
import { parse, stringify } from "smol-toml";
import { CONFIG_SCHEMA_VERSION, kitConfigSchema } from "../config.js";
import {
  detectConfigVersion,
  migrateConfig,
  diffConfigs,
  type ConfigDiffEntry,
  type RawConfig,
} from "../config-migrate.js";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { resolveConfigPath, KIT_FILE } from "../cli-shared.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export type MigrateStatus =
  | "already-current" // config is at CONFIG_SCHEMA_VERSION
  | "dry-run" // a migration is needed; nothing written (--dry-run)
  | "stale" // --check: config is behind, no write (CI gate)
  | "migrated" // a migration ran and was written + re-validated
  | "error"; // could not migrate (parse failure, backup clash, validation failure)

export interface MigrateFileOptions {
  dryRun?: boolean;
  check?: boolean;
  force?: boolean;
}

export interface MigrateStep {
  from: number;
  to: number;
  describe: string;
}

export interface MigrateFileOutcome {
  status: MigrateStatus;
  /** Process should exit 0 when true. */
  ok: boolean;
  fromVersion: number;
  toVersion: number;
  steps: MigrateStep[];
  diff: ConfigDiffEntry[];
  backupPath?: string;
  wrote: boolean;
  message: string;
}

/**
 * Migrate a .kit.toml file at `configPath`. Pure of argv/cwd so it is directly
 * testable with temp files. Honors dry-run / check / force. Never leaves a
 * corrupt config: on a failed post-write validation the original is restored.
 */
export async function migrateConfigFile(
  configPath: string,
  opts: MigrateFileOptions = {},
): Promise<MigrateFileOutcome> {
  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch (err) {
    return {
      status: "error",
      ok: false,
      fromVersion: 0,
      toVersion: CONFIG_SCHEMA_VERSION,
      steps: [],
      diff: [],
      wrote: false,
      message: `Could not read ${configPath}: ${(err as Error).message}`,
    };
  }

  let raw: RawConfig;
  try {
    raw = parse(content) as RawConfig;
  } catch (err) {
    return {
      status: "error",
      ok: false,
      fromVersion: 0,
      toVersion: CONFIG_SCHEMA_VERSION,
      steps: [],
      diff: [],
      wrote: false,
      message: `Could not parse ${configPath} as TOML: ${(err as Error).message}`,
    };
  }

  const fromVersion = detectConfigVersion(raw);

  // Already current — nothing to do (exit 0).
  if (fromVersion === CONFIG_SCHEMA_VERSION) {
    return {
      status: "already-current",
      ok: true,
      fromVersion,
      toVersion: CONFIG_SCHEMA_VERSION,
      steps: [],
      diff: [],
      wrote: false,
      message: `Already at v${CONFIG_SCHEMA_VERSION}, nothing to do.`,
    };
  }

  let result;
  try {
    result = migrateConfig(raw);
  } catch (err) {
    // e.g. a config NEWER than this kit (downgrade), or a gap in the registry.
    return {
      status: "error",
      ok: false,
      fromVersion,
      toVersion: CONFIG_SCHEMA_VERSION,
      steps: [],
      diff: [],
      wrote: false,
      message: (err as Error).message,
    };
  }

  const steps: MigrateStep[] = result.steps.map((s) => ({
    from: s.from,
    to: s.to,
    describe: s.describe,
  }));
  const diff = diffConfigs(raw, result.migrated);

  // --check: CI gate. A behind-version config is a non-zero exit, no write.
  if (opts.check) {
    return {
      status: "stale",
      ok: false,
      fromVersion,
      toVersion: CONFIG_SCHEMA_VERSION,
      steps,
      diff,
      wrote: false,
      message: `Config is at v${fromVersion}; current is v${CONFIG_SCHEMA_VERSION}. Run \`kit config migrate\`.`,
    };
  }

  // --dry-run: report the plan + diff, write nothing.
  if (opts.dryRun) {
    return {
      status: "dry-run",
      ok: true,
      fromVersion,
      toVersion: CONFIG_SCHEMA_VERSION,
      steps,
      diff,
      wrote: false,
      message: `Would migrate v${fromVersion} -> v${CONFIG_SCHEMA_VERSION} (${steps.length} step(s)). Nothing written (--dry-run).`,
    };
  }

  // Real run. Back up + write + re-validate, with restore-on-failure.
  const base = {
    fromVersion,
    toVersion: CONFIG_SCHEMA_VERSION,
    steps,
    diff,
    backupPath: `${configPath}.backup`,
  };
  return performMigration(configPath, content, result.migrated, base, opts.force === true);
}

/**
 * Re-parse + validate written config under the Zod schema. Returns an error
 * string on any problem, else null.
 */
function validateWritten(reparsed: RawConfig): string | null {
  const parsed = kitConfigSchema.safeParse(reparsed);
  if (!parsed.success) {
    return parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }
  if (detectConfigVersion(reparsed) !== CONFIG_SCHEMA_VERSION) {
    return `written config did not land at v${CONFIG_SCHEMA_VERSION}`;
  }
  return null;
}

type MigrationBase = Pick<
  MigrateFileOutcome,
  "fromVersion" | "toVersion" | "steps" | "diff" | "backupPath"
>;

/**
 * The real-run write path: back up the original (refusing to clobber an existing
 * backup without force), write the migrated TOML, re-parse + validate, and
 * restore the original if validation fails. Never leaves a corrupt config.
 */
async function performMigration(
  configPath: string,
  original: string,
  migrated: RawConfig,
  base: MigrationBase,
  force: boolean,
): Promise<MigrateFileOutcome> {
  const err = (message: string): MigrateFileOutcome => ({
    ...base,
    status: "error",
    ok: false,
    wrote: false,
    message,
  });

  const backupPath = base.backupPath as string;
  if ((await fileExists(backupPath)) && !force) {
    return err(`Backup ${backupPath} already exists. Re-run with --force to overwrite it.`);
  }

  let migratedToml: string;
  try {
    migratedToml = stringify(migrated);
  } catch (e) {
    return err(`Could not serialize migrated config: ${(e as Error).message}`);
  }

  await writeFile(backupPath, original, "utf-8");
  await writeFile(configPath, migratedToml, "utf-8");

  let validationError: string | null;
  try {
    validationError = validateWritten(parse(await readFile(configPath, "utf-8")) as RawConfig);
  } catch (e) {
    validationError = `re-parse failed: ${(e as Error).message}`;
  }

  if (validationError) {
    await writeFile(configPath, original, "utf-8"); // restore — never leave a corrupt config
    return err(`Migrated config failed validation and was rolled back: ${validationError}`);
  }

  return {
    ...base,
    status: "migrated",
    ok: true,
    wrote: true,
    message: `Migrated v${base.fromVersion} -> v${CONFIG_SCHEMA_VERSION}. Original saved to ${backupPath}.`,
  };
}

function printDiff(diff: ConfigDiffEntry[]): void {
  if (diff.length === 0) {
    console.log(`  ${c.dim}(no value-level changes)${c.reset}`);
    return;
  }
  for (const entry of diff) {
    if (entry.before === undefined) {
      console.log(`  ${c.green}+ ${entry.path} = ${entry.after}${c.reset}`);
    } else if (entry.after === undefined) {
      console.log(`  ${c.red}- ${entry.path} = ${entry.before}${c.reset}`);
    } else {
      console.log(`  ${c.yellow}~ ${entry.path}: ${entry.before} -> ${entry.after}${c.reset}`);
    }
  }
}

async function cmdConfigMigrate(): Promise<boolean> {
  const dryRun = hasFlag(process.argv, "--dry-run");
  const check = hasFlag(process.argv, "--check");
  const force = hasFlag(process.argv, "--force");

  const outcome = await migrateConfigFile(resolveConfigPath(), { dryRun, check, force });

  switch (outcome.status) {
    case "already-current":
      console.log(`${c.green}✓${c.reset} ${outcome.message}`);
      break;
    case "stale":
      console.log(`${c.red}✗${c.reset} ${outcome.message}`);
      break;
    case "dry-run":
      console.log(`${c.bold}Planned migration${c.reset} (dry run)\n`);
      for (const step of outcome.steps) {
        console.log(`  v${step.from} -> v${step.to}: ${c.dim}${step.describe}${c.reset}`);
      }
      console.log(`\n${c.bold}Changes:${c.reset}`);
      printDiff(outcome.diff);
      console.log(`\n${c.dim}${outcome.message}${c.reset}`);
      break;
    case "migrated":
      console.log(`${c.green}✓${c.reset} ${outcome.message}\n`);
      console.log(`${c.bold}Applied:${c.reset}`);
      for (const step of outcome.steps) {
        console.log(`  v${step.from} -> v${step.to}: ${c.dim}${step.describe}${c.reset}`);
      }
      console.log(`\n${c.bold}Changes:${c.reset}`);
      printDiff(outcome.diff);
      break;
    case "error":
      console.error(`${c.red}Error: ${outcome.message}${c.reset}`);
      break;
  }

  return outcome.ok;
}

export async function cmdConfig(): Promise<boolean> {
  const sub = process.argv[3];

  if (sub === "migrate") return cmdConfigMigrate();

  // Default / help: show the current config version + available subcommands.
  if (!sub || sub === "--help" || sub === "-h") {
    try {
      const content = await readFile(resolveConfigPath(), "utf-8");
      const raw = parse(content) as RawConfig;
      const version = detectConfigVersion(raw);
      const tag =
        version === CONFIG_SCHEMA_VERSION
          ? `${c.green}(current)${c.reset}`
          : `${c.yellow}(behind v${CONFIG_SCHEMA_VERSION} — run \`kit config migrate\`)${c.reset}`;
      console.log(`${c.bold}${KIT_FILE}${c.reset} schema version: v${version} ${tag}`);
    } catch (err) {
      console.log(`${c.dim}No readable ${KIT_FILE}: ${(err as Error).message}${c.reset}`);
    }
    console.log(`\n${c.bold}Subcommands:${c.reset}`);
    console.log(
      `  ${c.cyan}kit config migrate${c.reset}             Migrate ${KIT_FILE} to v${CONFIG_SCHEMA_VERSION}`,
    );
    console.log(
      `  ${c.cyan}kit config migrate --dry-run${c.reset}   Show the plan + diff, write nothing`,
    );
    console.log(
      `  ${c.cyan}kit config migrate --check${c.reset}     Exit non-zero if behind (CI gate)`,
    );
    console.log(
      `  ${c.cyan}kit config migrate --force${c.reset}     Overwrite an existing ${KIT_FILE}.backup`,
    );
    return true;
  }

  console.error(`${c.red}Unknown config subcommand: ${sub}${c.reset}`);
  console.error(`Run \`kit config\` to see subcommands.`);
  return false;
}
