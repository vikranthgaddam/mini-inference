import { InferenceEngine } from "./engine.ts";

/**
 * Mini-Inference: Interactive CLI Demo
 * Run with: `bun run src/index.ts`
 */
async function main() {
  console.log("\n================================================================================");
  console.log(" 🧠 Mini-Inference: Educational Agent Inference Engine (OpenCode Architecture)");
  console.log("================================================================================\n");

  const engine = new InferenceEngine({
    maxTokens: 2500,
    compactionWatermark: 0.7,
  });

  // 1. Register Mock File System Tools
  const mockFileSystem: Record<string, string> = {
    "src/config.ts": "export const dbConfig = { maxPoolSize: 2, timeoutMs: 5000 };",
  };

  engine.registerTool(
    {
      name: "read_file",
      description: "Read contents of a file on disk",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to file" },
        },
        required: ["path"],
      },
    },
    async (args) => {
      const path = String(args.path);
      const content = mockFileSystem[path];
      if (content !== undefined) {
        console.log(`\n  \x1b[32m✔ [OS Disk Read]\x1b[0m Read ${path} (${content.length} bytes)`);
        return { output: content };
      }
      return { output: `File not found: ${path}`, isError: true };
    }
  );

  engine.registerTool(
    {
      name: "write_file",
      description: "Write content to a file on disk",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to file" },
          content: { type: "string", description: "Full content to write" },
        },
        required: ["path", "content"],
      },
    },
    async (args) => {
      const path = String(args.path);
      const content = String(args.content);
      mockFileSystem[path] = content;
      console.log(`\n  \x1b[32m✔ [OS Disk Write]\x1b[0m Patched ${path} -> "${content}"`);
      return { output: `Successfully wrote ${content.length} bytes to ${path}` };
    }
  );

  // 2. Add System Prompt and Initial User Prompt
  engine.addMessage({
    role: "system",
    content: "You are an autonomous senior software engineering agent. Reason carefully and use tools.",
    pinned: true,
  });

  const prompt = "The web server is dropping connections. Fix the database connection pool in src/config.ts.";
  console.log(`\x1b[1m\x1b[34m[USER PROMPT]:\x1b[0m ${prompt}\n`);

  engine.addMessage({
    role: "user",
    content: prompt,
    pinned: true,
  });

  // 3. Multi-Turn ReAct Loop
  let turnNumber = 1;
  let isFinished = false;

  while (!isFinished && turnNumber <= 5) {
    console.log(`\x1b[90m--- Starting Inference Turn ${turnNumber} ---\x1b[0m`);
    const turn = engine.runTurn();

    let step = await turn.next();
    while (!step.done) {
      const event = step.value;

      switch (event.type) {
        case "thought":
          process.stdout.write(`\x1b[35m${event.text}\x1b[0m`);
          break;
        case "text":
          process.stdout.write(`\x1b[0m${event.text}`);
          break;
        case "tool_start":
          console.log(`\n\n\x1b[36m⚡ [Tool Call Started]: ${event.name} (id: ${event.id})\x1b[0m`);
          break;
        case "tool_chunk":
          process.stdout.write(`\x1b[90m${event.chunk}\x1b[0m`);
          break;
        case "tool_complete":
          console.log(`\n\x1b[36m✔ [Tool Call Parsed & Repaired]:\x1b[0m ${JSON.stringify(event.call.arguments)}`);
          break;
        case "compaction":
          console.log(`\n\x1b[33m🧹 [Context Compactor]: Reduced context from ${event.originalTokens} to ${event.compactedTokens} tokens\x1b[0m`);
          break;
        case "loop_warning":
          console.log(`\n\x1b[31m⚠️  [Loop Breaker]: ${event.message}\x1b[0m`);
          break;
        case "complete":
          console.log(`\n\x1b[90m[Metrics]: Prompt: ${event.usage.promptTokens} | KV-Cache Hit: ${event.usage.cachedTokens} (${Math.round((event.usage.cachedTokens / (event.usage.promptTokens || 1)) * 100)}%) | Output: ${event.usage.completionTokens}\x1b[0m\n`);
          break;
      }

      step = await turn.next();
    }

    isFinished = step.value.finished;
    turnNumber++;
  }

  console.log("\n================================================================================");
  console.log(" ✅ Agent Task Complete! Verify Final State:");
  console.log(`    src/config.ts = "${mockFileSystem["src/config.ts"]}"`);
  console.log("================================================================================\n");
}

main().catch(console.error);
