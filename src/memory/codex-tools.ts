import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { insertMessage } from "./db.js";
import { nativeToolOutcome, type TranscriptTools } from "./transcript-tools.js";

/** Tool parents use a separate namespace so existing turn identifiers do not move. */
export function captureCodexTool(
  db: DatabaseSync,
  tools: TranscriptTools,
  payload: Record<string, unknown>,
  parent: { sessionId: string; timestamp?: string; cwd?: string },
): number {
  const type = payload.type;
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    if (!("output" in payload)) tools.complete = false;
    tools.result(
      parent.sessionId,
      payload.call_id,
      "output" in payload ? nativeToolOutcome(payload) : "unknown",
      parent.timestamp,
    );
    return 0;
  }
  if (type !== "function_call" && type !== "custom_tool_call") {
    if (type !== "reasoning" && type !== "compaction") tools.complete = false;
    return 0;
  }
  const request = nativeRequest(payload);
  if (!request) {
    tools.complete = false;
    return 0;
  }
  const { callId, name, input } = request;
  // These wrappers can dispatch tools absent from the native rollout records.
  // Keep the outer call, but do not infer that nested tools were unused.
  if (/^(?:functions\.)?(?:exec|parallel)$/.test(name) || name === "multi_tool_use.parallel") {
    tools.complete = false;
  }
  const uuid = `codex-tool:${parent.sessionId}:${createHash("sha256").update(callId).digest("hex")}`;
  const added = insertMessage(db, {
    uuid,
    sessionId: parent.sessionId,
    type: "assistant",
    role: "assistant",
    content: `[Tool: ${name}]`,
    timestamp: parent.timestamp,
    cwd: parent.cwd,
  });
  tools.message(uuid, parent.sessionId);
  tools.call(
    {
      messageUuid: uuid,
      sessionId: parent.sessionId,
      callId,
      toolName: name,
      toolInput: input,
      timestamp: parent.timestamp,
      ordinal: 0,
    },
    added,
  );
  return added ? 1 : 0;
}

function nativeRequest(
  payload: Record<string, unknown>,
): { callId: string; name: string; input: string } | undefined {
  const callId = payload.call_id;
  const name = payload.name;
  const input = payload.type === "function_call" ? payload.arguments : payload.input;
  if (
    typeof callId !== "string" ||
    !callId ||
    typeof name !== "string" ||
    !name ||
    typeof input !== "string"
  ) {
    return undefined;
  }
  return { callId, name, input };
}
