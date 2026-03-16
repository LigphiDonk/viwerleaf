import { loadProvider } from "./providers/index.mjs";
import { getTools, resolveActiveTools } from "./tools/registry.mjs";
import { trimHistory } from "./utils/context.mjs";
import { computeDiff, diffStats } from "./utils/diff.mjs";
import { emit } from "./utils/ndjson.mjs";

export async function runAgent(request) {
  await runLegacyAgent(request);
}

async function runLegacyAgent(request) {
  const { provider: providerConfig, systemPrompt, tools: toolIds, context } = request;
  const provider = loadProvider(providerConfig);
  const discoveredToolIds = new Set();
  const toolCtx = {
    projectRoot: context.projectRoot,
    activeFilePath: context.activeFilePath,
    sessionId: request.sessionId,
    userMessage: request.userMessage,
    requestedToolIds: toolIds,
  };

  const messages = [{ role: "system", content: systemPrompt }];
  const history = Array.isArray(request.history) ? request.history : [];
  for (const item of history) {
    if (!item || typeof item.content !== "string") {
      continue;
    }
    if (item.role !== "user" && item.role !== "assistant") {
      continue;
    }
    messages.push({ role: item.role, content: item.content });
  }
  messages.push({
    role: "user",
    content: buildUserMessage(context, request.userMessage),
  });

  const maxToolRounds = 25;
  let round = 0;

  while (round < maxToolRounds) {
    round += 1;
    if (round > 1) {
      const trimmed = [...trimHistory(messages, providerConfig.model || "")];
      messages.splice(0, messages.length, ...trimmed);
    }
    const resolved = resolveActiveTools({
        requestedToolIds: toolIds,
        userMessage: request.userMessage,
        context,
        discoveredToolIds: [...discoveredToolIds],
      });
    const { tools, toolIds: activeToolIds } = resolved;
    const allowedTools = getTools(toolIds);
    let hasToolCalls = false;
    let textAccum = "";
    const pendingToolCalls = [];

    try {
      for await (const chunk of provider.chat({ messages, tools })) {
        if (chunk.type === "text") {
          textAccum += chunk.text;
          emit({ type: "text_delta", content: chunk.text });
        } else if (chunk.type === "thinking") {
          emit({ type: "thinking_delta", content: chunk.text });
        } else if (chunk.type === "thinking_start") {
          emit({ type: "thinking_clear" });
        } else if (chunk.type === "thinking_end") {
          emit({ type: "thinking_commit" });
        } else if (chunk.type === "tool_call") {
          hasToolCalls = true;
          pendingToolCalls.push(chunk);
        }
      }
    } catch (error) {
      emit({ type: "error", message: error?.message || String(error) });
      break;
    }

    if (textAccum) {
      messages.push({ role: "assistant", content: textAccum });
    }

    if (!hasToolCalls) {
      break;
    }

    const usesTaggedToolTranscript = pendingToolCalls.some((call) => call.source === "tagged");
    const toolTranscriptBlocks = [];

    if (!usesTaggedToolTranscript) {
      const assistantMessage = {
        role: "assistant",
        content: textAccum || "",
        tool_calls: pendingToolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args),
          },
        })),
      };

      if (textAccum) {
        messages.pop();
      }
      messages.push(assistantMessage);
    }

    // Separate read-only and write tools for parallel vs sequential execution
    const WRITE_TOOL_IDS = new Set(["edit", "write", "apply_patch", "apply_text_patch", "insert_at_line", "bash"]);
    const readCalls = [];
    const writeCalls = [];
    for (const call of pendingToolCalls) {
      if (WRITE_TOOL_IDS.has(call.name)) {
        writeCalls.push(call);
      } else {
        readCalls.push(call);
      }
    }

    // Helper to execute a single tool call
    const executeSingle = async (call) => {
      emit({ type: "tool_call_start", toolId: call.name, args: call.args });
      const tool = tools.find((item) => item.id === call.name) || allowedTools.find((item) => item.id === call.name);
      if (!tool) {
        const errMsg = `Unknown tool: ${call.name}. Active tools: ${activeToolIds.join(", ")}. Allowed tools: ${toolIds.join(", ")}`;
        emit({ type: "tool_call_result", toolId: call.name, output: errMsg, status: "error" });
        if (usesTaggedToolTranscript) {
          toolTranscriptBlocks.push(formatToolTranscriptBlock(call, errMsg));
        } else {
          messages.push({ role: "tool", tool_call_id: call.id, content: errMsg });
        }
        return;
      }

      try {
        const result = await tool.execute(call.args, {
          ...toolCtx,
          activeToolIds,
          discoveredToolIds: [...discoveredToolIds],
        });
        const contextOutput = truncateToolOutputForContext(call.name, result.output);
        if (Array.isArray(result?.metadata?.discoveredToolIds)) {
          for (const toolId of result.metadata.discoveredToolIds) {
            discoveredToolIds.add(toolId);
          }
        }
        emit({ type: "tool_call_result", toolId: call.name, output: result.output, status: "completed" });

        if (result.sideEffects) {
          for (const effect of result.sideEffects) {
            if (effect.type === "file_changed") {
              const diff = effect.oldContent != null
                ? computeDiff(effect.oldContent, effect.content)
                : undefined;
              emit({
                type: "patch",
                filePath: effect.filePath,
                startLine: 0,
                endLine: 0,
                newContent: effect.content,
                diff,
              });
            }
          }
        }

        if (usesTaggedToolTranscript) {
          toolTranscriptBlocks.push(formatToolTranscriptBlock(call, contextOutput));
        } else {
          messages.push({ role: "tool", tool_call_id: call.id, content: contextOutput });
        }
      } catch (error) {
        const errMsg = `Tool error: ${error?.message || String(error)}`;
        emit({ type: "tool_call_result", toolId: call.name, output: errMsg, status: "error" });
        if (usesTaggedToolTranscript) {
          toolTranscriptBlocks.push(formatToolTranscriptBlock(call, errMsg));
        } else {
          messages.push({ role: "tool", tool_call_id: call.id, content: errMsg });
        }
      }
    };

    // Execute read-only tools in parallel
    if (readCalls.length > 0) {
      await Promise.allSettled(readCalls.map(executeSingle));
    }

    // Execute write tools sequentially
    for (const call of writeCalls) {
      await executeSingle(call);
    }

    if (usesTaggedToolTranscript && toolTranscriptBlocks.length > 0) {
      messages.push({
        role: "user",
        content: `${toolTranscriptBlocks.join("\n\n")}\n\nContinue using these tool results and answer the user's latest request directly.`,
      });
    }
  }

  emit({ type: "done", usage: provider.getUsage() });
}

