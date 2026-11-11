import type { Message, ToolDefinition, TokenUsage } from "./types.ts";

export interface ProviderAdapter {
  name: string;
  streamCompletion(
    messages: Message[],
    tools: ToolDefinition[],
    options?: { temperature?: number; maxTokens?: number }
  ): AsyncGenerator<string, { usage: TokenUsage }>;
}

/**
 * Educational Mock Provider
 * Simulates a realistic multi-turn reasoning agent with:
 *  - Extended thinking tokens (<thought>...</thought>)
 *  - Streaming tool calls (<tool_call name="...">...</tool_call>)
 *  - Deliberately malformed JSON with trailing commas to test the Auto-Repair parser
 *  - Prompt caching KV metrics
 */
export class MockSimulatorProvider implements ProviderAdapter {
  name = "mock-agent-simulator";

  async *streamCompletion(
    messages: Message[],
    _tools: ToolDefinition[]
  ): AsyncGenerator<string, { usage: TokenUsage }> {
    const lastMsg = messages[messages.length - 1];

    let simulationScript: string[] = [];

    if (lastMsg.role === "user") {
      // Turn 1: Model thinks, explains plan, and calls `read_file` with slightly malformed JSON (trailing comma)
      simulationScript = [
        "<thought>The user wants me to fix the database connection pool in config.ts. First, I need to inspect the current configuration file.</thought>",
        "I'll start by reading `config.ts` to check the current connection pool settings.\n\n",
        "<tool_call name=\"read_file\">",
        "{\n  \"path\": \"src/config.ts\",\n  \"encoding\": \"utf-8\",\n}", // Trailing comma!
        "</tool_call>",
      ];
    } else if (lastMsg.role === "tool" && lastMsg.content.includes("maxPoolSize: 2")) {
      // Turn 2: Model observed file output, realizes pool size is too small, writes surgical patch
      simulationScript = [
        "<thought>I have read config.ts. The maxPoolSize is set to 2, which causes connection timeouts under load. I will patch it to 20.</thought>",
        "The connection pool size is currently restricted to 2. I will apply a patch to increase the limit to 20 connections.\n\n",
        "<tool_call name=\"write_file\">",
        "{\n  \"path\": \"src/config.ts\",\n  \"content\": \"export const dbConfig = { maxPoolSize: 20, timeoutMs: 5000 };\"\n}",
        "</tool_call>",
      ];
    } else {
      // Turn 3: Final confirmation (no tools called -> finished!)
      simulationScript = [
        "<thought>The file write has succeeded. I will report the final status to the user.</thought>",
        "The configuration in `src/config.ts` has been successfully updated! The database connection pool is now configured to handle up to 20 concurrent connections with a 5000ms timeout.",
      ];
    }

    // Yield chunks with small async delays to simulate network streaming
    for (const chunk of simulationScript) {
      // Split into smaller subchunks to simulate real token streaming
      for (let i = 0; i < chunk.length; i += 8) {
        yield chunk.slice(i, i + 8);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    // Return token usage with KV Cache hit simulation
    const promptTokens = messages.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0);
    const cachedTokens = Math.floor(promptTokens * 0.7); // Simulate 70% KV cache reuse!

    return {
      usage: {
        promptTokens,
        completionTokens: 85,
        cachedTokens,
        totalTokens: promptTokens + 85,
      },
    };
  }
}
