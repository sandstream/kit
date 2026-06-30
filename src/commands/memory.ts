// kit memory commands — extracted from cli.ts (split step 7). The large
// subcommand dispatcher; restructured to a handler table in a follow-up.
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
  openMemoryDb,
  getStats,
  getMemoryDbPath,
  searchMessages,
  recordQuery,
  dailyActivity,
} from "../memory/db.js";
import { sparkline, fmtTokens } from "../memory/stats.js";
import { indexAllHarnesses } from "../memory/parser.js";
import { mergeDb } from "../memory/merge.js";
import { buildSuggestPrompt } from "../memory/suggest.js";
import { getCurrentProjectRoot } from "../memory/project.js";
import { scanDbForSecrets } from "../memory/scan.js";
import { backupEncrypted, restoreEncrypted } from "../memory/backup.js";
import { ensureKitWrapper } from "../kit-wrapper.js";
import { syncFromExport } from "../memory/sync.js";
import {
  loadSyncConfig,
  pushMemory,
  pullMemory,
  getSyncConfigPath,
  initSyncConfig,
  tryAutoPull,
  tryAutoPush,
  maybeSyncNudge,
  type SyncTransport,
} from "../memory/remote-sync.js";
import {
  shareEntry,
  listAreas,
  searchShared,
  readShared,
  effectiveStatus,
  formatAge,
  getSharedPath,
  type SharedKind,
  type SharedStatus,
  type SharedEntry,
} from "../memory/shared.js";
import {
  userPromptSubmitReminder,
  maybeStartMidSessionIndex,
  startDetachedSessionEnd,
  runSessionEndIndex,
  sessionStartRecovery,
} from "../memory/hook.js";
import { decisionsForPaths, changedPaths } from "../memory/clusters.js";
import { collectHints } from "../hints.js";
import {
  installMemoryHooks,
  uninstallMemoryHooks,
  installStatusline,
  uninstallStatusline,
  getClaudeSettingsPath,
} from "../memory/install.js";
import {
  palAdd,
  palList,
  palDone,
  palSnooze,
  palAutoVerify,
  palPrune,
  importLegacyLedger,
  type VerifyCheck,
} from "../memory/pal.js";
import {
  saveThread,
  listThreads,
  removeThread,
  latestSessionId,
  resolveThread,
} from "../memory/threads.js";

export async function cmdMemory(): Promise<boolean> {
  const subcommand = process.argv[3];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") return memHelp();
  // A --help/-h flag after a subcommand means "show help", never run a
  // side-effectful subcommand (e.g. `kit memory install --help` must not install).
  if (hasFlag(process.argv, "--help") || hasFlag(process.argv, "-h")) return memHelp();

  // One handler per subcommand — keeps this dispatcher flat (was a complexity-132
  // if-chain). Each handler reads process.argv itself, so no args thread through.
  const handlers: Record<string, () => Promise<boolean>> = {
    index: memIndex,
    merge: memMerge,
    sync: memSync,
    push: memPush,
    pull: memPull,
    stats: memStats,
    status: memStats, // common typo/alias for `stats`
    suggest: memSuggest,
    search: memSearch,
    hook: memHook,
    install: memInstall,
    uninstall: memUninstall,
    share: memShare,
    areas: memAreas,
    area: memArea,
    context: memContext,
    scan: memScan,
    backup: memBackup,
    restore: memRestore,
    save: memSave,
    threads: memThreads,
    resume: memResume,
    forget: memForget,
    pal: memPal,
  };

  const handler = handlers[subcommand];
  if (handler) return handler();

  console.error(`${c.red}Unknown memory subcommand: ${subcommand}${c.reset}`);
  console.error("Use: kit memory index | search <query> | stats | install | uninstall | pal");
  return false;
}

