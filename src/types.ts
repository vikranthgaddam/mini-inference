/**
 * Core Data Models & Schemas for Mini-Inference
 * Inspired by OpenCode's packages/core/src/bus/
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, {
      type: string;
      description?: string;
      enum?: string[];
    }>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawJson?: string;
}

export interface Message {
  role: Role;
  content: string;
  thought?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  pinned?: boolean; // Pinned messages are never pruned by the Context Compactor
  estimatedTokens?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number; // Tokens read from KV Cache (Prompt Caching)
  totalTokens: number;
}

export type StreamEvent =
  | { type: "thought"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_chunk"; id: string; chunk: string }
  | { type: "tool_complete"; call: ToolCall }
  | { type: "loop_warning"; message: string }
  | { type: "compaction"; originalTokens: number; compactedTokens: number }
  | { type: "complete"; usage: TokenUsage };

export interface ToolHandler {
  (args: Record<string, unknown>): Promise<{ output: string; isError?: boolean }>;
}