function buildUserMessage(context, userMessage) {
  const parts = [];
  if (typeof userMessage === "string" && userMessage.trim()) {
    parts.push(userMessage.trim());
  }
  if (context.activeFilePath) {
    parts.push(`Current active file: ${context.activeFilePath}`);
  }
  if (context.selectedText) {
    parts.push(`\`\`\`\n${context.selectedText}\n\`\`\``);
  }
  return parts.join("\n\n") || "Hello";
}

function formatToolTranscriptBlock(call, output) {
  const args = call?.args && Object.keys(call.args).length > 0
    ? ` ${JSON.stringify(call.args)}`
    : "";
  return `Tool result for ${call.name}${args}:\n${output}`;
}

function truncateToolOutputForContext(toolName, output) {
  const raw = typeof output === "string" ? output : String(output ?? "");
  const maxChars = ["list", "glob", "search_project", "grep"].includes(toolName) ? 4000 : 12000;
  const maxLines = ["list", "glob"].includes(toolName) ? 80 : 180;
  const lines = raw.split("\n");
  const clippedLines = lines.slice(0, maxLines).join("\n");

  if (clippedLines.length <= maxChars && lines.length <= maxLines) {
    return clippedLines;
  }

  const clippedChars = clippedLines.slice(0, maxChars);
  const suffix = raw.length > clippedChars.length || lines.length > maxLines
    ? `\n\n[tool output truncated: ${Math.max(0, raw.length - clippedChars.length)} chars omitted]`
    : "";
  return `${clippedChars}${suffix}`.trim();
}