async function memPal(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const action = process.argv[4] && !process.argv[4].startsWith("--") ? process.argv[4] : "list";
  const db = openMemoryDb();
  try {
    if (action === "list") {
      const scope = hasFlag(process.argv, "--global")
        ? undefined
        : basename(getCurrentProjectRoot());
      // Device-coupled by default: only THIS device's items (+ legacy rows) show,
      // so an ephemeral session's items don't nag here. --all opts back in.
      const items = palList(db, { scope, allDevices: hasFlag(process.argv, "--all") });
      if (jsonMode) {
        console.log(JSON.stringify(items));
        return true;
      }
      if (!items.length) {
        console.log(`${c.dim}no open action items${c.reset}`);
        return true;
      }
      console.log(`${c.bold}${items.length}${c.reset} open action item(s):`);
      for (const p of items) {
        const tag = p.kind === "auto" ? ` ${c.dim}· auto${c.reset}` : "";
        const scope = p.scope ? ` ${c.dim}[${p.scope}]${c.reset}` : "";
        console.log(`  ${c.bold}${p.id}${c.reset}  ${p.title}${scope}${tag}`);
      }
      return true;
    }
    if (action === "add") {
      const title = process.argv
        .slice(5)
        .filter((a) => !a.startsWith("--"))
        .join(" ")
        .trim();
      if (!title) {
        console.error(
          `${c.red}usage: kit memory pal add <title> [--verify-http <url> [--expect <code>]] [--verify-file <path>] [--scope=<s>]${c.reset}`,
        );
        return false;
      }
      // Declarative verify only (no shell). http-status or file-exists.
      const httpUrl = flagValue(process.argv, "--verify-http");
      const filePath = flagValue(process.argv, "--verify-file");
      let check: VerifyCheck | undefined;
      if (httpUrl) {
        const expect = Number(flagValue(process.argv, "--expect") ?? "200");
        check = {
          type: "http-status",
          url: httpUrl,
          expect: Number.isFinite(expect) ? expect : 200,
        };
      } else if (filePath) {
        check = { type: "file-exists", path: filePath };
      }
      const id = palAdd(db, {
        title,
        check,
        scope: flagValue(process.argv, "--scope") ?? basename(getCurrentProjectRoot()),
      });
      console.log(`${c.green}✓${c.reset} added ${c.bold}${id}${c.reset}`);
      return true;
    }
    if (action === "done") {
      const id = process.argv[5];
      if (!id) {
        console.error(`${c.red}usage: kit memory pal done <id>${c.reset}`);
        return false;
      }
      console.log(
        palDone(db, id)
          ? `${c.green}✓${c.reset} closed ${id}`
          : `${c.dim}${id} not found or already closed${c.reset}`,
      );
      return true;
    }
    if (action === "snooze") {
      const id = process.argv[5];
      const days = Number(process.argv[6] ?? "7") || 7;
      if (!id) {
        console.error(`${c.red}usage: kit memory pal snooze <id> [days]${c.reset}`);
        return false;
      }
      console.log(
        palSnooze(db, id, days)
          ? `${c.green}✓${c.reset} snoozed ${id} for ${days}d`
          : `${c.dim}${id} not found${c.reset}`,
      );
      return true;
    }
    if (action === "verify") {
      const r = await palAutoVerify(db);
      console.log(
        `${c.dim}checked ${r.checked} · closed ${r.closed.length} · reopened ${r.reopened.length}${c.reset}`,
      );
      return true;
    }
    if (action === "import") {
      const r = importLegacyLedger(db);
      console.log(`${c.green}✓${c.reset} imported ${r.imported} item(s) from the legacy ledger`);
      return true;
    }
    if (action === "prune") {
      // Close this device's open items whose origin project dir is gone (ephemeral
      // / deleted scratch) — clears stale "blocked-on-you" nags.
      const r = palPrune(db);
      console.log(
        r.closed.length
          ? `${c.green}✓${c.reset} pruned ${c.bold}${r.closed.length}${c.reset} dead-origin item(s): ${c.dim}${r.closed.join(", ")}${c.reset}`
          : `${c.dim}nothing to prune — every open item's origin still exists${c.reset}`,
      );
      return true;
    }
    console.error(`${c.red}Unknown pal action: ${action}${c.reset}`);
    console.error("Use: kit memory pal [list|add|done|snooze|verify|import|prune]");
    return false;
  } finally {
    db.close();
  }
}

async function memHelp(): Promise<boolean> {
  console.log("kit memory — local conversation memory (SQLite + FTS5)");
  console.log("\nUsage:");
  console.log(
    "  kit memory index            Index all agent transcripts (Claude Code, Codex, Gemini, Cursor, …) into the store",
  );
  console.log(
    "  kit memory search <query>   Search memory + curated shared decisions (current project; --global for all)",
  );
  console.log("  kit memory stats            Show what the memory store contains");
  console.log("  kit memory merge <file>     Merge another machine's memory.db into this one");
  console.log(
    "  kit memory sync <file>      Sync from a memory export/backup (decrypts encrypted blobs)",
  );
  console.log(
    "  kit memory sync init        Write ~/.kit/sync.toml (--remote <url> | --command, --auto for hook sync)",
  );
  console.log(
    "  kit memory push             Encrypt + push your store to your private remote (~/.kit/sync.toml)",
  );
  console.log(
    "  kit memory pull             Pull + merge your store from your private remote (last-write-wins)",
  );
  console.log(
    "  kit memory install          Wire the hooks + status line (score + PAL ⚠) into ~/.claude/settings.json (--no-statusline to skip)",
  );
  console.log("  kit memory uninstall        Remove the hooks");
  console.log(
    "  kit memory pal [list|add|done|snooze|verify|import|prune]   Pending action ledger (list --all = every device; prune = drop dead-origin items)",
  );
  console.log("  kit memory save <name>      Bookmark the current session as a named copilot");
  console.log("  kit memory threads          List saved copilots (--global for all)");
  console.log("  kit memory resume <name|n>  Print the resume command for a saved copilot");
  console.log("  kit memory forget <name>    Remove a saved copilot");
  console.log("  kit memory scan             Scan the store for stored secrets");
  console.log("  kit memory backup <file>    Encrypted backup (set KIT_MEMORY_PASSPHRASE)");
  console.log("  kit memory restore <file>   Restore an encrypted backup (new machine)");
  console.log("  kit memory share …          Promote a curated entry to shared (team) memory");
  console.log("  kit memory areas            List shared responsibility areas");
  console.log("  kit memory area <name>      Show shared entries for one area");
  console.log(
    "  kit memory context [paths]  Surface active decisions for the area(s) you're touching (--changed = working tree)",
  );
  return true;
}

async function memIndex(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const db = openMemoryDb();
  const t0 = Date.now();
  const byHarness = indexAllHarnesses(db);
  const ms = Date.now() - t0;
  db.close();
  if (jsonMode) {
    console.log(JSON.stringify({ byHarness, ms }));
    return true;
  }
  let messages = 0;
  let toolUses = 0;
  let files = 0;
  let skipped = 0;
  for (const r of Object.values(byHarness)) {
    messages += r.messages;
    toolUses += r.toolUses;
    files += r.files;
    skipped += r.filesSkipped;
  }
  console.log(
    `${c.green}✓${c.reset} indexed ${c.bold}${messages}${c.reset} messages + ${toolUses} tool-uses from ${files} sessions${skipped ? `, ${skipped} unchanged` : ""} ${c.dim}(${ms}ms)${c.reset}`,
  );
  for (const [harness, r] of Object.entries(byHarness)) {
    if (r.files || r.messages) {
      console.log(
        `  ${c.dim}${harness}: ${r.messages} msg · ${r.files} sessions${r.filesSkipped ? ` · ${r.filesSkipped} unchanged` : ""}${c.reset}`,
      );
    }
  }
  return true;
}

