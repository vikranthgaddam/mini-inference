import type {
  Message,
  ToolDefinition,
  ToolHandler,
  StreamEvent,
  TokenUsage,
} from "./types.ts";
import { TokenDemuxer } from "./demuxer.ts";
import { ContextCompactor } from "./compactor.ts";
import { LoopBreaker } from "./loop-breaker.ts";
import { MockSimulatorProvider, type ProviderAdapter } from "./providers.ts";

export interface EngineConfig {
  maxTokens?: number;
  compactionWatermark?: number;
  provider?: ProviderAdapter;
}

/**
 * Mini-Inference: Core Agent Reasoning & Orchestration Engine
 * Implements the full ReAct inference lifecycle inspired by OpenCode:
 *  - KV-Cache aware message history
 *  - Token demuxer (Thought vs Text vs Tool Call)
 *  - Auto-repair streaming JSON parser
 *  - Circuit breaker loop prevention
 *  - Background context compactor
 */
export class InferenceEngine {
  private messages: Message[] = [];
  private tools: Map<string, { definition: ToolDefinition; handler: ToolHandler }> = new Map();
  private compactor: ContextCompactor;
  private loopBreaker: LoopBreaker;
  private provider: ProviderAdapter;

  constructor(config: EngineConfig = {}) {
    this.compactor = new ContextCompactor(config.maxTokens ?? 3000, config.compactionWatermark ?? 0.7);
    this.loopBreaker = new LoopBreaker(3);
    this.provider = config.provider ?? new MockSimulatorProvider();
  }

  registerTool(definition: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(definition.name, { definition, handler });
  }

  getMessages(): readonly Message[] {
    return this.messages;
  }

  addMessage(msg: Message): void {
    this.messages.push(msg);
  }

  /**
   * Executes a single turn of the agent reasoning loop.
   * Yields StreamEvents as tokens and tools are processed.
   */
  async *runTurn(): AsyncGenerator<StreamEvent, { finished: boolean }> {
    // 1. Context Compaction Check
    const compactionResult = this.compactor.compact(this.messages);
    if (compactionResult.didCompact) {
      this.messages = compactionResult.messages;
      yield {
        type: "compaction",
        originalTokens: compactionResult.savedTokens + this.compactor.calculateTotalTokens(this.messages),
        compactedTokens: this.compactor.calculateTotalTokens(this.messages),
      };
    }

    // 2. Prepare Tool Definitions
    const toolDefs = Array.from(this.tools.values()).map((t) => t.definition);

    // 3. Initiate Provider Stream
    const stream = this.provider.streamCompletion(this.messages, toolDefs);
    const demuxer = new TokenDemuxer();

    let fullText = "";
    let fullThought = "";
    const executedCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];

    // 4. Stream and Demux Tokens
    let streamResult = await stream.next();
    while (!streamResult.done) {
      const chunk = streamResult.value;
      for (const event of demuxer.feed(chunk)) {
        if (event.type === "text") fullText += event.text;
        if (event.type === "thought") fullThought += event.text;

        if (event.type === "tool_complete") {
          executedCalls.push({
            id: event.call.id,
            name: event.call.name,
            args: event.call.arguments,
          });
        }
        yield event;
      }
      streamResult = await stream.next();
    }

    // Flush any remaining buffered tokens in demuxer
    for (const event of demuxer.flush()) {
      if (event.type === "text") fullText += event.text;
      if (event.type === "thought") fullThought += event.text;
      if (event.type === "tool_complete") {
        executedCalls.push({
          id: event.call.id,
          name: event.call.name,
          args: event.call.arguments,
        });
      }
      yield event;
    }

    const usage: TokenUsage = streamResult.value?.usage ?? {
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
    };
    yield { type: "complete", usage };

    // 5. Append Assistant Message to History
    this.messages.push({
      role: "assistant",
      content: fullText,
      thought: fullThought || undefined,
      toolCalls: executedCalls.map((c) => ({
        id: c.id,
        name: c.name,
        arguments: c.args,
      })),
    });

    // If no tools were called, the turn is complete!
    if (executedCalls.length === 0) {
      return { finished: true };
    }

    // 6. Execute Discovered Tools
    for (const call of executedCalls) {
      // Loop Breaker Check
      const loopCheck = this.loopBreaker.recordAndCheck({
        id: call.id,
        name: call.name,
        arguments: call.args,
      });

      if (loopCheck.isLoop && loopCheck.warning) {
        yield { type: "loop_warning", message: loopCheck.warning };
        this.messages.push({
          role: "user",
          content: loopCheck.warning,
          toolCallId: call.id,
        });
        continue;
      }

      const registered = this.tools.get(call.name);
      if (!registered) {
        this.messages.push({
          role: "tool",
          content: `Error: Tool '${call.name}' not found. Available tools: ${Array.from(this.tools.keys()).join(", ")}`,
          toolCallId: call.id,
        });
        continue;
      }

      // Execute Tool Handler
      try {
        const result = await registered.handler(call.args);
        this.messages.push({
          role: "tool",
          content: result.output,
          toolCallId: call.id,
        });
      } catch (err) {
        this.messages.push({
          role: "tool",
          content: `Execution Failure: ${(err as Error).message}`,
          toolCallId: call.id,
        });
      }
    }

    return { finished: false };
  }
}
