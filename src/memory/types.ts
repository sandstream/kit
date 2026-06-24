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
  /** Input tokens served from the prompt cache (cheap reads). */
  cacheReadTokens?: number;
  /** Input tokens written to the prompt cache (one-time cost). */
  cacheCreationTokens?: number;
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
  /** Token economy distilled from the indexed transcripts (see summarizeTokens). */
  tokens: TokenSummary & {
    perSession: number;
    perMessage: number;
    /** Top models by message volume, with their token totals. */
    byModel: { model: string; messages: number; inputTokens: number; outputTokens: number }[];
  };
  /** Recall usage — how often the store is actually searched (query_log). */
  recalls: {
    total: number;
    last7d: number;
    distinctQueries: number;
    topTerms: { query: string; count: number }[];
  };
  /** Logical vs sidechain session split + raw transcript files indexed.
   *  Exposes the "N files → M logical sessions" collapse. */
  sessionsBreakdown: { logical: number; sidechain: number; filesIndexed: number };
}

/** Token totals summed across messages — the raw inputs to summarizeTokens. */
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Derived token economy: totals + ratios. cacheHitRatio is null when no cache data. */
export interface TokenSummary extends TokenTotals {
  /** input + output (the content tokens generated/consumed). */
  totalTokens: number;
  /** cacheRead / (input + cacheRead + cacheCreation): fraction of input served from cache. */
  cacheHitRatio: number | null;
}
