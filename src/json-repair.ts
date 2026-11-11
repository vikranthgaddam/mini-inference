/**
 * Tolerant Streaming JSON Repair Engine
 * Solves the "Malformed Tool Call" problem in Agent Inference.
 * Automatically fixes trailing commas, unclosed brackets, and unclosed quotes.
 */

export function repairAndParseJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  // 1. Try standard JSON parse first
  try {
    return JSON.parse(trimmed);
  } catch {
    // Proceed to repair pipeline
  }

  let cleaned = trimmed;

  // 2. Remove trailing commas before closing braces or brackets: { "a": 1, } -> { "a": 1 }
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");

  // 3. Count unclosed quotes and brackets
  let inString = false;
  let escapeNext = false;
  const stack: string[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === "\\") {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === "{" || char === "[") {
        stack.push(char === "{" ? "}" : "]");
      } else if (char === "}" || char === "]") {
        if (stack.length > 0 && stack[stack.length - 1] === char) {
          stack.pop();
        }
      }
    }
  }

  // 4. Auto-close string if open
  if (inString) {
    cleaned += '"';
  }

  // 5. Close all unclosed brackets/braces in reverse order
  while (stack.length > 0) {
    cleaned += stack.pop();
  }

  // 6. Clean up trailing commas again if closing added one
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");

  try {
    const parsed = JSON.parse(cleaned);
    return typeof parsed === "object" && parsed !== null ? parsed : { value: parsed };
  } catch (err) {
    throw new Error(
      `Failed to auto-repair JSON string: "${raw}"\nIntermediate attempted fix: "${cleaned}"\nError: ${(err as Error).message}`
    );
  }
}
