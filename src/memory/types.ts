/**
 * kit memory — shared types for the local conversation store.
 */

export interface SessionInput {
  sessionId: string;
  /** Which agent harness produced the session: claude-code | codex | cursor | … */
  harness: string;
  project?: string;
  firstMessageAt?: string;
  lastMessageAt?: string;
  isAgentSidechain?: boolean;
}

export interface MessageInput {
  /** Stable id from the transcript — used for idempotent upsert (one row per message). */
  uuid: string;
  sessionId: string;
  parentUuid?: string;
  /** Transcript event type, e.g. "user" | "assistant". */
  type: string;
  role?: string;
  content?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
}

export interface ToolUseInput {
  messageUuid?: string;
  sessionId?: string;
  toolName: string;
  toolInput?: string;
  timestamp?: string;
}

export interface SearchHit {
  id: number;
  uuid: string | null;
  sessionId: string;
  role: string | null;
  content: string | null;
  timestamp: string | null;
}

export interface MemoryStats {
  sessions: number;
  messages: number;
  toolUses: number;
  pendingOpen: number;
  dbPath: string;
  sizeBytes: number;
  /** Session count per harness (claude-code, codex, gemini, …), descending.
   *  This is the portability proof: it shows the store spans agents, so the
   *  externalized state is not locked to one tool. */
  byHarness: { harness: string; sessions: number }[];
}
