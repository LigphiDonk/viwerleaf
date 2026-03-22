/**
 * Claude Code CLI Runner
 *
 * Uses @anthropic-ai/claude-agent-sdk to interact with the locally installed
 * Claude Code CLI. The SDK handles all tool execution internally — we only
 * need to forward streaming events as NDJSON StreamChunks to the Rust backend.
 *
 * Reference: dr-claw server/claude-sdk.js
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { emit } from "../utils/ndjson.mjs";
import { buildEffectiveMcpServers } from "../utils/mcp-config.mjs";
import {
  buildCliProcessEnv,
  requireCliExecutable,
} from "../utils/resolve-cli.mjs";

/**
 * Check if a message looks like system/skill prompt content
 * that should not be displayed as a normal assistant message.
 */
function isSystemPromptContent(text) {
  if (!text || text.length < 200) return false;
  if (/^#\s+(AGENTS|SKILL|INSTRUCTIONS)/m.test(text)) return true;
  if (text.includes("<INSTRUCTIONS>") || text.includes("</INSTRUCTIONS>"))
    return true;
  if (/^#+\s+.*instructions\s+for\s+\//im.test(text)) return true;
  if (text.includes("Base directory for this skill:") && text.length > 500)
    return true;
  return false;
}

/**
 * Build SDK options from the viwerleaf request payload.
 */
async function buildSdkOptions(request) {
  const options = {};

  // Working directory
  if (request.context?.projectRoot) {
    options.cwd = request.context.projectRoot;
  }

  // Model
  if (request.provider?.model) {
    options.model = request.provider.model;
  }

  if (request.provider?.reasoningEffort) {
    options.thinking = { type: "adaptive" };
    options.effort = request.provider.reasoningEffort;
  }

  // Permission mode
  const permMode = request.provider?.permissionMode || "default";
  if (permMode !== "default") {
    options.permissionMode = permMode;
  }

  // System prompt — use Claude Code's preset so CLAUDE.md is loaded
  options.systemPrompt = {
    type: "preset",
    preset: "claude_code",
  };

  // Load settings from project/user/local CLAUDE.md
  options.settingSources = ["project", "user", "local"];

  // Use the tools preset for full built-in tool set
  options.tools = { type: "preset", preset: "claude_code" };

  const mcpServers = await buildEffectiveMcpServers(request.provider?.mcpServers);
  if (Object.keys(mcpServers).length > 0) {
    options.mcpServers = mcpServers;
  }

  // Auto-approve to avoid interactive prompts in headless mode
  options.allowDangerouslySkipPermissions = false;

  // Resume an existing session
  if (request.remoteSessionId) {
    options.resume = request.remoteSessionId;
  }

  // Inject skill prompts if present
  if (request.systemPrompt && request.systemPrompt.trim()) {
    options.appendSystemPrompt = request.systemPrompt;
  }

  return options;
}

/**
 * Extract token budget from Claude API usage data.
 */
function extractTokenBudget(usage) {
  if (!usage) return null;
  const inputTokens = usage.input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  return {
    inputTokens: inputTokens + cacheRead + cacheCreation,
    outputTokens: usage.output_tokens || 0,
  };
}

/**
 * Run an agent session using Claude Code SDK.
 * @param {object} request - The agent request payload from Rust
 */
export async function runClaudeCode(request) {
  const options = await buildSdkOptions(request);
  options.pathToClaudeCodeExecutable = await requireCliExecutable("claude-code");
  options.env = buildCliProcessEnv(options.pathToClaudeCodeExecutable);
  const userMessage =
    typeof request.userMessage === "string" && request.userMessage.trim()
      ? request.userMessage.trim()
      : "Continue.";

  let capturedSessionId = request.remoteSessionId || null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    await streamQuery(options);
  } catch (error) {
    const wasAborted =
      error?.name === "AbortError" ||
      String(error?.message || "")
        .toLowerCase()
        .includes("aborted");

    const canRetryFresh = options.resume && isMissingConversationError(error);

    if (!wasAborted && canRetryFresh) {
      capturedSessionId = null;
      const retryOptions = { ...options };
      delete retryOptions.resume;
      try {
        await streamQuery(retryOptions);
      } catch (retryError) {
        emit({
          type: "error",
          message: retryError?.message || String(retryError),
        });
      }
    } else if (!wasAborted) {
      emit({
        type: "error",
        message: error?.message || String(error),
      });
    }
  }

  emit({
    type: "done",
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      model: request.provider?.model || "claude-code",
    },
    remoteSessionId: capturedSessionId,
  });

  async function streamQuery(queryOptions) {
    const queryInstance = query({
      prompt: userMessage,
      options: queryOptions,
    });

    for await (const event of queryInstance) {
      if (event?.session_id) {
        capturedSessionId = event.session_id;
      }
      handleSdkEvent(event);
    }
  }

  function handleSdkEvent(event) {
    if (!event) return;

    switch (event.type) {
      // Assistant text message
      case "assistant": {
        const text = event.message?.content;
        if (typeof text === "string" && text.trim()) {
          if (!isSystemPromptContent(text)) {
            emit({ type: "text_delta", content: text });
          }
        }

        // Extract usage info
        if (event.message?.usage) {
          const budget = extractTokenBudget(event.message.usage);
          if (budget) {
            totalInputTokens = budget.inputTokens;
            totalOutputTokens += budget.outputTokens;
          }
        }
        break;
      }

      // Text streaming delta
      case "content_block_delta": {
        if (event.delta?.type === "text_delta" && event.delta.text) {
          emit({ type: "text_delta", content: event.delta.text });
        } else if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
          emit({ type: "thinking_delta", content: event.delta.thinking });
        }
        break;
      }

      // Tool use events
      case "tool_use": {
        const toolName = event.name || event.tool_name || "tool";
        const input = event.input || {};
        emit({ type: "tool_call_start", toolId: toolName, args: input });
        break;
      }

      case "tool_result": {
        const toolName = event.name || event.tool_name || "tool";
        const output =
          typeof event.output === "string"
            ? event.output
            : JSON.stringify(event.output ?? "");
        const status = event.is_error ? "error" : "completed";
        emit({ type: "tool_call_result", toolId: toolName, output, status });
        break;
      }

      // Thinking events
      case "thinking": {
        if (event.thinking) {
          emit({ type: "thinking_delta", content: event.thinking });
        }
        break;
      }

      // Result/turn events
      case "result": {
        if (event.result) {
          emit({ type: "text_delta", content: event.result });
        }
        if (event.usage) {
          const budget = extractTokenBudget(event.usage);
          if (budget) {
            totalInputTokens = budget.inputTokens;
            totalOutputTokens += budget.outputTokens;
          }
        }
        break;
      }

      case "error": {
        emit({
          type: "error",
          message: event.error?.message || event.message || "unknown error",
        });
        break;
      }

      default:
        // Ignore unknown event types silently
        break;
    }
  }
}

function isMissingConversationError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("no conversation found") ||
    message.includes("conversation not found") ||
    message.includes("session") && message.includes("not found")
  );
}
