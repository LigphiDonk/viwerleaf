/**
 * OpenAI Codex CLI Runner
 *
 * Uses @openai/codex-sdk to interact with the locally installed Codex CLI.
 * The SDK handles tool execution internally (sandbox mode, file changes,
 * shell commands). We stream events as NDJSON StreamChunks.
 *
 * Reference: dr-claw server/openai-codex.js
 */

import { Codex } from "@openai/codex-sdk";
import { emit } from "../utils/ndjson.mjs";
import { buildCodexMcpConfig, buildEffectiveMcpServers } from "../utils/mcp-config.mjs";
import {
  buildCliProcessEnv,
  requireCliExecutable,
} from "../utils/resolve-cli.mjs";

/**
 * Map permission mode string to Codex SDK sandbox/approval options.
 */
function mapPermissionMode(permissionMode) {
  switch (permissionMode) {
    case "acceptEdits":
      return {
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
      };
    case "bypassPermissions":
      return {
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      };
    case "default":
    default:
      return {
        sandboxMode: "workspace-write",
        approvalPolicy: "untrusted",
      };
  }
}

function mapReasoningEffort(reasoningEffort) {
  switch (reasoningEffort) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return reasoningEffort;
    case "max":
      return "xhigh";
    default:
      return undefined;
  }
}

/**
 * Transform a Codex SDK event into a viwerleaf StreamChunk.
 * Returns null to skip the event.
 */
function transformCodexEvent(event) {
  switch (event.type) {
    case "item.started":
    case "item.completed": {
      const item = event.item;
      if (!item) return null;

      switch (item.type) {
        case "agent_message": {
          const text = item.text || "";
          if (!text.trim()) return null;
          return { type: "text_delta", content: text };
        }

        case "reasoning":
          // Codex reasoning items are brief status notes — skip them
          return null;

        case "command_execution": {
          // Extract command string (may be JSON-wrapped)
          let command = item.command || "";
          try {
            const parsed = JSON.parse(command);
            if (parsed.cmd) command = parsed.cmd;
          } catch {
            // Not JSON, use as-is
          }

          if (event.type === "item.started") {
            return {
              type: "tool_call_start",
              toolId: "bash",
              args: { command },
            };
          }

          // item.completed
          const output = item.aggregated_output || "";
          const status =
            item.exit_code === 0 || item.exit_code == null
              ? "completed"
              : "error";
          return {
            type: "tool_call_result",
            toolId: "bash",
            output: output.length > 4000 ? output.slice(0, 4000) + "\n[truncated]" : output,
            status,
          };
        }

        case "file_change": {
          if (event.type === "item.started") {
            const changes = item.changes || [];
            const summary = changes
              .map((c) => `${c.type || "modify"}: ${c.file || "unknown"}`)
              .join(", ");
            return {
              type: "tool_call_start",
              toolId: "file_change",
              args: { changes: summary },
            };
          }
          return {
            type: "tool_call_result",
            toolId: "file_change",
            output: "file changes applied",
            status: "completed",
          };
        }

        case "web_search": {
          return {
            type: "tool_call_start",
            toolId: "web_search",
            args: { query: item.query || "" },
          };
        }

        case "mcp_tool_call": {
          const toolId = `${item.server || "mcp"}.${item.tool || "tool"}`;
          if (event.type === "item.started") {
            return {
              type: "tool_call_start",
              toolId,
              args: item.arguments ?? {},
            };
          }

          const status = item.status === "failed" ? "error" : "completed";
          const output = item.error
            ? item.error.message || "mcp tool call failed"
            : JSON.stringify(item.result?.structured_content ?? item.result ?? {}, null, 2);
          return {
            type: "tool_call_result",
            toolId,
            output,
            status,
          };
        }

        case "error":
          return {
            type: "error",
            message: item.message || "codex error",
          };

        default:
          return null;
      }
    }

    case "item.updated":
      // Skip streaming noise
      return null;

    case "turn.started":
      return null;

    case "turn.completed":
      // Return usage info for token tracking
      return {
        type: "_usage",
        usage: event.usage,
      };

    case "turn.failed":
      return {
        type: "error",
        message: event.error?.message || "codex turn failed",
      };

    case "error":
      return {
        type: "error",
        message: event.message || "codex error",
      };

    default:
      return null;
  }
}

function normalizeCodexError(error) {
  const raw = error?.message || String(error);

  if (raw.includes("env: node: No such file or directory")) {
    return "Codex CLI 已找到，但桌面应用环境里缺少它依赖的 node。请确认本机 Node.js 可执行，或重启应用后重试。";
  }

  if (
    raw.includes("system-configuration") ||
    raw.includes("Attempted to create a NULL object")
  ) {
    return "Codex CLI 已启动，但在读取 macOS 系统配置时崩溃。先重启应用再试；如果仍失败，通常需要重新安装或升级本机 codex CLI。";
  }

  return raw;
}

/**
 * Run an agent session using Codex SDK.
 * @param {object} request - The agent request payload from Rust
 */
export async function runCodex(request) {
  const workingDirectory =
    request.context?.projectRoot || process.cwd();
  const permissionMode = request.provider?.permissionMode || "default";
  const { sandboxMode, approvalPolicy } = mapPermissionMode(permissionMode);
  const model = request.provider?.model || undefined;
  const modelReasoningEffort = mapReasoningEffort(request.provider?.reasoningEffort);

  const userMessage =
    typeof request.userMessage === "string" && request.userMessage.trim()
      ? request.userMessage.trim()
      : "Continue.";

  const promptSections = [];

  if (request.systemPrompt && request.systemPrompt.trim()) {
    promptSections.push(request.systemPrompt.trim());
  }
  promptSections.push(userMessage);
  const prompt = promptSections.join("\n\n---\n\n");

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const abortController = new AbortController();

  try {
    const codexPathOverride = await requireCliExecutable("codex");
    const effectiveMcpServers = await buildEffectiveMcpServers(request.provider?.mcpServers);
    const config = buildCodexMcpConfig(effectiveMcpServers);
    const codex = new Codex({
      codexPathOverride,
      env: buildCliProcessEnv(codexPathOverride),
      ...(config ? { config } : {}),
    });

    // Thread options
    const threadOptions = {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      model,
      modelReasoningEffort,
    };

    // Start or resume thread
    let thread;
    if (request.sessionId) {
      try {
        thread = codex.resumeThread(request.sessionId, threadOptions);
      } catch {
        // Session not found, start fresh
        thread = codex.startThread(threadOptions);
      }
    } else {
      thread = codex.startThread(threadOptions);
    }

    // Execute with streaming
    const streamedTurn = await thread.runStreamed(prompt, {
      signal: abortController.signal,
    });

    for await (const event of streamedTurn.events) {
      const transformed = transformCodexEvent(event);
      if (!transformed) continue;

      // Internal usage event — extract token counts
      if (transformed.type === "_usage") {
        if (transformed.usage) {
          totalInputTokens += transformed.usage.input_tokens || 0;
          totalOutputTokens += transformed.usage.output_tokens || 0;
        }
        continue;
      }

      emit(transformed);
    }
  } catch (error) {
    const wasAborted =
      error?.name === "AbortError" ||
      String(error?.message || "")
        .toLowerCase()
        .includes("aborted");

    if (!wasAborted) {
      emit({
        type: "error",
        message: normalizeCodexError(error),
      });
    }
  }

  emit({
    type: "done",
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      model: model || "codex",
    },
  });
}