async function memMerge(): Promise<boolean> {
  const sourcePath = process.argv[4];
  if (!sourcePath) {
    console.error(`${c.red}usage: kit memory merge <other-machine-memory.db>${c.reset}`);
    return false;
  }
  const db = openMemoryDb();
  try {
    const r = mergeDb(db, sourcePath);
    console.log(
      `${c.green}✓${c.reset} merged ${c.bold}${r.messages}${c.reset} messages + ${r.toolUses} tool-uses · ${r.sessions} sessions · ${r.pending} pending · ${r.threads} copilots ${c.dim}from ${sourcePath}${c.reset}`,
    );
  } catch (err) {
    db.close();
    console.error(`${c.red}${(err as Error).message}${c.reset}`);
    return false;
  }
  db.close();
  return true;
}

async function memSync(): Promise<boolean> {
  if (process.argv[4] === "init") return memSyncInit();
  const src = process.argv[4];
  if (!src) {
    console.error(
      `${c.red}usage: kit memory sync <export.db|backup-file>  (encrypted blob needs KIT_MEMORY_PASSPHRASE)${c.reset}`,
    );
    return false;
  }
  if (!existsSync(src)) {
    console.error(`${c.red}export not found: ${src}${c.reset}`);
    return false;
  }
  const pass = process.env.KIT_MEMORY_PASSPHRASE ?? flagValue(process.argv, "--passphrase");
  const db = openMemoryDb();
  try {
    const r = syncFromExport(db, src, { passphrase: pass });
    console.log(
      `${c.green}✓${c.reset} synced ${c.bold}${r.messages}${c.reset} messages + ${r.toolUses} tool-uses · ${r.sessions} sessions · ${r.pending} pending · ${r.threads} copilots ${c.dim}from ${src}${c.reset}`,
    );
    console.log(
      `${c.dim}last-write-wins on sessions; file_index (this machine's index state) left untouched${c.reset}`,
    );
  } catch (err) {
    console.error(`${c.red}${(err as Error).message}${c.reset}`);
    return false;
  } finally {
    db.close();
  }
  return true;
}

async function memSyncInit(): Promise<boolean> {
  const transport: SyncTransport = hasFlag(process.argv, "--command") ? "command" : "git";
  const { path, created } = initSyncConfig({
    transport,
    remote: flagValue(process.argv, "--remote"),
    branch: flagValue(process.argv, "--branch"),
    pushCmd: flagValue(process.argv, "--push-cmd"),
    pullCmd: flagValue(process.argv, "--pull-cmd"),
    auto: hasFlag(process.argv, "--auto"),
    force: hasFlag(process.argv, "--force"),
  });
  if (!created) {
    console.log(
      `${c.yellow}!${c.reset} ${path} already exists ${c.dim}(use --force to overwrite)${c.reset}`,
    );
    return true;
  }
  console.log(
    `${c.green}✓${c.reset} wrote ${c.bold}${path}${c.reset} ${c.dim}(LOCAL — never committed)${c.reset}`,
  );
  console.log(
    `${c.dim}edit the ${transport === "command" ? "push_cmd/pull_cmd" : "remote"} to your PRIVATE store, then:${c.reset}`,
  );
  console.log(
    `  export KIT_MEMORY_PASSPHRASE="…"   ${c.dim}# never stored; the blob is encrypted with it${c.reset}`,
  );
  console.log(`  kit memory push   ${c.dim}# from one machine${c.reset}`);
  console.log(`  kit memory pull   ${c.dim}# on another${c.reset}`);
  if (transport === "git") {
    console.log(
      `${c.dim}note: create the private repo first — e.g. \`git init --bare /srv/kit-memory.git\` on your server, or an empty private repo on GitHub. kit creates the branch + blob, not the repo.${c.reset}`,
    );
  }
  if (hasFlag(process.argv, "--auto")) {
    console.log(
      `${c.dim}auto-sync ON: pull at session start + push at session end (run \`kit memory install\`; KIT_MEMORY_PASSPHRASE must be in the hook env).${c.reset}`,
    );
  }
  return true;
}

/** Shared setup-missing message for `push`/`pull` (sync is opt-in + local-only). */
function syncNotConfigured(): boolean {
  console.error(
    `${c.red}private memory sync is not configured${c.reset}\n` +
      `${c.dim}create ${getSyncConfigPath()} (LOCAL — never committed) with EITHER a git remote:${c.reset}\n` +
      `  [memory.sync]\n` +
      `  remote = "git@github.com:you/your-private-memory.git"\n` +
      `${c.dim}...or your own transport command ($KIT_MEMORY_BLOB is the encrypted blob path):${c.reset}\n` +
      `  [memory.sync]\n` +
      `  transport = "command"\n` +
      `  push_cmd = "scp \\"$KIT_MEMORY_BLOB\\" user@server:/srv/kit-memory.enc"\n` +
      `  pull_cmd = "scp user@server:/srv/kit-memory.enc \\"$KIT_MEMORY_BLOB\\""\n` +
      `${c.dim}then set KIT_MEMORY_PASSPHRASE and run \`kit memory push\` / \`kit memory pull\`.${c.reset}`,
  );
  return false;
}

