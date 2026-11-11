import type { ToolCall } from "./types.ts";

/**
 * Loop Circuit Breaker
 * Detects repetitive / infinite hallucination loops when the model
 * keeps retrying the exact same failed command or file edit.
 */
export class LoopBreaker {
  private history: string[] = [];
  private maxRepeatThreshold: number;

  constructor(maxRepeatThreshold = 3) {
    this.maxRepeatThreshold = maxRepeatThreshold;
  }

  /**
   * Generates a stable signature for a tool call
   */
  private hashCall(call: ToolCall): string {
    return `${call.name}:${JSON.stringify(call.arguments)}`;
  }

  /**
   * Records a tool call and checks whether an infinite loop has been triggered.
   * Returns an intervention warning message if a loop is detected.
   */
  recordAndCheck(call: ToolCall): { isLoop: boolean; warning?: string } {
    const signature = this.hashCall(call);
    this.history.push(signature);

    // Keep history bounded to last 10 calls
    if (this.history.length > 10) {
      this.history.shift();
    }

    // Count occurrences of this exact call in the recent window
    const count = this.history.filter((sig) => sig === signature).length;

    if (count >= this.maxRepeatThreshold) {
      return {
        isLoop: true,
        warning: `CIRCUIT BREAKER: You have executed tool '${call.name}' with identical parameters ${count} times in a row. Stop repeating this action. Analyze previous error messages, reconsider your approach, or explain the roadblock to the user.`,
      };
    }

    return { isLoop: false };
  }

  reset(): void {
    this.history = [];
  }
}
