import OpenAI from "openai";

export function createOpenAIProvider(config) {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  return {
    async *chat({ messages, tools, toolChoice = "auto" }) {
      const openaiTools = tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.id,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));

      const stream = await client.chat.completions.create({
        model: config.model,
        messages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        tool_choice: openaiTools.length > 0 ? toolChoice : undefined,
        stream: true,
        stream_options: { include_usage: true },
      });

      let currentToolCalls = [];

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) {
          if (chunk.usage) {
            totalInputTokens += chunk.usage.prompt_tokens || 0;
            totalOutputTokens += chunk.usage.completion_tokens || 0;
          }
          continue;
        }

        if (delta.content) {
          yield { type: "text", text: delta.content };
        }

        if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            if (toolCall.index === undefined) {
              continue;
            }
            if (!currentToolCalls[toolCall.index]) {
              currentToolCalls[toolCall.index] = { id: toolCall.id, name: "", arguments: "" };
            }
            if (toolCall.id) {
              currentToolCalls[toolCall.index].id = toolCall.id;
            }
            if (toolCall.function?.name) {
              currentToolCalls[toolCall.index].name += toolCall.function.name;
            }
            if (toolCall.function?.arguments) {
              currentToolCalls[toolCall.index].arguments += toolCall.function.arguments;
            }
          }
        }

        if (chunk.choices?.[0]?.finish_reason === "tool_calls") {
          for (const toolCall of currentToolCalls) {
            if (toolCall?.name) {
              yield {
                type: "tool_call",
                id: toolCall.id,
                name: toolCall.name,
                args: JSON.parse(toolCall.arguments || "{}"),
              };
            }
          }
          currentToolCalls = [];
        }
      }
    },

    getUsage() {
      return {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        model: config.model,
      };
    },
  };
}
