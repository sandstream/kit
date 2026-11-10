import type { Content } from "./content.js";
import { nativeToolOutcome, type TranscriptTools } from "./transcript-tools.js";

/** Capture native Claude call identifiers without placing response bodies in recall. */
export function captureClaudeTools(
  tools: TranscriptTools,
  content: Content,
  parent: { uuid: string; sessionId: string; timestamp?: string; added: boolean },
): void {
  if (!Array.isArray(content)) {
    if (typeof content !== "string") tools.complete = false;
    return;
  }
  let ordinal = 0;
  for (const block of content) {
    if (block?.type === "tool_use") {
      if (!block.name) tools.complete = false;
      tools.call(
        {
          messageUuid: parent.uuid,
          sessionId: parent.sessionId,
          toolName: block.name ?? "unknown",
          toolInput: block.input === undefined ? "" : JSON.stringify(block.input),
          timestamp: parent.timestamp,
          callId: typeof block.id === "string" ? block.id : undefined,
          ordinal: ordinal++,
        },
        parent.added,
      );
    } else if (block?.type === "tool_result") {
      tools.result(
        parent.sessionId,
        block.tool_use_id,
        nativeToolOutcome({ is_error: block.is_error }),
        parent.timestamp,
      );
    } else if (
      !block ||
      !["text", "thinking", "redacted_thinking", "image", "document"].includes(block.type ?? "")
    ) {
      tools.complete = false;
    }
  }
}
