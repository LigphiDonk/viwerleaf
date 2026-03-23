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

  // Inject skill prompts + conciseness instruction
  const conciseInstruction = [
    "<INTERACTION_STYLE>",
    "When responding in Chinese, follow these rules:",
    "- Be concise. Reduce redundant acknowledgments and repetitions.",
    "- Do NOT start with verbose openers like 'OK understood', 'Sure I will help you', etc. A brief one-line acknowledgment is fine, but do NOT be verbose.",
    "- Do NOT repeat the user's request back. Jump straight into analysis and action.",
    "- Focus on valuable information and concrete actions.",
    "</INTERACTION_STYLE>",
  ].join("\n");

  const systemParts = [conciseInstruction];
  if (request.systemPrompt && request.systemPrompt.trim()) {
    systemParts.push(request.systemPrompt.trim());
  }
  options.appendSystemPrompt = systemParts.join("\n\n");

  // ── NEW: Enable full SDK event stream ──────────────────────
  // Include partial/streaming message events so we can extract
  // tool_use content blocks from the raw API stream.
  options.includePartialMessages = true;

  // Enable periodic AI-generated progress summaries for sub-agents.
  options.agentProgressSummaries = true;

  // Enable fast mode so Claude Code routes simple operations (e.g. file reads)
  // to Haiku automatically, reducing cost and latency.
  options.settings = {
    ...(typeof options.settings === 'object' ? options.settings : {}),
    fastMode: true,
  };

  // Explicitly set the small/fast model for Haiku routing.
  // Claude Code CLI uses this to route simple read operations to Haiku,
  // which is separate from the Opus 4.6 "fast mode" above.
  options.smallFastModel = "claude-haiku-4-5-20251001";

  // ── Elicitation callback ──────────────────────────────────
  // When an MCP server requests user input (form fields, OAuth, etc.),
  // emit the request for frontend display and auto-accept.
  // TODO: Implement full round-trip once stdin-based IPC is supported.
  options.onElicitation = async (request) => {
    const requestId = `elicit-${Date.now()}`;
    emit({
      type: "elicitation_request",
      requestId,
      serverName: request.serverName || "",
      message: request.message || "",
      mode: request.mode || "form",
    });
    // Auto-accept for now; a full implementation would wait for
    // a frontend response written back via stdin IPC.
    return { action: "accept" };
  };

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

  // Track tool_use IDs we've already emitted so partial messages don't
  // double-emit tool starts that were already handled by `tool_use` events.
  const emittedToolUseIds = new Set();
  const completedToolUseIds = new Set();
  let toolUseCounter = 0;

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
      // ═══════════════════════════════════════════════════════════
      // Assistant text message (complete — after API turn finishes)
      // ═══════════════════════════════════════════════════════════
      case "assistant": {
        const msg = event.message;
        // The message content can be a string or an array of content blocks.
        if (typeof msg?.content === "string" && msg.content.trim()) {
          if (!isSystemPromptContent(msg.content)) {
            emit({ type: "text_delta", content: msg.content });
          }
        } else if (Array.isArray(msg?.content)) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text?.trim()) {
              if (!isSystemPromptContent(block.text)) {
                emit({ type: "text_delta", content: block.text });
              }
            } else if (block.type === "thinking" && block.thinking) {
              emit({ type: "thinking_delta", content: block.thinking });
              emit({ type: "thinking_commit" });
            } else if (block.type === "tool_use") {
              // Emit tool_call_start from the finalized assistant message
              // if it wasn't already emitted by a stream_event or tool_use event.
              const blockUseId = block.id || `auto-${++toolUseCounter}`;
              if (!emittedToolUseIds.has(blockUseId)) {
                emittedToolUseIds.add(blockUseId);
                emit({
                  type: "tool_call_start",
                  toolId: block.name || "tool",
                  toolUseId: blockUseId,
                  args: block.input || {},
                });
              }
              // Auto-close: if this tool_use never received a tool_result,
              // emit an empty completed result so the card stops spinning.
              if (!completedToolUseIds.has(blockUseId)) {
                completedToolUseIds.add(blockUseId);
                emit({
                  type: "tool_call_result",
                  toolId: block.name || "tool",
                  toolUseId: blockUseId,
                  output: "",
                  status: "completed",
                });
              }
            }
          }
        }

        // Extract usage info
        if (msg?.usage) {
          const budget = extractTokenBudget(msg.usage);
          if (budget) {
            totalInputTokens = budget.inputTokens;
            totalOutputTokens += budget.outputTokens;
          }
        }
        break;
      }

      // ═══════════════════════════════════════════════════════════
      // Streaming delta (text, thinking, or tool_use input json)
      // ═══════════════════════════════════════════════════════════
      case "content_block_delta": {
        if (event.delta?.type === "text_delta" && event.delta.text) {
          emit({ type: "text_delta", content: event.delta.text });
        } else if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
          emit({ type: "thinking_delta", content: event.delta.thinking });
        }
        break;
      }

      // ═══════════════════════════════════════════════════════════
      // Partial assistant message (raw API stream events)
      // ═══════════════════════════════════════════════════════════
      case "stream_event": {
        const rawEvent = event.event;
        if (!rawEvent) break;

        // content_block_start with tool_use → emit tool_call_start
        if (
          rawEvent.type === "content_block_start" &&
          rawEvent.content_block?.type === "tool_use"
        ) {
          const block = rawEvent.content_block;
          const blockUseId = block.id || `auto-${++toolUseCounter}`;
          if (!emittedToolUseIds.has(blockUseId)) {
            emittedToolUseIds.add(blockUseId);
            const blockName = block.name || "tool";
            const blockInput = block.input || {};
            if (blockName === "AskUserQuestion" && blockInput.questions) {
              emit({
                type: "interactive_question",
                requestId: blockUseId || `iq-${Date.now()}`,
                title: blockInput.title || "",
                questions: blockInput.questions,
              });
            } else {
              emit({
                type: "tool_call_start",
                toolId: blockName,
                toolUseId: blockUseId,
                args: blockInput,
              });
            }
          }
        }

        // Streaming text deltas from partial messages
        if (
          rawEvent.type === "content_block_delta" &&
          rawEvent.delta?.type === "text_delta" &&
          rawEvent.delta.text
        ) {
          emit({ type: "text_delta", content: rawEvent.delta.text });
        }

        // Streaming thinking deltas from partial messages
        if (
          rawEvent.type === "content_block_delta" &&
          rawEvent.delta?.type === "thinking_delta" &&
          rawEvent.delta.thinking
        ) {
          emit({ type: "thinking_delta", content: rawEvent.delta.thinking });
        }
        break;
      }

      // ═══════════════════════════════════════════════════════════
      // Tool use events (from internal execution)
      // ═══════════════════════════════════════════════════════════
      case "tool_use": {
        const toolName = event.name || event.tool_name || "tool";
        const input = event.input || {};
        const toolId = event.tool_use_id || event.id || `auto-${++toolUseCounter}`;
        if (toolId) emittedToolUseIds.add(toolId);
        // Intercept AskUserQuestion → emit interactive_question
        if (toolName === "AskUserQuestion" && input.questions) {
          emit({
            type: "interactive_question",
            requestId: toolId || `iq-${Date.now()}`,
            title: input.title || "",
            questions: input.questions,
          });
          break;
        }
        emit({ type: "tool_call_start", toolId: toolName, toolUseId: toolId, args: input });
        break;
      }

      case "tool_result": {
        const toolResultId = event.tool_use_id || event.id || "";
        if (toolResultId) completedToolUseIds.add(toolResultId);
        const toolName = event.name || event.tool_name || "tool";
        const output =
          typeof event.output === "string"
            ? event.output
            : JSON.stringify(event.output ?? "");
        const status = event.is_error ? "error" : "completed";
        emit({ type: "tool_call_result", toolId: toolName, toolUseId: toolResultId, output, status });
        break;
      }

      // ═══════════════════════════════════════════════════════════
      // Tool use summary (aggregated description of recent tools)
      // ═══════════════════════════════════════════════════════════
      case "tool_use_summary": {
        if (event.summary) {
          emit({ type: "tool_use_summary", summary: event.summary });
        }
        break;
      }

      // ═══════════════════════════════════════════════════════════
      // Tool progress (elapsed time for running tools)
      // ═══════════════════════════════════════════════════════════
      case "tool_progress": {
        emit({
          type: "tool_progress",
          toolUseId: event.tool_use_id || "",
          toolName: event.tool_name || "",
          elapsedSeconds: event.elapsed_time_seconds || 0,
        });
        break;
      }

      // ═══════════════════════════════════════════════════════════
      // Thinking events (standalone)
      // ═══════════════════════════════════════════════════════════
      case "thinking": {
        if (event.thinking) {
          emit({ type: "thinking_delta", content: event.thinking });
        }
        break;
      }

      // ═══════════════════════════════════════════════════════════
      // System events (init, status, sub-agent, hooks, etc.)
      // ═══════════════════════════════════════════════════════════
      case "system": {
        switch (event.subtype) {
          case "task_started":
            emit({
              type: "subagent_start",
              taskId: event.task_id || "",
              description: event.description || "",
            });
            break;

          case "task_progress":
            emit({
              type: "subagent_progress",
              taskId: event.task_id || "",
              description: event.description || "",
              toolName: event.last_tool_name || "",
              summary: event.summary || "",
            });
            break;

          case "task_notification":
            emit({
              type: "subagent_done",
              taskId: event.task_id || "",
              summary: event.summary || "",
              status: event.status || "completed",
            });
            break;

          case "status":
            if (event.status === "compacting") {
              emit({
                type: "status_update",
                status: "compacting",
                message: "正在压缩上下文…",
              });
            }
            break;

          case "init":
            // Emit model and fast-mode info from session init
            if (event.model || event.fast_mode_state) {
              emit({
                type: "model_info",
                model: event.model || "",
                fastModeState: event.fast_mode_state || "off",
              });
            }
            break;

          default:
            // Other system subtypes (hook events, etc.) — ignore silently
            break;
        }
        break;
      }

      // ═══════════════════════════════════════════════════════════
      // Rate limit events
      // ═══════════════════════════════════════════════════════════
      case "rate_limit_event": {
        const info = event.rate_limit_info;
        if (info?.status === "rejected") {
          const resetAt = info.resetsAt
            ? new Date(info.resetsAt * 1000).toLocaleTimeString()
            : "";
          emit({
            type: "status_update",
            status: "rate_limited",
            message: resetAt
              ? `已达速率限制，${resetAt} 后恢复`
              : "已达速率限制",
          });
        } else if (info?.status === "allowed_warning") {
          emit({
            type: "status_update",
            status: "rate_limit_warning",
            message: `接近速率限制 (${Math.round((info.utilization || 0) * 100)}%)`,
          });
        }
        break;
      }

      // ═══════════════════════════════════════════════════════════
      // Auth status
      // ═══════════════════════════════════════════════════════════
      case "auth_status": {
        if (event.error) {
          emit({
            type: "status_update",
            status: "auth_error",
            message: event.error,
          });
        }
        break;
      }

      // ═══════════════════════════════════════════════════════════
      // Result / turn completion
      // ═══════════════════════════════════════════════════════════
      case "result": {
        if (event.result && !event.is_error) {
          emit({ type: "text_delta", content: event.result });
        }
        if (event.is_error && event.errors?.length) {
          emit({
            type: "error",
            message: event.errors.join("; "),
          });
        }
        if (event.usage) {
          const budget = extractTokenBudget(event.usage);
          if (budget) {
            totalInputTokens = budget.inputTokens;
            totalOutputTokens += budget.outputTokens;
          }
        }
        // Emit model info with fast-mode state and per-model usage breakdown
        if (event.fast_mode_state || event.modelUsage) {
          const usedModels = event.modelUsage
            ? Object.keys(event.modelUsage).join(", ")
            : "";
          emit({
            type: "model_info",
            model: usedModels || request.provider?.model || "claude-code",
            fastModeState: event.fast_mode_state || "off",
          });
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

      // ═══════════════════════════════════════════════════════════
      // Silently ignored event types
      // ═══════════════════════════════════════════════════════════
      case "user":
        // User message replays — skip
        break;

      case "prompt_suggestion": {
        if (event.suggestion) {
          emit({
            type: "prompt_suggestion",
            suggestion: event.suggestion,
          });
        }
        break;
      }

      default:
        // Log unhandled events for debugging
        if (process.env.VIWERLEAF_DEBUG) {
          console.error(
            "UNHANDLED SDK EVENT:",
            event.type,
            JSON.stringify(event).slice(0, 300),
          );
        }
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
