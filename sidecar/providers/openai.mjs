import OpenAI from "openai";
import { randomUUID } from "node:crypto";

import { consumeTextToolCalls, normalizeToolCallPayload } from "./tool-call.mjs";

export function createOpenAIProvider(config) {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    fetch: (url, opts = {}) => {
      const headers = new Headers(opts.headers);
      // Some reverse-proxy endpoints block SDK-specific headers.
      headers.delete("user-agent");
      return fetch(url, { ...opts, headers });
    },
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
      let textBuffer = "";
      let taggedState = { mode: "text" };

      function* drainTextBuffer(flush = false) {
        const consumed = consumeTextToolCalls(textBuffer, { flush, state: taggedState });
        textBuffer = consumed.remainder;
        taggedState = consumed.state;
        for (const event of consumed.events) {
          if (event.type === "text" && event.text) {
            yield { type: "text", text: event.text };
            continue;
          }
          if (event.type === "thinking_start") {
            yield { type: "thinking_start" };
            continue;
          }
          if (event.type === "thinking" && event.text) {
            yield { type: "thinking", text: event.text };
            continue;
          }
          if (event.type === "thinking_end") {
            yield { type: "thinking_end" };
            continue;
          }
          if (event.type === "tool_call") {
            yield {
              type: "tool_call",
              id: randomUUID(),
              name: event.name,
              args: event.args,
              source: event.source || "tagged",
            };
          }
        }
      }

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
          textBuffer += delta.content;
          yield* drainTextBuffer(false);
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
          yield* drainTextBuffer(true);
          for (const toolCall of currentToolCalls) {
            if (toolCall?.name) {
              const normalized = normalizeToolCallPayload({
                name: toolCall.name,
                arguments: toolCall.arguments || "{}",
              });
              yield {
                type: "tool_call",
                id: toolCall.id,
                name: normalized?.name || toolCall.name,
                args: normalized?.args || {},
                source: "native",
              };
            }
          }
          currentToolCalls = [];
        }
      }

      yield* drainTextBuffer(true);
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