async function memPush(): Promise<boolean> {
  let cfg;
  try {
    cfg = loadSyncConfig();
  } catch (err) {
    console.error(`${c.red}${(err as Error).message}${c.reset}`);
    return false;
  }
  if (!cfg) return syncNotConfigured();
  const pass = process.env.KIT_MEMORY_PASSPHRASE ?? flagValue(process.argv, "--passphrase");
  if (!pass) {
    console.error(
      `${c.red}set KIT_MEMORY_PASSPHRASE (or --passphrase) — the blob pushed to ${cfg.remote} is encrypted${c.reset}`,
    );
    return false;
  }
  try {
    const r = pushMemory(cfg, pass, getCurrentProjectRoot());
    console.log(
      r.pushed
        ? `${c.green}✓${c.reset} pushed encrypted memory → ${c.bold}${r.target}${c.reset} ${c.dim}(${r.file})${c.reset}`
        : `${c.dim}already up to date — nothing to push${c.reset}`,
    );
    return true;
  } catch (err) {
    console.error(`${c.red}${(err as Error).message}${c.reset}`);
    return false;
  }
}

async function memPull(): Promise<boolean> {
  let cfg;
  try {
    cfg = loadSyncConfig();
  } catch (err) {
    console.error(`${c.red}${(err as Error).message}${c.reset}`);
    return false;
  }
  if (!cfg) return syncNotConfigured();
  const pass = process.env.KIT_MEMORY_PASSPHRASE ?? flagValue(process.argv, "--passphrase");
  try {
    const r = pullMemory(cfg, pass, getCurrentProjectRoot());
    if (!r.found) {
      console.log(
        `${c.dim}no memory blob at ${r.target} yet — push from another machine first${c.reset}`,
      );
      return true;
    }
    const m = r.merge!;
    console.log(
      `${c.green}✓${c.reset} pulled ${c.bold}${m.messages}${c.reset} messages + ${m.toolUses} tool-uses · ${m.sessions} sessions · ${m.pending} pending · ${m.threads} copilots ${c.dim}from ${r.target}${c.reset}`,
    );
    console.log(
      `${c.dim}last-write-wins on sessions; file_index (this machine's index state) left untouched${c.reset}`,
    );
    return true;
  } catch (err) {
    console.error(`${c.red}${(err as Error).message}${c.reset}`);
    return false;
  }
}

async function memStats(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const tokensMode = hasFlag(process.argv, "--tokens");
  const heatmapMode = hasFlag(process.argv, "--heatmap");
  const db = openMemoryDb();
  const s = getStats(db);
  const activity = heatmapMode ? dailyActivity(db, 90) : [];
  db.close();
  if (jsonMode) {
    console.log(JSON.stringify(heatmapMode ? { ...s, activity } : s));
    return true;
  }

  const pct = (r: number | null): string => (r === null ? "n/a" : `${(r * 100).toFixed(0)}%`);

  console.log(`${c.bold}kit memory${c.reset}  ${c.dim}${s.dbPath}${c.reset}`);
  console.log(`  sessions   ${s.sessions}`);
  if (s.byHarness.length > 1) {
    const breakdown = s.byHarness.map((h) => `${h.harness} ${h.sessions}`).join(", ");
    console.log(`             ${c.dim}${breakdown}${c.reset}`);
  }
  console.log(
    `             ${c.dim}${s.sessionsBreakdown.logical} logical, ${s.sessionsBreakdown.sidechain} sidechain · ${s.sessionsBreakdown.filesIndexed} transcript files indexed${c.reset}`,
  );
  console.log(`  messages   ${s.messages}`);
  console.log(`  tool-uses  ${s.toolUses}`);
  console.log(
    `  tokens     ${fmtTokens(s.tokens.totalTokens)} ${c.dim}(${fmtTokens(s.tokens.inputTokens)} in / ${fmtTokens(s.tokens.outputTokens)} out · cache-hit ${pct(s.tokens.cacheHitRatio)})${c.reset}`,
  );
  console.log(
    `  recalls    ${s.recalls.total} ${c.dim}(${s.recalls.last7d} last 7d · ${s.recalls.distinctQueries} distinct queries)${c.reset}`,
  );
  console.log(`  pending    ${s.pendingOpen} ${c.dim}(open action items)${c.reset}`);
  console.log(`  size       ${Math.round(s.sizeBytes / 1024)} KB`);
  console.log(
    `             ${c.dim}account-wide /stats may exceed this — sessions on other machines aren't in this DB${c.reset}`,
  );

  if (tokensMode) {
    console.log(`\n${c.bold}token economy${c.reset}`);
    console.log(
      `  ${fmtTokens(s.tokens.perMessage)}/message · ${fmtTokens(s.tokens.perSession)}/session`,
    );
    console.log(
      `  cache: ${fmtTokens(s.tokens.cacheReadTokens)} read / ${fmtTokens(s.tokens.cacheCreationTokens)} created${c.reset}`,
    );
    if (s.tokens.byModel.length) {
      console.log(`  ${c.dim}by model:${c.reset}`);
      for (const m of s.tokens.byModel) {
        console.log(
          `    ${m.model}  ${c.dim}${m.messages} msgs · ${fmtTokens(m.inputTokens)} in / ${fmtTokens(m.outputTokens)} out${c.reset}`,
        );
      }
    }
    if (s.recalls.topTerms.length) {
      console.log(`  ${c.dim}top recalls:${c.reset}`);
      for (const term of s.recalls.topTerms) {
        console.log(`    ${term.count}×  ${c.dim}${term.query}${c.reset}`);
      }
    }
  }

  if (heatmapMode) {
    console.log(`\n${c.bold}activity${c.reset} ${c.dim}(last 90 days, messages/day)${c.reset}`);
    console.log(`  ${sparkline(activity.map((a) => a.count))}`);
    if (activity.length) {
      console.log(`  ${c.dim}${activity[0].day} → ${activity[activity.length - 1].day}${c.reset}`);
    }
  }
  return true;
}

