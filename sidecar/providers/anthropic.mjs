import Anthropic from "@anthropic-ai/sdk";

export function createAnthropicProvider(config) {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || undefined,
  });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  return {
    async *chat({ messages, tools }) {
      const systemMessages = messages.filter((message) => message.role === "system");
      const nonSystemMessages = messages.filter((message) => message.role !== "system");
      const system = systemMessages.map((message) => message.content).join("\n\n");

      const anthropicTools = tools.map((tool) => ({
        name: tool.id,
        description: tool.description,
        input_schema: tool.parameters,
      }));

      const stream = client.messages.stream({
        model: config.model,
        max_tokens: 4096,
        system,
        messages: nonSystemMessages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({
            role: message.role,
            content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
          })),
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        } else if (event.type === "message_delta" && event.usage) {
          totalOutputTokens += event.usage.output_tokens || 0;
        }
      }

      const finalMessage = await stream.finalMessage();
      totalInputTokens += finalMessage.usage?.input_tokens || 0;
      totalOutputTokens = finalMessage.usage?.output_tokens || totalOutputTokens;

      for (const block of finalMessage.content) {
        if (block.type === "tool_use") {
          yield {
            type: "tool_call",
            id: block.id,
            name: block.name,
            args: block.input,
          };
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
