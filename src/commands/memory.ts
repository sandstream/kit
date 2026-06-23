// kit memory commands — extracted from cli.ts (split step 7). The large
// subcommand dispatcher; restructured to a handler table in a follow-up.
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { openMemoryDb, getStats, getMemoryDbPath, searchMessages } from "../memory/db.js";
import { indexAllHarnesses } from "../memory/parser.js";
import { mergeDb } from "../memory/merge.js";
import { buildSuggestPrompt } from "../memory/suggest.js";
import { getCurrentProjectRoot } from "../memory/project.js";
import { scanDbForSecrets } from "../memory/scan.js";
import { backupEncrypted, restoreEncrypted } from "../memory/backup.js";
import {
  shareEntry,
  listAreas,
  queryArea,
  getSharedPath,
  type SharedKind,
} from "../memory/shared.js";
import {
  userPromptSubmitReminder,
  runSessionEndIndex,
  sessionStartRecovery,
} from "../memory/hook.js";
import {
  installMemoryHooks,
  uninstallMemoryHooks,
  getClaudeSettingsPath,
} from "../memory/install.js";
import {
  palAdd,
  palList,
  palDone,
  palSnooze,
  palAutoVerify,
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
      const items = palList(db, { scope });
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
    console.error(`${c.red}Unknown pal action: ${action}${c.reset}`);
    console.error("Use: kit memory pal [list|add|done|snooze|verify|import]");
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
  console.log("  kit memory search <query>   Search memory (current project; --global for all)");
  console.log("  kit memory stats            Show what the memory store contains");
  console.log("  kit memory merge <file>     Merge another machine's memory.db into this one");
  console.log("  kit memory install          Wire the 2 hooks into ~/.claude/settings.json");
  console.log("  kit memory uninstall        Remove the hooks");
  console.log("  kit memory pal [list|add|done|snooze|verify|import]   Pending action ledger");
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

async function memStats(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const db = openMemoryDb();
  const s = getStats(db);
  db.close();
  if (jsonMode) {
    console.log(JSON.stringify(s));
    return true;
  }
  console.log(`${c.bold}kit memory${c.reset}  ${c.dim}${s.dbPath}${c.reset}`);
  console.log(`  sessions   ${s.sessions}`);
  if (s.byHarness.length > 1) {
    const breakdown = s.byHarness.map((h) => `${h.harness} ${h.sessions}`).join(", ");
    console.log(`             ${c.dim}${breakdown}${c.reset}`);
  }
  console.log(`  messages   ${s.messages}`);
  console.log(`  tool-uses  ${s.toolUses}`);
  console.log(`  pending    ${s.pendingOpen} ${c.dim}(open action items)${c.reset}`);
  console.log(`  size       ${Math.round(s.sizeBytes / 1024)} KB`);
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
  const terms = process.argv.slice(4).filter((a) => !a.startsWith("--"));
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
  db.close();
  if (jsonMode) {
    console.log(JSON.stringify(hits));
    return true;
  }
  const scope = projectPath ? `${c.dim}in ${projectPath}${c.reset}` : `${c.dim}(global)${c.reset}`;
  if (!hits.length) {
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
    const text = userPromptSubmitReminder();
    if (text) console.log(text);
    return true;
  }
  if (event === "session-end") {
    runSessionEndIndex();
    return true;
  }
  if (event === "session-start") {
    const text = sessionStartRecovery();
    if (text) console.log(text);
    return true;
  }
  console.error(`${c.red}Unknown hook event: ${event ?? "(none)"}${c.reset}`);
  return false;
}

async function memInstall(): Promise<boolean> {
  const { added, alreadyPresent, resolved } = installMemoryHooks();
  for (const e of added) console.log(`${c.green}✓${c.reset} installed ${e} hook`);
  for (const e of alreadyPresent) console.log(`${c.dim}• ${e} hook already present${c.reset}`);
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
  return true;
}

async function memShare(): Promise<boolean> {
  const area = flagValue(process.argv, "--area");
  const title = flagValue(process.argv, "--title");
  const kind = (flagValue(process.argv, "--kind") ?? "note") as SharedKind;
  const body = flagValue(process.argv, "--body") ?? "";
  const ref = flagValue(process.argv, "--ref");
  if (!area || !title) {
    console.error(
      `${c.red}usage: kit memory share --area <a> --title <t> [--kind decision|convention|how-built|status|security|note] [--body <b>] [--ref <r>]${c.reset}`,
    );
    return false;
  }
  const root = getCurrentProjectRoot();
  try {
    const e = shareEntry(
      root,
      { area, kind, title, body, refs: ref ? [ref] : [] },
      new Date().toISOString(),
    );
    console.log(
      `${c.green}✓${c.reset} shared ${c.bold}${e.id}${c.reset} to area ${c.bold}${area}${c.reset} ${c.dim}(${getSharedPath(root)})${c.reset}`,
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
  const entries = queryArea(getCurrentProjectRoot(), name);
  if (jsonMode) {
    console.log(JSON.stringify(entries));
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
    const prov = `${e.author}${e.source_ref ? ` @${e.source_ref}` : ""}`;
    console.log(`  ${c.bold}[${e.kind}]${c.reset} ${e.title} ${c.dim}— ${prov}${c.reset}`);
    if (e.body) console.log(`    ${e.body}`);
    if (e.refs.length) console.log(`    ${c.dim}refs: ${e.refs.join(", ")}${c.reset}`);
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