async function memSuggest(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  // BYO-LLM: kit emits a prompt; it never calls a model. Pipe to your own:
  //   kit memory suggest | <your-llm>
  const limitArg = flagValue(process.argv, "--limit");
  const limit = limitArg ? Math.max(1, parseInt(limitArg, 10) || 30) : undefined;
  const db = openMemoryDb();
  const out = buildSuggestPrompt(db, { limit });
  db.close();
  if (jsonMode) {
    console.log(JSON.stringify(out));
    return true;
  }
  console.log(out.prompt);
  return true;
}

async function memSearch(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  // Extract positional query terms, skipping flags AND the value of space-form
  // value-flags (`--limit 3` / `--project /p`) so "3" doesn't leak into the query.
  const VALUE_FLAGS = new Set(["--limit", "--project"]);
  const rawArgs = process.argv.slice(4);
  const terms: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a)) i++; // consume the following value token
      continue;
    }
    terms.push(a);
  }
  const query = terms.join(" ").trim();
  if (!query) {
    console.error(
      `${c.red}usage: kit memory search <query> [--global] [--project=<path>] [--limit=N]${c.reset}`,
    );
    return false;
  }
  const limit = Number(flagValue(process.argv, "--limit") ?? "20") || 20;
  const projectPath = hasFlag(process.argv, "--global")
    ? undefined
    : (flagValue(process.argv, "--project") ?? getCurrentProjectRoot());
  const db = openMemoryDb();
  const hits = searchMessages(db, query, { limit, projectPath });
  // Record the recall (query_log) — best-effort; never let logging break search.
  try {
    recordQuery(db, { query, hitCount: hits.length, projectPath });
  } catch {
    // logging is non-critical
  }
  db.close();

  // Curated shared tier (.kit/shared/memory.jsonl) — high-signal, team-reviewed
  // decisions/conventions that travel with the repo. Always project-local (so
  // `--global`, which widens the raw-recall scope across projects, still reads
  // THIS repo's shared store). Fail-open: a missing/broken file never breaks search.
  const sharedRoot = flagValue(process.argv, "--project") ?? getCurrentProjectRoot();
  let shared: SharedEntry[] = [];
  try {
    shared = searchShared(sharedRoot, query);
  } catch {
    // shared tier is best-effort context, never gates raw recall
  }

  if (jsonMode) {
    console.log(JSON.stringify({ messages: hits, shared }));
    return true;
  }

  // Curated decisions first — they're the durable context, not a raw transcript
  // line. Superseded/reversed matches are still shown (so "this was tried + undone"
  // surfaces) but badged, with age — relevance stays the reader's call.
  if (shared.length) {
    const allShared = readShared(sharedRoot);
    console.log(
      `${c.bold}${shared.length}${c.reset} curated (shared) match(es) ${c.dim}— team decisions${c.reset}`,
    );
    for (const e of shared) {
      const st = effectiveStatus(e, allShared);
      const badge =
        st === "active" ? "" : ` ${st === "reversed" ? c.red : c.yellow}[${st}]${c.reset}`;
      const age = formatAge(e.ts);
      const prov = `${e.area} · ${e.author}${e.source_ref ? ` @${e.source_ref}` : ""}${age ? ` · ${age}` : ""}`;
      console.log(
        `  ${c.bold}[${e.kind}]${c.reset} ${e.title}${badge} ${c.dim}— ${prov}${c.reset}`,
      );
      if (e.body) console.log(`    ${c.dim}${e.body.replace(/\s+/g, " ").slice(0, 160)}${c.reset}`);
    }
  }

  const scope = projectPath ? `${c.dim}in ${projectPath}${c.reset}` : `${c.dim}(global)${c.reset}`;
  if (!hits.length) {
    if (shared.length) return true; // curated results already shown; raw recall empty
    console.log(`${c.dim}no matches for "${query}" ${projectPath ?? "(global)"}${c.reset}`);
    return true;
  }
  console.log(`${c.bold}${hits.length}${c.reset} match(es) ${scope}`);
  for (const h of hits) {
    const snippet = (h.content ?? "").replace(/\s+/g, " ").slice(0, 120);
    console.log(
      `  ${c.dim}${h.timestamp ?? "?"}${c.reset} ${c.bold}${h.role ?? h.uuid ?? ""}${c.reset}  ${snippet}`,
    );
  }
  return true;
}

async function memHook(): Promise<boolean> {
  // Internal: invoked by Claude Code hooks. Fail-open — never block.
  const event = process.argv[4];
  if (event === "user-prompt-submit") {
    maybeStartMidSessionIndex(); // debounced, detached — keeps recall fresh mid-session
    const text = userPromptSubmitReminder();
    if (text) console.log(text);
    return true;
  }
  if (event === "session-end") {
    // Return instantly: a SessionEnd hook that blocks on the index (or the
    // opt-in network push) gets cancelled by Claude Code on exit ("Hook
    // cancelled"). The real work runs in a detached worker below.
    startDetachedSessionEnd();
    return true;
  }
  if (event === "session-end-run") {
    // Internal: the detached SessionEnd worker. No hook is waiting on it, so the
    // (potentially slow / networked) capture can run synchronously here.
    runSessionEndIndex();
    // Opt-in: push this session's memory to your durable store before an
    // (ephemeral) container is reclaimed. Fail-soft; notes go to stderr.
    const pushed = tryAutoPush(getCurrentProjectRoot());
    if (pushed.note) console.error(`${c.dim}${pushed.note}${c.reset}`);
    return true;
  }
  if (event === "session-start") {
    // Opt-in auto-pull BEFORE recovery so "where you left off" reflects the
    // freshly-merged store. Fail-soft; the sync note goes to stderr (the recovery
    // text on stdout is what gets injected as context).
    const pulled = tryAutoPull(getCurrentProjectRoot());
    if (pulled.note) console.error(`${c.dim}${pulled.note}${c.reset}`);
    const text = sessionStartRecovery();
    if (text) console.log(text);
    // One-time upgrade nudge when sync isn't configured yet.
    const nudge = maybeSyncNudge();
    if (nudge) console.error(`${c.dim}${nudge}${c.reset}`);
    // One deterministic, marker-gated contextual tip (unsigned policy, unanchored
    // audit log, missing scanner, …). Fail-soft; stderr so it isn't injected as context.
    try {
      for (const h of await collectHints(getCurrentProjectRoot())) {
        console.error(`${c.dim}💡 tip: ${h.tip}${c.reset}`);
      }
    } catch {
      /* a tip must never break session start */
    }
    return true;
  }
  console.error(`${c.red}Unknown hook event: ${event ?? "(none)"}${c.reset}`);
  return false;
}

