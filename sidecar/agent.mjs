import { loadProvider } from "./providers/index.mjs";
import { getTools } from "./tools/registry.mjs";
import { emit } from "./utils/ndjson.mjs";

export async function runAgent(request) {
  const { provider: providerConfig, systemPrompt, tools: toolIds, context } = request;
  const provider = loadProvider(providerConfig);
  const tools = getTools(toolIds);
  const toolCtx = {
    projectRoot: context.projectRoot,
    activeFilePath: context.activeFilePath,
    sessionId: request.sessionId,
  };

  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: buildUserMessage(context),
    },
  ];

  const maxToolRounds = 10;
  let round = 0;

  while (round < maxToolRounds) {
    round += 1;
    let hasToolCalls = false;
    let textAccum = "";
    const pendingToolCalls = [];

    try {
      for await (const chunk of provider.chat({ messages, tools })) {
        if (chunk.type === "text") {
          emit({ type: "text_delta", content: chunk.text });
          textAccum += chunk.text;
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

    const assistantMessage = {
      role: "assistant",
      content: textAccum || null,
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

    for (const call of pendingToolCalls) {
      emit({ type: "tool_call_start", toolId: call.name, args: call.args });

      const tool = tools.find((item) => item.id === call.name);
      if (!tool) {
        const errMsg = `Unknown tool: ${call.name}`;
        emit({ type: "tool_call_result", toolId: call.name, output: errMsg });
        messages.push({ role: "tool", tool_call_id: call.id, content: errMsg });
        continue;
      }

      try {
        const result = await tool.execute(call.args, toolCtx);
        emit({ type: "tool_call_result", toolId: call.name, output: result.output });

        if (result.sideEffects) {
          for (const effect of result.sideEffects) {
            if (effect.type === "file_changed") {
              emit({
                type: "patch",
                filePath: effect.filePath,
                startLine: 0,
                endLine: 0,
                newContent: effect.content,
              });
            }
          }
        }

        messages.push({ role: "tool", tool_call_id: call.id, content: result.output });
      } catch (error) {
        const errMsg = `Tool error: ${error?.message || String(error)}`;
        emit({ type: "tool_call_result", toolId: call.name, output: errMsg });
        messages.push({ role: "tool", tool_call_id: call.id, content: errMsg });
      }
    }
  }

  emit({ type: "done", usage: provider.getUsage() });
}

function buildUserMessage(context) {
  const parts = [];
  if (context.selectedText) {
    parts.push(`## Selected Text\n\n${context.selectedText}`);
  }
  parts.push(`## Current File: ${context.activeFilePath}\n\n${context.fullFileContent}`);
  parts.push(`## Cursor Position: Line ${context.cursorLine}`);
  return parts.join("\n\n---\n\n");
}
