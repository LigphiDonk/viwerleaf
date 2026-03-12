import Anthropic from "@anthropic-ai/sdk";

function stringifyContent(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  return JSON.stringify(value);
}

function parseToolArguments(rawArgs) {
  if (rawArgs && typeof rawArgs === "object") {
    return rawArgs;
  }
  if (typeof rawArgs !== "string" || !rawArgs.trim()) {
    return {};
  }

  try {
    return JSON.parse(rawArgs);
  } catch {
    return {};
  }
}

function toAnthropicMessages(messages) {
  const output = [];

  for (const message of messages) {
    if (!message || message.role === "system") {
      continue;
    }

    if (message.role === "user") {
      output.push({
        role: "user",
        content: stringifyContent(message.content),
      });
      continue;
    }

    if (message.role === "assistant") {
      const content = [];
      const text = stringifyContent(message.content).trim();
      if (text) {
        content.push({ type: "text", text });
      }

      for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const name = toolCall?.function?.name;
        if (!name) {
          continue;
        }
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name,
          input: parseToolArguments(toolCall?.function?.arguments),
        });
      }

      if (content.length === 0) {
        continue;
      }

      output.push({
        role: "assistant",
        content: content.length === 1 && content[0].type === "text" ? content[0].text : content,
      });
      continue;
    }

    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: stringifyContent(message.content),
      };
      const last = output[output.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((item) => item.type === "tool_result")) {
        last.content.push(block);
      } else {
        output.push({
          role: "user",
          content: [block],
        });
      }
    }
  }

  return output;
}

export function createAnthropicProvider(config) {
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || undefined,
    // Prevent ANTHROPIC_AUTH_TOKEN env var from injecting Authorization: Bearer,
    // which some reverse-proxy endpoints reject.
    authToken: null,
    fetch: (url, opts = {}) => {
      const headers = new Headers(opts.headers);
      // Some reverse-proxy endpoints block SDK-specific headers.
      headers.delete("authorization");
      headers.delete("user-agent");
      return fetch(url, { ...opts, headers });
    },
  });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  return {
    async *chat({ messages, tools }) {
      const systemMessages = messages.filter((message) => message.role === "system");
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
        messages: toAnthropicMessages(messages),
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