async function memInstall(): Promise<boolean> {
  // Create the self-healing wrapper FIRST so installMemoryHooks embeds its path.
  // The wrapper restores the tool PATH a non-login hook shell drops, then exec's
  // the real kit — so memory capture fires even in containers/CI/agent runners.
  const w = ensureKitWrapper();
  if (w.action === "written" || w.action === "updated") {
    console.log(
      `${c.green}✓${c.reset} ${w.action} self-healing wrapper ${c.dim}${w.path}${c.reset}`,
    );
  } else if (w.action === "unmanaged") {
    console.log(`${c.yellow}!${c.reset} ${w.detail}`);
  } else if (w.action === "skipped") {
    console.log(`${c.yellow}!${c.reset} ${w.detail}`);
  }
  const { added, alreadyPresent, resolved } = installMemoryHooks();
  for (const e of added) console.log(`${c.green}✓${c.reset} installed ${e} hook`);
  for (const e of alreadyPresent) console.log(`${c.dim}• ${e} hook already present${c.reset}`);

  // Also wire the status line (the setup score + open-PAL ⚠ count, visible in the
  // terminal) — unless --no-statusline, and never clobbering a custom statusLine.
  if (!hasFlag(process.argv, "--no-statusline")) {
    const sl = installStatusline();
    if (sl.status === "added")
      console.log(`${c.green}✓${c.reset} wired status line ${c.dim}(kit statusline)${c.reset}`);
    else if (sl.status === "already") console.log(`${c.dim}• status line already wired${c.reset}`);
    else
      console.log(
        `${c.yellow}!${c.reset} you already have a custom statusLine — left as-is. ` +
          `To show kit's score + PAL count, set its command to \`kit statusline\` (or run with --no-statusline to silence this).`,
      );
  }

  console.log(`${c.dim}settings: ${getClaudeSettingsPath()}${c.reset}`);
  if (!resolved) {
    console.log(
      `${c.yellow}!${c.reset} Could not resolve kit's absolute path — hooks use a bare \`kit\`, ` +
        `which only fires if kit is on the hook shell's PATH (often not the case). ` +
        `Reinstall kit globally and re-run, or edit the commands in ${getClaudeSettingsPath()} to an absolute path.`,
    );
  }
  return true;
}

async function memUninstall(): Promise<boolean> {
  const { removed } = uninstallMemoryHooks();
  if (removed.length) {
    for (const e of removed) console.log(`${c.green}✓${c.reset} removed ${e} hook`);
  } else {
    console.log(`${c.dim}no kit memory hooks were installed${c.reset}`);
  }
  if (uninstallStatusline().removed) {
    console.log(`${c.green}✓${c.reset} removed kit status line`);
  }
  return true;
}

async function memShare(): Promise<boolean> {
  const area = flagValue(process.argv, "--area");
  const title = flagValue(process.argv, "--title");
  const kind = (flagValue(process.argv, "--kind") ?? "note") as SharedKind;
  const body = flagValue(process.argv, "--body") ?? "";
  const ref = flagValue(process.argv, "--ref");
  // Lifecycle: a change is a NEW entry that supersedes/reverses an old id (append-only).
  const supersedes = flagValue(process.argv, "--supersedes");
  const reverses = flagValue(process.argv, "--reverses");
  const status = flagValue(process.argv, "--status") as SharedStatus | undefined;
  if (!area || !title) {
    console.error(
      `${c.red}usage: kit memory share --area <a> --title <t> [--kind decision|convention|how-built|status|security|note] [--body <b>] [--ref <r>] [--supersedes <id>] [--reverses <id>]${c.reset}`,
    );
    return false;
  }
  const root = getCurrentProjectRoot();
  // Validate any referenced id exists, so a typo'd --supersedes/--reverses can't
  // silently leave the old decision active (it would never be marked superseded).
  if (supersedes || reverses) {
    const ids = new Set(readShared(root).map((e) => e.id));
    for (const [flag, id] of [
      ["--supersedes", supersedes],
      ["--reverses", reverses],
    ] as const) {
      if (id && !ids.has(id)) {
        console.error(`${c.red}${flag} ${id}: no shared entry with that id${c.reset}`);
        return false;
      }
    }
  }
  try {
    const e = shareEntry(
      root,
      { area, kind, title, body, refs: ref ? [ref] : [], status, supersedes, reverses },
      new Date().toISOString(),
    );
    const rel =
      e.reverses || e.supersedes
        ? ` ${c.dim}(${e.reverses ? "reverses" : "supersedes"} ${e.reverses ?? e.supersedes})${c.reset}`
        : "";
    console.log(
      `${c.green}✓${c.reset} shared ${c.bold}${e.id}${c.reset} to area ${c.bold}${area}${c.reset}${rel} ${c.dim}(${getSharedPath(root)})${c.reset}`,
    );
    console.log(
      `${c.dim}commit .kit/shared/memory.jsonl + open a PR — shared memory is reviewed like code${c.reset}`,
    );
  } catch (err) {
    console.error(`${c.red}${(err as Error).message}${c.reset}`);
    return false;
  }
  return true;
}

