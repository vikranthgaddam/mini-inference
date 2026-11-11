import type { Message } from "./types.ts";

/**
 * Context Compactor & Memory Manager
 * Emulates OpenCode's packages/core context compaction pipeline.
 * Prunes obsolete tool outputs, folds older turns, and respects pinned context.
 */
export class ContextCompactor {
  private maxTokens: number;
  private watermark: number;

  constructor(maxTokens = 4000, watermark = 0.75) {
    this.maxTokens = maxTokens;
    this.watermark = watermark;
  }

  /**
   * Fast token estimation heuristic (approx 4 chars per token)
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  calculateTotalTokens(messages: Message[]): number {
    return messages.reduce((acc, m) => {
      let tokens = this.estimateTokens(m.content);
      if (m.thought) tokens += this.estimateTokens(m.thought);
      if (m.toolCalls) {
        tokens += this.estimateTokens(JSON.stringify(m.toolCalls));
      }
      return acc + tokens;
    }, 0);
  }

  /**
   * Compacts conversation history if it exceeds the watermark limit.
   */
  compact(messages: Message[]): { messages: Message[]; didCompact: boolean; savedTokens: number } {
    const initialTokens = this.calculateTotalTokens(messages);
    const threshold = this.maxTokens * this.watermark;

    if (initialTokens <= threshold) {
      return { messages, didCompact: false, savedTokens: 0 };
    }

    // Step 1: Prune oversized tool outputs from older turns
    const prunedMessages: Message[] = messages.map((msg, idx) => {
      // Don't prune the latest 2 messages or pinned messages
      if (idx >= messages.length - 2 || msg.pinned) {
        return msg;
      }

      // If it's a tool output message exceeding 200 chars, prune it
      if (msg.role === "tool" && msg.content.length > 200) {
        const preview = msg.content.slice(0, 80);
        return {
          ...msg,
          content: `${preview}...\n[Output truncated from ${msg.content.length} chars to preserve context budget]`,
        };
      }

      return msg;
    });

    let currentTokens = this.calculateTotalTokens(prunedMessages);
    if (currentTokens <= threshold) {
      return {
        messages: prunedMessages,
        didCompact: true,
        savedTokens: initialTokens - currentTokens,
      };
    }

    // Step 2: Summarize and fold early unpinned messages
    const pinned: Message[] = [];
    const unpinnedToFold: Message[] = [];
    const recentMessages: Message[] = [];

    // Keep last 4 turns untouched
    const splitIndex = Math.max(0, prunedMessages.length - 4);

    prunedMessages.forEach((msg, idx) => {
      if (msg.pinned) {
        pinned.push(msg);
      } else if (idx < splitIndex) {
        unpinnedToFold.push(msg);
      } else {
        recentMessages.push(msg);
      }
    });

    if (unpinnedToFold.length > 0) {
      const summaryContent = unpinnedToFold
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 100).replace(/\n/g, " ")}`)
        .join("\n");

      const checkpointMessage: Message = {
        role: "system",
        content: `=== CONTEXT CHECKPOINT: SUMMARY OF ${unpinnedToFold.length} PREVIOUS TURNS ===\n${summaryContent}\n======================================================`,
        pinned: true,
      };

      const finalMessages = [...pinned, checkpointMessage, ...recentMessages];
      const finalTokens = this.calculateTotalTokens(finalMessages);

      return {
        messages: finalMessages,
        didCompact: true,
        savedTokens: initialTokens - finalTokens,
      };
    }

    return {
      messages: prunedMessages,
      didCompact: true,
      savedTokens: initialTokens - currentTokens,
    };
  }
}
