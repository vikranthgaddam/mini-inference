import type { StreamEvent, ToolCall } from "./types.ts";
import { repairAndParseJson } from "./json-repair.ts";

/**
 * Streaming Token Demuxer
 * Dissects raw incoming LLM token streams in real-time into:
 *  - Thought / Extended Reasoning tokens
 *  - Assistant conversational markdown
 *  - Tool invocation arguments with streaming auto-repair
 */
export class TokenDemuxer {
  private buffer = "";
  private state: "text" | "thought" | "tool" = "text";
  private currentToolId = "";
  private currentToolName = "";
  private toolBuffer = "";

  private readonly TAG_THOUGHT_OPEN = "<thought>";
  private readonly TAG_THOUGHT_CLOSE = "</thought>";
  private readonly TAG_TOOL_PREFIX = "<tool_call name=\"";
  private readonly TAG_TOOL_CLOSE = "</tool_call>";

  private getPartialPrefixLength(str: string, target: string): number {
    for (let len = Math.min(str.length, target.length - 1); len > 0; len--) {
      if (str.endsWith(target.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }

  *feed(chunk: string): Generator<StreamEvent> {
    this.buffer += chunk;

    let progressed = true;
    while (progressed && this.buffer.length > 0) {
      progressed = false;

      if (this.state === "text") {
        const thoughtStart = this.buffer.indexOf(this.TAG_THOUGHT_OPEN);
        const toolStart = this.buffer.indexOf(this.TAG_TOOL_PREFIX);

        if (thoughtStart !== -1 && (toolStart === -1 || thoughtStart < toolStart)) {
          const before = this.buffer.slice(0, thoughtStart);
          if (before) yield { type: "text", text: before };
          this.buffer = this.buffer.slice(thoughtStart + this.TAG_THOUGHT_OPEN.length);
          this.state = "thought";
          progressed = true;
          continue;
        }

        if (toolStart !== -1 && (thoughtStart === -1 || toolStart < thoughtStart)) {
          const closingQuote = this.buffer.indexOf("\">", toolStart + this.TAG_TOOL_PREFIX.length);
          if (closingQuote !== -1) {
            const before = this.buffer.slice(0, toolStart);
            if (before) yield { type: "text", text: before };

            this.currentToolName = this.buffer.slice(toolStart + this.TAG_TOOL_PREFIX.length, closingQuote);
            this.currentToolId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            this.toolBuffer = "";
            this.buffer = this.buffer.slice(closingQuote + 2);
            this.state = "tool";

            yield {
              type: "tool_start",
              id: this.currentToolId,
              name: this.currentToolName,
            };
            progressed = true;
            continue;
          } else {
            // Opening tag started, but `\">` has not arrived yet.
            // Emit anything before `toolStart` as text, and hold the rest in the buffer.
            const before = this.buffer.slice(0, toolStart);
            if (before) yield { type: "text", text: before };
            this.buffer = this.buffer.slice(toolStart);
            break; // Wait for more tokens
          }
        }

        // Check if the buffer ends with a potential opening tag prefix
        const p1 = this.getPartialPrefixLength(this.buffer, this.TAG_THOUGHT_OPEN);
        const p2 = this.getPartialPrefixLength(this.buffer, this.TAG_TOOL_PREFIX);
        const holdBack = Math.max(p1, p2);

        if (holdBack > 0) {
          const safeToEmit = this.buffer.slice(0, this.buffer.length - holdBack);
          if (safeToEmit) {
            yield { type: "text", text: safeToEmit };
            this.buffer = this.buffer.slice(this.buffer.length - holdBack);
          }
          break; // Wait for next token to resolve tag
        } else {
          yield { type: "text", text: this.buffer };
          this.buffer = "";
        }
      } else if (this.state === "thought") {
        const thoughtEnd = this.buffer.indexOf(this.TAG_THOUGHT_CLOSE);
        if (thoughtEnd !== -1) {
          const thoughtText = this.buffer.slice(0, thoughtEnd);
          if (thoughtText) yield { type: "thought", text: thoughtText };
          this.buffer = this.buffer.slice(thoughtEnd + this.TAG_THOUGHT_CLOSE.length);
          this.state = "text";
          progressed = true;
        } else {
          const holdBack = this.getPartialPrefixLength(this.buffer, this.TAG_THOUGHT_CLOSE);
          if (holdBack > 0) {
            const safeToEmit = this.buffer.slice(0, this.buffer.length - holdBack);
            if (safeToEmit) {
              yield { type: "thought", text: safeToEmit };
              this.buffer = this.buffer.slice(this.buffer.length - holdBack);
            }
            break;
          } else {
            yield { type: "thought", text: this.buffer };
            this.buffer = "";
          }
        }
      } else if (this.state === "tool") {
        const toolEnd = this.buffer.indexOf(this.TAG_TOOL_CLOSE);
        if (toolEnd !== -1) {
          const toolChunk = this.buffer.slice(0, toolEnd);
          this.toolBuffer += toolChunk;
          this.buffer = this.buffer.slice(toolEnd + this.TAG_TOOL_CLOSE.length);

          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = repairAndParseJson(this.toolBuffer);
          } catch {
            parsedArgs = { raw: this.toolBuffer };
          }

          const call: ToolCall = {
            id: this.currentToolId,
            name: this.currentToolName,
            arguments: parsedArgs,
            rawJson: this.toolBuffer,
          };

          yield { type: "tool_complete", call };
          this.state = "text";
          progressed = true;
        } else {
          const holdBack = this.getPartialPrefixLength(this.buffer, this.TAG_TOOL_CLOSE);
          if (holdBack > 0) {
            const safeToEmit = this.buffer.slice(0, this.buffer.length - holdBack);
            if (safeToEmit) {
              this.toolBuffer += safeToEmit;
              yield {
                type: "tool_chunk",
                id: this.currentToolId,
                chunk: safeToEmit,
              };
              this.buffer = this.buffer.slice(this.buffer.length - holdBack);
            }
            break;
          } else {
            this.toolBuffer += this.buffer;
            yield {
              type: "tool_chunk",
              id: this.currentToolId,
              chunk: this.buffer,
            };
            this.buffer = "";
          }
        }
      }
    }
  }

  *flush(): Generator<StreamEvent> {
    if (this.buffer.length > 0) {
      if (this.state === "thought") {
        yield { type: "thought", text: this.buffer };
      } else if (this.state === "tool") {
        const parsed = repairAndParseJson(this.toolBuffer + this.buffer);
        yield {
          type: "tool_complete",
          call: {
            id: this.currentToolId,
            name: this.currentToolName,
            arguments: parsed,
          },
        };
      } else {
        yield { type: "text", text: this.buffer };
      }
      this.buffer = "";
    }
  }
}