async function memAreas(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const areas = listAreas(getCurrentProjectRoot());
  if (jsonMode) {
    console.log(JSON.stringify(areas));
    return true;
  }
  if (!areas.length) {
    console.log(`${c.dim}no shared areas yet — add one with kit memory share${c.reset}`);
    return true;
  }
  console.log(`${c.bold}${areas.length}${c.reset} responsibility area(s):`);
  for (const a of areas) {
    console.log(
      `  ${c.bold}${a.area}${c.reset} ${c.dim}· ${a.count} entr${a.count === 1 ? "y" : "ies"}${c.reset}`,
    );
  }
  return true;
}

async function memArea(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const name = process.argv[4];
  if (!name) {
    console.error(`${c.red}usage: kit memory area <name>${c.reset}`);
    return false;
  }
  const root = getCurrentProjectRoot();
  const all = readShared(root);
  const entries = all.filter((e) => e.area === name);
  if (jsonMode) {
    // Enrich with the EFFECTIVE lifecycle status (computed against the full set).
    console.log(JSON.stringify(entries.map((e) => ({ ...e, status: effectiveStatus(e, all) }))));
    return true;
  }
  if (!entries.length) {
    console.log(`${c.dim}no shared memory for area '${name}'${c.reset}`);
    return true;
  }
  console.log(
    `${c.bold}${name}${c.reset} ${c.dim}· ${entries.length} entr${entries.length === 1 ? "y" : "ies"}${c.reset}`,
  );
  for (const e of entries) {
    const st = effectiveStatus(e, all);
    // Active entries read clean; superseded/reversed are badged + dimmed (history, not HEAD).
    const badge =
      st === "active" ? "" : ` ${st === "reversed" ? c.red : c.yellow}[${st}]${c.reset}`;
    const rel = e.reverses
      ? ` ${c.dim}↩ ${e.reverses}${c.reset}`
      : e.supersedes
        ? ` ${c.dim}→ ${e.supersedes}${c.reset}`
        : "";
    const age = formatAge(e.ts);
    const prov = `${e.author}${e.source_ref ? ` @${e.source_ref}` : ""}${age ? ` · ${age}` : ""}`;
    console.log(
      `  ${c.bold}[${e.kind}]${c.reset} ${e.title}${badge}${rel} ${c.dim}— ${prov}${c.reset}`,
    );
    if (e.body) console.log(`    ${e.body}`);
    if (e.refs.length) console.log(`    ${c.dim}refs: ${e.refs.join(", ")}${c.reset}`);
  }
  return true;
}

async function memContext(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const root = getCurrentProjectRoot();
  // Explicit paths win; otherwise (or with --changed) use the working-tree changes.
  const explicit = process.argv.slice(4).filter((a) => !a.startsWith("--"));
  const paths =
    explicit.length > 0 && !hasFlag(process.argv, "--changed") ? explicit : changedPaths(root);
  const groups = decisionsForPaths(root, paths);
  if (jsonMode) {
    console.log(JSON.stringify({ paths, groups }));
    return true;
  }
  if (!groups.length) {
    console.log(
      `${c.dim}no active shared decisions for the area(s) you're touching (${paths.length} path(s) checked)${c.reset}`,
    );
    return true;
  }
  console.log(
    `${c.bold}Active decisions for the area(s) you're touching${c.reset} ${c.dim}— surfaced by path${c.reset}`,
  );
  for (const g of groups) {
    console.log(`  ${c.bold}${g.area}${c.reset}`);
    for (const e of g.decisions) {
      const age = formatAge(e.ts);
      console.log(
        `    ${c.bold}[${e.kind}]${c.reset} ${e.title}${age ? ` ${c.dim}(${age})${c.reset}` : ""}`,
      );
    }
  }
  return true;
}

async function memScan(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const db = openMemoryDb();
  const findings = scanDbForSecrets(db);
  db.close();
  if (jsonMode) {
    console.log(JSON.stringify(findings));
    return !findings.some((f) => f.confidence === "high");
  }
  if (!findings.length) {
    console.log(`${c.green}✓${c.reset} no stored secrets found in the memory store`);
    return true;
  }
  const high = findings.filter((f) => f.confidence === "high");
  const heuristic = findings.filter((f) => f.confidence === "heuristic");
  const times = (n: number) => (n > 1 ? ` ×${n}` : "");
  if (high.length) {
    console.log(`${c.red}⚠ ${high.length} high-confidence secret(s):${c.reset}`);
    for (const f of high) {
      const proj = f.projects.length
        ? `${c.bold}[${f.projects.join(", ")}]${c.reset}${c.dim} · `
        : "";
      console.log(
        `  ${c.bold}${f.label}${c.reset} ${c.dim}${f.preview}${times(f.count)} · ${proj}${f.sample}${c.reset}`,
      );
    }
  } else {
    console.log(`${c.green}✓${c.reset} no high-confidence secrets`);
  }
  if (heuristic.length) {
    const showAll = hasFlag(process.argv, "--all");
    if (showAll) {
      console.log(
        `${c.dim}${heuristic.length} heuristic match(es) (KEY=value patterns — usually env vars / paths):${c.reset}`,
      );
      for (const f of heuristic) {
        console.log(`  ${c.dim}${f.label} ${f.preview}${times(f.count)} · ${f.sample}${c.reset}`);
      }
    } else {
      console.log(
        `${c.dim}+ ${heuristic.length} heuristic match(es) (likely env vars / paths) — run with --all to see${c.reset}`,
      );
    }
  }
  return high.length === 0; // exit non-zero only on high-confidence findings
}

async function memBackup(): Promise<boolean> {
  const out = process.argv[4];
  const pass = process.env.KIT_MEMORY_PASSPHRASE ?? flagValue(process.argv, "--passphrase");
  if (!out) {
    console.error(`${c.red}usage: kit memory backup <file>  (set KIT_MEMORY_PASSPHRASE)${c.reset}`);
    return false;
  }
  if (!pass) {
    console.error(
      `${c.red}set KIT_MEMORY_PASSPHRASE (or --passphrase) — the key is never stored${c.reset}`,
    );
    return false;
  }
  try {
    backupEncrypted(pass, getMemoryDbPath(), out);
  } catch (err) {
    console.error(`${c.red}${(err as Error).message}${c.reset}`);
    return false;
  }
  console.log(
    `${c.green}✓${c.reset} encrypted backup → ${out} ${c.dim}(AES-256-GCM · scrypt)${c.reset}`,
  );
  return true;
}

async function memRestore(): Promise<boolean> {
  const inFile = process.argv[4];
  const pass = process.env.KIT_MEMORY_PASSPHRASE ?? flagValue(process.argv, "--passphrase");
  if (!inFile) {
    console.error(`${c.red}usage: kit memory restore <file> [--to <path>] [--force]${c.reset}`);
    return false;
  }
  if (!pass) {
    console.error(`${c.red}set KIT_MEMORY_PASSPHRASE (or --passphrase)${c.reset}`);
    return false;
  }
  const dest = flagValue(process.argv, "--to") ?? getMemoryDbPath();
  if (existsSync(dest) && !hasFlag(process.argv, "--force")) {
    console.error(`${c.red}${dest} exists — pass --force to overwrite${c.reset}`);
    return false;
  }
  try {
    restoreEncrypted(pass, inFile, dest);
  } catch {
    console.error(`${c.red}restore failed — wrong passphrase or corrupt backup${c.reset}`);
    return false;
  }
  console.log(`${c.green}✓${c.reset} restored → ${dest}`);
  return true;
}

async function memSave(): Promise<boolean> {
  const name = process.argv
    .slice(4)
    .filter((a) => !a.startsWith("--"))
    .join(" ")
    .trim();
  if (!name) {
    console.error(`${c.red}usage: kit memory save <name> [--session=<id>]${c.reset}`);
    return false;
  }
  const root = getCurrentProjectRoot();
  const db = openMemoryDb();
  const sessionId =
    flagValue(process.argv, "--session") ?? latestSessionId(db, { projectPath: root });
  if (!sessionId) {
    db.close();
    console.error(
      `${c.red}no session found for ${root} — index first or pass --session=<id>${c.reset}`,
    );
    return false;
  }
  saveThread(db, { name, sessionId, projectPath: root });
  db.close();
  console.log(
    `${c.green}✓${c.reset} saved copilot ${c.bold}${name}${c.reset} ${c.dim}→ ${sessionId}${c.reset}`,
  );
  return true;
}

async function memThreads(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const projectPath = hasFlag(process.argv, "--global") ? undefined : getCurrentProjectRoot();
  const db = openMemoryDb();
  const list = listThreads(db, { projectPath });
  db.close();
  if (jsonMode) {
    console.log(JSON.stringify(list));
    return true;
  }
  if (!list.length) {
    console.log(`${c.dim}no saved copilots${projectPath ? ` in ${projectPath}` : ""}${c.reset}`);
    return true;
  }
  const scope = projectPath ? `${c.dim}in ${projectPath}${c.reset}` : `${c.dim}(global)${c.reset}`;
  console.log(`${c.bold}${list.length}${c.reset} saved copilot(s) ${scope}:`);
  list.forEach((t, i) => {
    console.log(`  ${c.bold}${i + 1}${c.reset}. ${t.name}  ${c.dim}${t.session_id}${c.reset}`);
  });
  console.log(`${c.dim}resume with: kit memory resume <name|number>${c.reset}`);
  return true;
}

async function memResume(): Promise<boolean> {
  const ref = process.argv[4];
  if (!ref) {
    console.error(`${c.red}usage: kit memory resume <name|number>${c.reset}`);
    return false;
  }
  const projectPath = hasFlag(process.argv, "--global") ? undefined : getCurrentProjectRoot();
  const db = openMemoryDb();
  const t = resolveThread(db, ref, { projectPath });
  db.close();
  if (!t) {
    console.error(`${c.red}no saved copilot '${ref}'${c.reset}`);
    return false;
  }
  console.log(`${c.bold}${t.name}${c.reset} — run:`);
  console.log(`  claude --resume ${t.session_id}`);
  return true;
}

async function memForget(): Promise<boolean> {
  const name = process.argv
    .slice(4)
    .filter((a) => !a.startsWith("--"))
    .join(" ")
    .trim();
  if (!name) {
    console.error(`${c.red}usage: kit memory forget <name>${c.reset}`);
    return false;
  }
  const db = openMemoryDb();
  const ok = removeThread(db, name);
  db.close();
  console.log(
    ok ? `${c.green}✓${c.reset} forgot ${name}` : `${c.dim}no copilot '${name}'${c.reset}`,
  );
  return true;
}
