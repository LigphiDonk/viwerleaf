import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { SkillArsenal } from "./SkillArsenal";
import { desktop } from "../lib/desktop";
import {
  AGENT_BRANDS,
  buildAgentModelVariants,
  formatEffortLabel,
  getAgentBrand,
  isAgentVendor,
  readAgentRuntimePreferences,
  resolveAgentModelSelection,
  resolveAgentModelVariant,
  serializeAgentModelVariant,
  type AgentVendor,
} from "../lib/agentCatalog";

import type {
  AgentTaskContext,
  AgentMessage,
  AgentProfile,
  AgentSessionSummary,
  CliAgentStatus,
  DiffLine,
  ProjectNode,
  ProviderConfig,
  ResearchTaskDraft,
  ResearchTaskUpdateChanges,
  SkillManifest,
  TaskUpdateSuggestion,
  UsageRecord,
} from "../types";

/* Module-level set so dismissed-suggestion keys survive component re-mounts */
const _appliedSuggestionKeys = new Set<string>();

/* ─── stream block parser ─────────────────────────────── */
interface ToolCallBlock {
  id: string;
  toolId: string;
  args?: Record<string, unknown>;
  output?: string;
  status: "running" | "completed" | "error" | "requested";
}
type RenderBlock =
  | { kind: "text"; id: string; text: string }
  | { kind: "tool"; id: string; call: ToolCallBlock };
interface StreamBlock {
  blocks: RenderBlock[];
  text: string;
  toolCalls: ToolCallBlock[];
  thoughtText: string;
}

const TAGGED_TOOL_BLOCK_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>|\[TOOL_CALL\]\s*([\s\S]*?)\s*\[\/TOOL_CALL\]|<(?:[\w-]+:)?tool_call[^>]*>\s*([\s\S]*?)\s*<\/(?:[\w-]+:)?tool_call>|(?:<)?minimax:tool_call\b[^>]*>\s*([\s\S]*?)\s*<\/tool>|(?:<)?minimax:tool_call\b\s*([\s\S]*?)\s*<\/tool>/g;

function parseColonStyleArgs(raw: string) {
  const args: Record<string, unknown> = {};
  const pattern = /([a-zA-Z0-9_-]+)\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s<>,}]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    args[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return args;
}

function parseSerializedArgs(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return parseColonStyleArgs(trimmed);
  }
}

function parseInlineToolCommand(raw: string) {
  const normalized = raw
    .replace(/<id\b[^>]*>[\s\S]*?<\/id>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return null;
  }
  const [name, ...rest] = normalized.split(/\s+/);
  if (!name) {
    return null;
  }
  return {
    name,
    args: parseColonStyleArgs(rest.join(" ")),
  };
}

function parseEmbeddedToolPayload(raw: string) {
  const minimaxInline = raw.match(/(?:<)?minimax:tool_call\b[^>]*>([\s\S]*?)<\/tool>/i)?.[1] || "";
  if (minimaxInline) {
    return parseInlineToolCommand(minimaxInline);
  }

  const toolCodeBody = raw.match(/<tool_code\b[^>]*>([\s\S]*?)<\/tool_code>/i)?.[1] || "";
  if (toolCodeBody) {
    return parseInlineToolCommand(toolCodeBody);
  }

  const toolBody = raw.match(/<tool\b[^>]*>([\s\S]*?)<\/tool>/i)?.[1] || "";
  if (toolBody) {
    return parseInlineToolCommand(toolBody);
  }

  const xmlInvokeName =
    raw.match(/<invoke\b[^>]*\bname="([^"]+)"/i)?.[1] ||
    raw.match(/<tool\b[^>]*\bname="([^"]+)"/i)?.[1] ||
    "";
  if (xmlInvokeName) {
    const invokeTag = raw.match(/<(?:invoke|tool)\b([^>]*)>/i)?.[1] || "";
    const args: Record<string, unknown> = {};
    const attrPattern = /([a-zA-Z0-9_:-]+)="([^"]*)"/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrPattern.exec(invokeTag)) !== null) {
      if (attrMatch[1] !== "name") {
        args[attrMatch[1]] = attrMatch[2];
      }
    }
    return { name: xmlInvokeName, args };
  }

  const customName =
    raw.match(/(?:tool|name|toolName)\s*=>\s*"([^"]+)"/i)?.[1] ||
    raw.match(/(?:tool|name|toolName)\s*:\s*"([^"]+)"/i)?.[1] ||
    "";
  if (customName) {
    const argsBlock =
      raw.match(/args(?:uments)?\s*=>\s*\{([\s\S]*?)\}\s*$/i)?.[1] ||
      raw.match(/args(?:uments)?\s*:\s*\{([\s\S]*?)\}\s*$/i)?.[1] ||
      "";
    const args: Record<string, unknown> = {};
    const shellStyle = /--([a-zA-Z0-9_-]+)(?:\s+(?:"([^"]*)"|'([^']*)'|([^\s}]+)))?/g;
    let shellMatch: RegExpExecArray | null;
    while ((shellMatch = shellStyle.exec(argsBlock)) !== null) {
      args[shellMatch[1]] = shellMatch[2] ?? shellMatch[3] ?? shellMatch[4] ?? true;
    }
    return { name: customName, args };
  }

  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const record = payload as Record<string, unknown>;
    const name =
      (typeof record.name === "string" && record.name) ||
      (typeof record.tool === "string" && record.tool) ||
      (typeof record.toolName === "string" && record.toolName);
    if (!name) {
      return null;
    }

    const rawArgs = record.arguments ?? record.args ?? record.input ?? record.parameters ?? {};
    const args = (() => {
      if (rawArgs && typeof rawArgs === "object") {
        return rawArgs as Record<string, unknown>;
      }
      if (typeof rawArgs === "string" && rawArgs.trim()) {
        try {
          const parsed = JSON.parse(rawArgs);
          return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
        } catch {
          return {};
        }
      }
      return {};
    })();
    return { name, args };
  } catch {
    return parseInlineToolCommand(raw);
  }
}

function parseSerializedToolBlocks(raw: string): { toolCalls: ToolCallBlock[]; blocks: RenderBlock[]; cleaned: string } {
  const lines = raw.split("\n");
  const toolCalls: ToolCallBlock[] = [];
  const blocks: RenderBlock[] = [];
  const textLines: string[] = [];
  const pendingToolIndices: number[] = [];
  const pushTextBlock = () => {
    if (textLines.length === 0) {
      return;
    }
    const text = textLines.join("\n").trim();
    if (text) {
      blocks.push({
        kind: "text",
        id: `text-${blocks.length}`,
        text,
      });
    }
    textLines.length = 0;
  };
  const resolvePendingTool = () => {
    while (pendingToolIndices.length > 0) {
      const nextIndex = pendingToolIndices[pendingToolIndices.length - 1];
      const candidate = toolCalls[nextIndex];
      if (!candidate) {
        pendingToolIndices.pop();
        continue;
      }
      if (candidate.output?.trim()) {
        pendingToolIndices.pop();
        continue;
      }
      return candidate;
    }
    return null;
  };
  let i = 0;
  while (i < lines.length) {
    const toolMatch = lines[i].match(/^\[Tool: ([^\]]+)\]$/);
    if (toolMatch) {
      pushTextBlock();
      const toolId = toolMatch[1];
      let args: Record<string, unknown> | undefined;
      let result = "";
      let status: ToolCallBlock["status"] = "running";
      let cursor = i + 1;

      if (cursor < lines.length && lines[cursor].trim() === "[Args]") {
        cursor += 1;
        const argLines: string[] = [];
        while (cursor < lines.length && lines[cursor].trim() !== "[/Args]") {
          argLines.push(lines[cursor]);
          cursor += 1;
        }
        args = parseSerializedArgs(argLines.join("\n"));
        if (cursor < lines.length && lines[cursor].trim() === "[/Args]") {
          cursor += 1;
        }
      }

      while (cursor < lines.length && lines[cursor].startsWith("[Status: ")) {
        const statusLine = lines[cursor];
        const lastBracket = statusLine.lastIndexOf("]");
        const nextStatus = statusLine.slice("[Status: ".length, lastBracket > -1 ? lastBracket : undefined).trim();
        if (
          nextStatus === "error" ||
          nextStatus === "requested" ||
          nextStatus === "running" ||
          nextStatus === "completed"
        ) {
          status = nextStatus;
        }
        cursor += 1;
      }

      if (cursor < lines.length && lines[cursor].trim() === "[Result]") {
        cursor += 1;
        const resultLines: string[] = [];
        while (cursor < lines.length && lines[cursor].trim() !== "[/Result]") {
          resultLines.push(lines[cursor]);
          cursor += 1;
        }
        result = resultLines.join("\n");
        if (cursor < lines.length && lines[cursor].trim() === "[/Result]") {
          cursor += 1;
        }
      } else if (cursor < lines.length && lines[cursor].startsWith("[Result: ")) {
        const resultLine = lines[cursor];
        const lastBracket = resultLine.lastIndexOf("]");
        if (lastBracket > "[Result: ".length - 1) {
          result = resultLine.slice("[Result: ".length, lastBracket);
        } else {
          result = resultLine.slice("[Result: ".length);
        }
        cursor += 1;
      }

      const call: ToolCallBlock = {
        id: `${i}-${toolId}`,
        toolId,
        args,
        output: result.trim() || undefined,
        status: result ? (status === "running" ? "completed" : status) : status,
      };
      toolCalls.push(call);
      blocks.push({
        kind: "tool",
        id: `${i}-${toolId}`,
        call,
      });
      if (!call.output?.trim() && call.status === "running") {
        pendingToolIndices.push(toolCalls.length - 1);
      }
      i = cursor - 1;
    } else if (lines[i].startsWith("[Status: ")) {
      const pendingTool = resolvePendingTool();
      if (!pendingTool) {
        textLines.push(lines[i]);
        i++;
        continue;
      }

      const lastBracket = lines[i].lastIndexOf("]");
      const nextStatus = lines[i]
        .slice("[Status: ".length, lastBracket > -1 ? lastBracket : undefined)
        .trim();
      if (
        nextStatus === "error" ||
        nextStatus === "requested" ||
        nextStatus === "running" ||
        nextStatus === "completed"
      ) {
        pendingTool.status = nextStatus;
      }
    } else if (lines[i].trim() === "[Result]") {
      const pendingTool = resolvePendingTool();
      if (!pendingTool) {
        textLines.push(lines[i]);
        i++;
        continue;
      }

      let cursor = i + 1;
      const resultLines: string[] = [];
      while (cursor < lines.length && lines[cursor].trim() !== "[/Result]") {
        resultLines.push(lines[cursor]);
        cursor += 1;
      }

      pendingTool.output = resultLines.join("\n").trim() || undefined;
      if (pendingTool.status === "running") {
        pendingTool.status = "completed";
      }

      if (cursor < lines.length && lines[cursor].trim() === "[/Result]") {
        i = cursor;
      } else {
        i = cursor - 1;
      }
    } else if (lines[i].startsWith("[Result: ")) {
      const pendingTool = resolvePendingTool();
      if (!pendingTool) {
        textLines.push(lines[i]);
        i++;
        continue;
      }

      const resultLine = lines[i];
      const lastBracket = resultLine.lastIndexOf("]");
      pendingTool.output = (
        lastBracket > "[Result: ".length - 1
          ? resultLine.slice("[Result: ".length, lastBracket)
          : resultLine.slice("[Result: ".length)
      ).trim() || undefined;
      if (pendingTool.status === "running") {
        pendingTool.status = "completed";
      }
    } else {
      textLines.push(lines[i]);
    }
    i++;
  }
  pushTextBlock();
  const cleaned = blocks.reduce<string[]>((acc, block) => {
    if (block.kind === "text") {
      acc.push(block.text);
    }
    return acc;
  }, []).join("\n");
  return { toolCalls, blocks, cleaned };
}

function parseStreamBlocks(raw: string): StreamBlock {
  const toolCalls: ToolCallBlock[] = [];
  const blocks: RenderBlock[] = [];
  const thoughtText = Array.from(raw.matchAll(/<think>\s*([\s\S]*?)\s*<\/think>/g))
    .map((match) => match[1]?.trim() ?? "")
    .filter((value) => value.length > 0)
    .join("\n\n");

  const serialized = parseSerializedToolBlocks(raw);
  toolCalls.push(...serialized.toolCalls);
  blocks.push(...serialized.blocks);

  let m: RegExpExecArray | null;

  while ((m = TAGGED_TOOL_BLOCK_RE.exec(raw)) !== null) {
    const embedded = parseEmbeddedToolPayload(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "");
    if (!embedded) {
      continue;
    }
    toolCalls.push({
      id: `${m.index}-${embedded.name}`,
      toolId: embedded.name,
      args: embedded.args,
      status: "requested",
    });
    blocks.push({
      kind: "tool",
      id: `${m.index}-${embedded.name}`,
      call: toolCalls[toolCalls.length - 1],
    });
  }
  const text = serialized.cleaned
    .replace(TAGGED_TOOL_BLOCK_RE, "")
    .replace(/<\/(?:[\w-]+:)?tool_call>/g, "")
    .replace(/(?:<)?minimax:tool_call\b[^>]*>/g, "")
    .replace(/<\/tool>/g, "")
    .replace(/<\/?tool_code\b[^>]*>/g, "")
    .replace(/<\/?id\b[^>]*>/g, "")
    .replace(/<think>\s*[\s\S]*?\s*<\/think>/g, "")
    .replace(/<\/?think>/g, "")
    .replace(/\[Error: [\s\S]*?\]\n?/g, "")
    .trim();
  if (blocks.length === 0 && text) {
    blocks.push({
      kind: "text",
      id: "text-fallback",
      text,
    });
  }
  return { blocks, text, toolCalls, thoughtText };
}

const TASK_UPDATE_BLOCK_RE = /```viewerleaf_task_update\s*([\s\S]*?)```/gi;
type SuggestionOperation = TaskUpdateSuggestion["operations"][number];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function sanitizeTaskDraft(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const stage = typeof record.stage === "string" ? record.stage.trim() : "";
  if (!title || !stage) {
    return null;
  }
  return {
    id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : undefined,
    title,
    description: typeof record.description === "string" && record.description.trim() ? record.description.trim() : undefined,
    status: typeof record.status === "string" && record.status.trim() ? record.status.trim() : undefined,
    stage: stage as ResearchTaskDraft["stage"],
    priority: typeof record.priority === "string" && record.priority.trim() ? record.priority.trim() : undefined,
    dependencies: isStringArray(record.dependencies) ? record.dependencies.map((item) => item.trim()).filter(Boolean) : undefined,
    taskType: typeof record.taskType === "string" && record.taskType.trim() ? record.taskType.trim() : undefined,
    inputsNeeded: isStringArray(record.inputsNeeded) ? record.inputsNeeded.map((item) => item.trim()).filter(Boolean) : undefined,
    artifactPaths: isStringArray(record.artifactPaths) ? record.artifactPaths.map((item) => item.trim()).filter(Boolean) : undefined,
    suggestedSkills: isStringArray(record.suggestedSkills) ? record.suggestedSkills.map((item) => item.trim()).filter(Boolean) : undefined,
    nextActionPrompt: typeof record.nextActionPrompt === "string" && record.nextActionPrompt.trim() ? record.nextActionPrompt.trim() : undefined,
    contextNotes: typeof record.contextNotes === "string" && record.contextNotes.trim() ? record.contextNotes.trim() : undefined,
    taskPrompt: typeof record.taskPrompt === "string" && record.taskPrompt.trim() ? record.taskPrompt.trim() : undefined,
    agentEntryLabel: typeof record.agentEntryLabel === "string" && record.agentEntryLabel.trim() ? record.agentEntryLabel.trim() : undefined,
  } satisfies NonNullable<NonNullable<TaskUpdateSuggestion["operations"]>[number] & { type: "add" }>["task"];
}

function sanitizeTaskPlanOperations(value: unknown): TaskUpdateSuggestion["operations"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.reduce<SuggestionOperation[]>((operations, candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return operations;
    }
    const record = candidate as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type.trim() : "";
    if (type === "update") {
      const taskId = typeof record.taskId === "string" ? record.taskId.trim() : "";
      const changes = sanitizeTaskUpdateChanges(record.changes);
      if (taskId && changes) {
        operations.push({ type: "update", taskId, changes });
      }
      return operations;
    }
    if (type === "add") {
      const task = sanitizeTaskDraft(record.task);
      if (task) {
        operations.push({
          type: "add",
          task,
          afterTaskId: typeof record.afterTaskId === "string" && record.afterTaskId.trim() ? record.afterTaskId.trim() : undefined,
        });
      }
      return operations;
    }
    if (type === "remove") {
      const taskId = typeof record.taskId === "string" ? record.taskId.trim() : "";
      if (taskId) {
        operations.push({ type: "remove", taskId });
      }
      return operations;
    }
    return operations;
  }, []);
}

function sanitizeTaskUpdateChanges(value: unknown): ResearchTaskUpdateChanges | null {
  const changes = value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

  const nextChanges: ResearchTaskUpdateChanges = {};
  if (typeof changes?.title === "string" && changes.title.trim()) nextChanges.title = changes.title.trim();
  if (typeof changes?.status === "string" && changes.status.trim()) nextChanges.status = changes.status.trim();
  if (typeof changes?.stage === "string" && changes.stage.trim()) nextChanges.stage = changes.stage.trim() as ResearchTaskDraft["stage"];
  if (typeof changes?.priority === "string" && changes.priority.trim()) nextChanges.priority = changes.priority.trim();
  if (isStringArray(changes?.dependencies)) nextChanges.dependencies = changes.dependencies.map((item) => item.trim()).filter(Boolean);
  if (typeof changes?.taskType === "string" && changes.taskType.trim()) nextChanges.taskType = changes.taskType.trim();
  if (typeof changes?.description === "string" && changes.description.trim()) nextChanges.description = changes.description.trim();
  if (isStringArray(changes?.inputsNeeded)) nextChanges.inputsNeeded = changes.inputsNeeded.map((item) => item.trim()).filter(Boolean);
  if (isStringArray(changes?.artifactPaths)) nextChanges.artifactPaths = changes.artifactPaths.map((item) => item.trim()).filter(Boolean);
  if (isStringArray(changes?.suggestedSkills)) nextChanges.suggestedSkills = changes.suggestedSkills.map((item) => item.trim()).filter(Boolean);
  if (typeof changes?.nextActionPrompt === "string" && changes.nextActionPrompt.trim()) nextChanges.nextActionPrompt = changes.nextActionPrompt.trim();
  if (typeof changes?.contextNotes === "string" && changes.contextNotes.trim()) nextChanges.contextNotes = changes.contextNotes.trim();
  if (typeof changes?.taskPrompt === "string" && changes.taskPrompt.trim()) nextChanges.taskPrompt = changes.taskPrompt.trim();
  if (typeof changes?.agentEntryLabel === "string" && changes.agentEntryLabel.trim()) nextChanges.agentEntryLabel = changes.agentEntryLabel.trim();

  return Object.keys(nextChanges).length > 0 ? nextChanges : null;
}

function sanitizeTaskUpdateSuggestion(value: unknown): TaskUpdateSuggestion | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  const taskId = typeof record.taskId === "string" ? record.taskId.trim() : "";
  const changes = sanitizeTaskUpdateChanges(record.changes);
  const operations = sanitizeTaskPlanOperations(record.operations);
  if (!reason) {
    return null;
  }

  const legacyUpdateOperation: SuggestionOperation | null = taskId && changes
    ? { type: "update", taskId, changes }
    : null;
  const normalizedOperations = operations.length > 0
    ? operations
    : legacyUpdateOperation
      ? [legacyUpdateOperation]
      : [];

  if (normalizedOperations.length === 0) {
    return null;
  }

  return {
    reason,
    confidence: typeof record.confidence === "number" ? record.confidence : undefined,
    operations: normalizedOperations,
    workingMemory: typeof record.workingMemory === "string" && record.workingMemory.trim()
      ? record.workingMemory.trim()
      : undefined,
  };
}

function extractTaskUpdateSuggestion(raw: string): { content: string; suggestion: TaskUpdateSuggestion | null } {
  let suggestion: TaskUpdateSuggestion | null = null;
  const content = raw.replace(TASK_UPDATE_BLOCK_RE, (_match, payload: string) => {
    if (!suggestion) {
      try {
        suggestion = sanitizeTaskUpdateSuggestion(JSON.parse(payload.trim()));
      } catch {
        suggestion = null;
      }
    }
    return "";
  }).trim();
  return { content, suggestion };
}

function summarizeToolCall(call: ToolCallBlock) {
  const firstStringArg = (() => {
    if (!call.args) {
      return "";
    }
    const candidates = [
      call.args.command,
      call.args.filePath,
      call.args.file_path,
      call.args.uri,
      call.args.path,
      call.args.query,
      call.args.pattern,
      call.args.oldString,
    ].filter((value) => typeof value === "string" && value.trim().length > 0) as string[];
    return candidates[0] ?? "";
  })();

  const target = firstStringArg.length > 36 ? `${firstStringArg.slice(0, 36)}…` : firstStringArg;
  const prefix = call.status === "running" ? "正在" : call.status === "error" ? "失败" : "已完成";
  const requestedPrefix = call.status === "requested" ? "请求" : prefix;

  switch (call.toolId) {
    case "tool_search":
      return `${requestedPrefix}分析可用工具`;
    case "list":
    case "list_files":
      return `${requestedPrefix}查看项目结构${target ? ` · ${target}` : ""}`;
    case "read":
    case "read_section":
      return `${requestedPrefix}读取文件${target ? ` · ${target}` : ""}`;
    case "list_sections":
      return `${requestedPrefix}提取章节结构${target ? ` · ${target}` : ""}`;
    case "grep":
    case "search_project":
      return `${requestedPrefix}搜索内容${target ? ` · ${target}` : ""}`;
    case "glob":
      return `${requestedPrefix}查找匹配文件${target ? ` · ${target}` : ""}`;
    case "read_bib_entries":
      return `${requestedPrefix}读取参考文献`;
    case "edit":
    case "write":
    case "apply_patch":
    case "apply_text_patch":
    case "insert_at_line":
      return `${requestedPrefix}修改文件${target ? ` · ${target}` : ""}`;
    case "bash":
      return `${requestedPrefix}执行命令${target ? ` · ${target}` : ""}`;
    case "web_search":
      return `${requestedPrefix}联网搜索${target ? ` · ${target}` : ""}`;
    case "file_change":
      return `${requestedPrefix}应用文件变更`;
    default:
      return `${requestedPrefix}调用 ${call.toolId}${target ? ` · ${target}` : ""}`;
  }
}

function formatToolArgValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[object]";
    }
  }
  return "";
}

function buildToolArgRows(call: ToolCallBlock) {
  if (!call.args) {
    return [];
  }
  return Object.entries(call.args)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .slice(0, 4)
    .map(([key, value]) => ({
      key,
      value: formatToolArgValue(value),
    }))
    .filter((entry) => entry.value);
}

function buildToolOutputPreview(output?: string) {
  const cleaned = output?.trim() ?? "";
  if (!cleaned) {
    return "";
  }
  const lines = cleaned.split("\n").slice(0, 4).join("\n");
  return lines.length > 240 ? `${lines.slice(0, 240)}…` : lines;
}

/* ─── Tool call card ──────────────────────────────────── */
function ToolCallCard({ call }: { call: ToolCallBlock }) {
  const isRunning = call.status === "running";
  const isError = call.status === "error";
  const isRequested = call.status === "requested";
  const summary = summarizeToolCall(call);
  const argRows = buildToolArgRows(call);
  const outputPreview = buildToolOutputPreview(call.output);

  return (
    <div className={`ag-tool-card${isError ? " ag-tool-card--error" : ""}`}>
      <div className="ag-tool-header ag-tool-header--static">
        <span className="ag-tool-icon">
          {isRunning ? (
            <span className="ag-tool-spinner" />
          ) : isRequested ? (
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12">
              <path d="M3 8h10"/><path d="m9 4 4 4-4 4"/>
            </svg>
          ) : isError ? (
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12">
              <circle cx="8" cy="8" r="7"/><path d="M8 5v4M8 11v.5"/>
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="12" height="12">
              <polyline points="2,8 6,12 14,4"/>
            </svg>
          )}
        </span>
        <span className="ag-tool-name">{summary}</span>
        <span className={`ag-tool-pill ag-tool-pill--${call.status}`}>{call.toolId}</span>
      </div>
      {(argRows.length > 0 || outputPreview) && (
        <div className="ag-tool-body">
          {argRows.length > 0 && (
            <div className="ag-tool-args-grid">
              {argRows.map((entry) => (
                <div key={entry.key} className="ag-tool-arg-chip">
                  <span className="ag-tool-arg-key">{entry.key}</span>
                  <span className="ag-tool-arg-value">{entry.value}</span>
                </div>
              ))}
            </div>
          )}
          {outputPreview && (
            <pre className="ag-tool-output">{outputPreview}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function formatThoughtDuration(durationMs: number) {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  return `${seconds}s`;
}

function ThoughtDisclosure({
  text,
  active,
  durationMs,
}: {
  text: string;
  active: boolean;
  durationMs: number;
}) {
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  return (
    <details
      key={`${active ? "live" : "done"}-${durationMs}-${trimmed.length}`}
      className={`ag-thought-card${active ? " ag-thought-card--live" : ""}`}
      open={active}
    >
      <summary className="ag-thought-toggle">
        <span className="ag-thought-chevron" aria-hidden="true">▸</span>
        <span className="ag-thought-label">
          Thought{durationMs > 0 ? ` for ${formatThoughtDuration(durationMs)}` : ""}
        </span>
      </summary>
      <div className={`ag-thought-body${active ? " ag-thought-body--live" : ""}`}>
        <div className="ag-thought-text">{trimmed}</div>
      </div>
    </details>
  );
}

/* ─── User message ────────────────────────────────────── */
function UserMessage({ msg }: { msg: AgentMessage }) {
  return (
    <div className="ag-user-row">
      <div className="ag-user-bubble">{msg.content}</div>
    </div>
  );
}

/* ─── Assistant message ───────────────────────────────── */
function AssistantMessage({ msg, streaming }: {
  msg?: AgentMessage;
  streaming?: {
    thinkingText?: string;
    thinkingHistoryText?: string;
    thinkingDurationMs?: number;
    content: string;
    streamError?: string;
  };
}) {
  const raw = msg?.content ?? streaming?.content ?? "";
  const extracted = extractTaskUpdateSuggestion(raw);
  const parsed = parseStreamBlocks(extracted.content);
  const clean = parsed.text;
  const toolCalls = parsed.toolCalls;
  const blocks = parsed.blocks;
  const streamError = streaming?.streamError;
  const thinkingText = streaming?.thinkingText?.trim() ?? "";
  const thinkingHistoryText = streaming?.thinkingHistoryText?.trim() ?? "";
  const thoughtText = thinkingText || thinkingHistoryText || parsed.thoughtText;
  const runningToolCalls = toolCalls.filter((call) => call.status === "running").length;
  const streamStatusLabel = streaming
    ? streamError
      ? "响应出错"
      : clean
        ? "正在生成"
        : runningToolCalls > 0
          ? "正在处理"
          : thinkingText
            ? "正在思考"
            : "已发送"
    : "";

  return (
    <div className="ag-assistant-row">
      {thoughtText && (
        <ThoughtDisclosure
          text={thoughtText}
          active={Boolean(thinkingText)}
          durationMs={streaming?.thinkingDurationMs ?? 0}
        />
      )}
      {streaming && (!thoughtText || streamStatusLabel !== "正在思考") && (
        <div className="ag-stream-status" aria-live="polite">
          <span className="ag-stream-status-dots" aria-hidden="true">
            <span className="ag-thinking-dot" />
            <span className="ag-thinking-dot" />
            <span className="ag-thinking-dot" />
          </span>
          <span className="ag-stream-status-label">{streamStatusLabel}</span>
        </div>
      )}
      {streamError && <div className="ag-assistant-error">Error: {streamError}</div>}
      {blocks.length > 0 && (
        <div className="ag-assistant-sequence">
          {blocks.map((block) => block.kind === "text" ? (
            <div key={block.id} className="ag-assistant-text">
              <ReactMarkdown>{block.text}</ReactMarkdown>
            </div>
          ) : (
            <ToolCallCard key={block.id} call={block.call} />
          ))}
        </div>
      )}
      {!clean && !thinkingText && toolCalls.length === 0 && !streaming && (
        <div className="ag-assistant-text ag-thinking">
          <span className="ag-thinking-dot" />
          <span className="ag-thinking-dot" />
          <span className="ag-thinking-dot" />
        </div>
      )}
      {streaming && (
        <span className="ag-cursor-blink" />
      )}
    </div>
  );
}

/* ─── Patch card ──────────────────────────────────────── */
function PatchCard({ summary, diff, onApply, onDismiss }: {
  summary: string; diff?: DiffLine[]; onApply: () => void; onDismiss: () => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const additions = diff?.filter(l => l.type === "add").length ?? 0;
  const deletions = diff?.filter(l => l.type === "remove").length ?? 0;

  return (
    <div className="ag-patch-card">
      <div className="ag-patch-card-header">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="13" height="13">
          <path d="M2 2h8l4 4v8H2z"/><path d="M10 2v4h4"/>
        </svg>
        <span className="ag-patch-filename">Patch</span>
        {diff && diff.length > 0 && (
          <span className="ag-diff-stats">
            <span className="ag-diff-add">+{additions}</span>
            <span className="ag-diff-del">-{deletions}</span>
          </span>
        )}
        <div style={{ flex: 1 }} />
        {diff && diff.length > 0 && (
          <button className="ag-patch-diff-btn" type="button" onClick={() => setShowDiff(v => !v)}>
            {showDiff ? "Hide diff" : "Show diff"}
          </button>
        )}
        <button className="ag-patch-open-btn" type="button" onClick={onDismiss}>Dismiss</button>
        <button className="ag-patch-apply-btn" type="button" onClick={onApply}>Apply</button>
      </div>
      <div className="ag-patch-summary">{summary}</div>
      {showDiff && diff && (
        <div className="ag-diff-view">
          {diff.map((line, i) => (
            <div key={i} className={`ag-diff-line ag-diff-line--${line.type}`}>
              <span className="ag-diff-gutter">
                {line.type === "remove" ? line.oldLine ?? "" : ""}
              </span>
              <span className="ag-diff-gutter">
                {line.type === "add" ? line.newLine ?? "" : line.type === "equal" ? line.newLine ?? "" : ""}
              </span>
              <span className="ag-diff-marker">
                {line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}
              </span>
              <span className="ag-diff-content">{line.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskSuggestionCard({
  suggestion,
  activeTask,
  onApply,
  onDismiss,
}: {
  suggestion: TaskUpdateSuggestion;
  activeTask?: AgentTaskContext | null;
  onApply: () => void | Promise<void>;
  onDismiss: () => void;
}) {
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const operations: SuggestionOperation[] = suggestion.operations;
  const changeLabels: Array<[keyof ResearchTaskUpdateChanges, string]> = [
    ["title", "标题"],
    ["status", "状态"],
    ["stage", "阶段"],
    ["priority", "优先级"],
    ["dependencies", "依赖"],
    ["taskType", "类型"],
    ["description", "描述"],
    ["inputsNeeded", "输入"],
    ["artifactPaths", "产物"],
    ["suggestedSkills", "技能"],
    ["nextActionPrompt", "下一步"],
    ["contextNotes", "上下文"],
    ["taskPrompt", "任务提示词"],
    ["agentEntryLabel", "按钮文案"],
  ];

  const updateOperation = operations.find((operation) => operation.type === "update");
  const visibleChanges = updateOperation?.type === "update"
    ? changeLabels.filter(([key]) => updateOperation.changes[key] !== undefined)
    : [];
  const firstOperation = operations[0];
  let title = "计划调整";
  if (updateOperation?.type === "update") {
    title = activeTask?.taskId === updateOperation.taskId ? activeTask.title : updateOperation.taskId;
  } else if (firstOperation?.type === "add") {
    title = firstOperation.task.title;
  } else if (firstOperation?.type === "remove") {
    title = firstOperation.taskId;
  }

  const handleApply = async () => {
    if (isApplying) {
      return;
    }

    setIsApplying(true);
    setApplyError("");
    try {
      console.log("[TaskSuggestionCard] applying suggestion, operations:", JSON.stringify(suggestion.operations, null, 2));
      await onApply();
      console.log("[TaskSuggestionCard] apply succeeded");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[TaskSuggestionCard] apply failed:", message);
      setApplyError(message);
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div className="ag-task-suggestion-card">
      <div className="ag-task-suggestion-card__head">
        <div>
          <div className="ag-task-suggestion-card__eyebrow">任务/计划建议</div>
          <div className="ag-task-suggestion-card__title">
            {title}
          </div>
        </div>
        {typeof suggestion.confidence === "number" ? (
          <span className="ag-task-suggestion-card__confidence">
            {Math.round(suggestion.confidence * 100)}%
          </span>
        ) : null}
      </div>
      <div className="ag-task-suggestion-card__reason">{suggestion.reason}</div>
      <div className="ag-task-suggestion-card__chips">
        {operations.map((operation, index) => (
          <span key={`${operation.type}:${index}`} className="ag-task-suggestion-card__chip">
            {operation.type === "add" ? "新增任务" : operation.type === "remove" ? "移除任务" : "更新任务"}
          </span>
        ))}
        {visibleChanges.map(([key, label]) => (
          <span key={key} className="ag-task-suggestion-card__chip">{label}</span>
        ))}
        {suggestion.workingMemory ? <span className="ag-task-suggestion-card__chip">项目记忆</span> : null}
      </div>
      {applyError ? (
        <div className="ag-task-suggestion-card__error">{applyError}</div>
      ) : null}
      <div className="ag-task-suggestion-card__actions">
        <button type="button" className="ag-patch-open-btn" onClick={onDismiss} disabled={isApplying}>忽略</button>
        <button type="button" className="ag-patch-apply-btn" onClick={() => void handleApply()} disabled={isApplying}>
          {isApplying ? "应用中…" : "应用到画布"}
        </button>
      </div>
    </div>
  );
}

function AgentRuntimeSetup({
  providers,
  activeProfile,
  activeProviderId,
  isStreaming,
  compact = false,
  onSelectProviderVendor,
  onSelectModel,
}: {
  providers: ProviderConfig[];
  activeProfile: AgentProfile | null;
  activeProviderId?: string;
  isStreaming?: boolean;
  compact?: boolean;
  onSelectProviderVendor: (vendor: AgentVendor) => Promise<void>;
  onSelectModel: (model: string) => Promise<void>;
}) {
  const [cliStatus, setCliStatus] = useState<Record<string, CliAgentStatus>>({});
  const [detectingCli, setDetectingCli] = useState(true);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const runtimeRef = useRef<HTMLDivElement>(null);
  const loadCliStatus = useCallback(async () => {
    setDetectingCli(true);
    try {
      const agents = await desktop.detectCliAgents();
      const nextStatus: Record<string, CliAgentStatus> = {};
      for (const agent of agents) {
        nextStatus[agent.name] = agent;
      }
      setCliStatus(nextStatus);
    } catch (error) {
      console.warn("failed to detect CLI agents", error);
    } finally {
      setDetectingCli(false);
    }
  }, []);

  useEffect(() => {
    void loadCliStatus();
  }, [loadCliStatus]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!runtimeRef.current?.contains(event.target as Node)) {
        setIsModelMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  const activeProvider =
    providers.find((provider) => provider.id === activeProviderId) ??
    providers.find((provider) => provider.id === activeProfile?.providerId) ??
    null;
  const activeVendor =
    activeProvider && isAgentVendor(activeProvider.vendor)
      ? activeProvider.vendor
      : "claude-code";
  const activeBrand = getAgentBrand(activeVendor);
  const activeStatus = cliStatus[activeVendor];
  const runtimePrefs = readAgentRuntimePreferences(activeProvider);
  const currentModel =
    activeProfile?.model?.trim() ||
    activeProvider?.defaultModel?.trim() ||
    activeBrand.defaultModel;
  const currentVariant =
    resolveAgentModelVariant(activeVendor, currentModel, runtimePrefs.effort) ??
    resolveAgentModelSelection(
      activeVendor,
      serializeAgentModelVariant(currentModel, runtimePrefs.effort),
      runtimePrefs.effort,
    );
  const knownVariants = buildAgentModelVariants(activeVendor);
  const modelOptions = knownVariants.some((option) => option.key === currentVariant.key)
    ? knownVariants
    : [currentVariant, ...knownVariants];
  const hasMissingRuntime = !detectingCli && !activeStatus?.available;
  const statusLabel = detectingCli
    ? "检测中…"
    : activeStatus?.available
      ? activeStatus.version
        ? `v${activeStatus.version}`
        : "已就绪"
      : "未检测到";

  const vendorButtons = (
    <div
      className={`ag-runtime-vendors${compact ? " ag-runtime-vendors--compact" : ""}`}
      role="tablist"
      aria-label="选择 Agent 运行时"
    >
      {(Object.entries(AGENT_BRANDS) as [AgentVendor, (typeof AGENT_BRANDS)[AgentVendor]][]).map(
        ([vendor, brand]) => {
          const status = cliStatus[vendor];
          const unavailable = !detectingCli && !status?.available;

          return (
            <button
              key={vendor}
              type="button"
              className={`ag-runtime-chip${compact ? " ag-runtime-chip--compact" : ""}${activeVendor === vendor ? " is-active" : ""}${unavailable ? " is-unavailable" : ""}`}
              style={
                activeVendor === vendor
                  ? {
                      borderColor: brand.borderActive,
                      background: brand.accentBg,
                      color: brand.accentColor,
                    }
                  : undefined
              }
              disabled={Boolean(isStreaming)}
              onClick={() => {
                setIsModelMenuOpen(false);
                void onSelectProviderVendor(vendor);
              }}
            >
              <span className="ag-runtime-chip-icon">{brand.icon}</span>
              <span>{brand.label}</span>
            </button>
          );
        },
      )}
    </div>
  );

  useEffect(() => {
    setIsModelMenuOpen(false);
  }, [activeVendor, currentModel]);

  if (compact) {
    return (
      <div className="ag-runtime-setup ag-runtime-setup--compact" ref={runtimeRef}>
        <div className="ag-runtime-compact">
          <button
            type="button"
            className={`ag-runtime-compact-trigger${isModelMenuOpen ? " is-open" : ""}`}
            disabled={Boolean(isStreaming)}
            onClick={() => setIsModelMenuOpen((open) => !open)}
          >
            <span className="ag-runtime-compact-copy">
              <span className="ag-runtime-compact-icon">{activeBrand.icon}</span>
              <span className="ag-runtime-compact-label">{currentVariant.label}</span>
            </span>
            <span className="ag-runtime-model-caret" aria-hidden="true">▾</span>
          </button>

          {isModelMenuOpen && (
            <div className="ag-runtime-model-menu ag-runtime-model-menu--compact" role="listbox" aria-label="选择模型">
              <div className="ag-runtime-model-menu-head ag-runtime-model-menu-head--compact">
                {vendorButtons}
                <div className="ag-runtime-model-menu-meta">
                  <span
                    className={`ag-runtime-status${hasMissingRuntime ? " is-missing" : ""}`}
                    title={activeStatus?.path || activeBrand.label}
                  >
                    {statusLabel}
                  </span>
                  {hasMissingRuntime && (
                    <button
                      type="button"
                      className="ag-runtime-refresh"
                      disabled={Boolean(isStreaming)}
                      onClick={() => void loadCliStatus()}
                    >
                      重试
                    </button>
                  )}
                </div>
              </div>
              <div className="ag-runtime-model-options ag-runtime-model-options--compact">
                {modelOptions.map((model) => {
                  const isSelected = model.key === currentVariant.key;
                  return (
                    <button
                      key={model.key}
                      type="button"
                      className={`ag-runtime-model-option ag-runtime-model-option--compact${isSelected ? " is-selected" : ""}`}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => {
                        setIsModelMenuOpen(false);
                        void onSelectModel(model.key);
                      }}
                    >
                      <span className="ag-runtime-model-option-main">
                        <span className="ag-runtime-model-option-title">{model.label}</span>
                        <span className="ag-runtime-model-option-desc ag-runtime-model-option-desc--compact">{model.description}</span>
                      </span>
                      <span className="ag-runtime-model-option-meta">
                        {model.badge ? <span className="ag-runtime-model-option-badge">{model.badge}</span> : null}
                        {isSelected ? <span className="ag-runtime-model-option-check">✓</span> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
              {hasMissingRuntime && (
                <div className="ag-runtime-help ag-runtime-help--compact">
                  没能拉起 {activeBrand.label}。通常是桌面环境里缺少它依赖的 `node` 或 `PATH`。
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ag-runtime-setup" ref={runtimeRef}>
      <div className="ag-runtime-head">
        <div>
          <div className="ag-runtime-inline-label">对话运行时</div>
          <div className="ag-runtime-inline-sub">
            进入前可选，进入后也能继续切换模型与思考强度。
          </div>
        </div>
        <div className="ag-runtime-head-actions">
          <span
            className={`ag-runtime-status${hasMissingRuntime ? " is-missing" : ""}`}
            title={activeStatus?.path || activeBrand.label}
          >
            {statusLabel}
          </span>
          {hasMissingRuntime && (
            <button
              type="button"
              className="ag-runtime-refresh"
              disabled={Boolean(isStreaming)}
              onClick={() => void loadCliStatus()}
            >
              重试
            </button>
          )}
        </div>
      </div>

      <div className="ag-runtime-inline">
        {vendorButtons}

        <div className="ag-runtime-inline-model">
          <span className="ag-runtime-inline-model-label">模型</span>
          <button
            type="button"
            className={`ag-runtime-model-trigger${isModelMenuOpen ? " is-open" : ""}`}
            disabled={Boolean(isStreaming)}
            onClick={() => setIsModelMenuOpen((open) => !open)}
          >
            <span className="ag-runtime-model-copy">
              <span className="ag-runtime-model-primary">{currentVariant.label}</span>
              <span className="ag-runtime-model-secondary">
                {compact
                  ? `${activeBrand.label}${currentVariant.effort ? ` · ${formatEffortLabel(currentVariant.effort)}` : ""}`
                  : `${currentVariant.description}${currentVariant.effort ? ` · ${formatEffortLabel(currentVariant.effort)} effort` : ""}`}
              </span>
            </span>
            <span className="ag-runtime-model-caret" aria-hidden="true">▾</span>
          </button>
          {isModelMenuOpen && (
            <div className="ag-runtime-model-menu" role="listbox" aria-label="选择模型">
              {modelOptions.map((model) => {
                const isSelected = model.key === currentVariant.key;
                return (
                  <button
                    key={model.key}
                    type="button"
                    className={`ag-runtime-model-option${isSelected ? " is-selected" : ""}`}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      setIsModelMenuOpen(false);
                      void onSelectModel(model.key);
                    }}
                  >
                    <span className="ag-runtime-model-option-main">
                      <span className="ag-runtime-model-option-title">{model.label}</span>
                      <span className="ag-runtime-model-option-desc">{model.description}</span>
                    </span>
                    <span className="ag-runtime-model-option-meta">
                      {model.badge ? <span className="ag-runtime-model-option-badge">{model.badge}</span> : null}
                      {isSelected ? <span className="ag-runtime-model-option-check">✓</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

      </div>

      {hasMissingRuntime && (
        <div className="ag-runtime-help">
          没能拉起 {activeBrand.label}。通常是桌面环境里缺少它依赖的 `node` 或 `PATH`。
        </div>
      )}
    </div>
  );
}

/* ─── Bottom toolbar ──────────────────────────────────── */
function BottomBar({
  onRunAgent,
  skills,
  onToggleSkill,
  usageRecords,
  hasConversationContent,
  providers,
  activeProfile,
  activeProviderId,
  isStreaming,
  onSelectProviderVendor,
  onSelectModel,
}: {
  onRunAgent: () => void;
  skills: SkillManifest[];
  onToggleSkill: (skill: SkillManifest) => Promise<void>;
  usageRecords: UsageRecord[];
  hasConversationContent: boolean;
  providers: ProviderConfig[];
  activeProfile: AgentProfile | null;
  activeProviderId?: string;
  isStreaming?: boolean;
  onSelectProviderVendor: (vendor: AgentVendor) => Promise<void>;
  onSelectModel: (model: string) => Promise<void>;
}) {
  const [showSkills, setShowSkills] = useState(false);
  const lastRecord = usageRecords[usageRecords.length - 1];
  const ctxPct = lastRecord
    ? Math.min(100, Math.round((lastRecord.inputTokens / 200_000) * 100))
    : 0;

  return (
    <div className="ag-bottom-bar">
      {/* Skill flyout */}
      {showSkills && skills.length > 0 && (
        <div className="ag-skill-flyout">
          <SkillArsenal
            skills={skills}
            onToggleSkill={onToggleSkill}
            compact
          />
        </div>
      )}

      <div className="ag-toolbar">
        {/* Left side: + and skill toggle */}
        <div className="ag-toolbar-left">
          <button type="button" className="ag-toolbar-btn" title="执行 AI" aria-label="执行 AI" onClick={onRunAgent}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M12 5v14M5 12h14"/>
            </svg>
          </button>
          {skills.length > 0 && (
            <button
              type="button"
              className={`ag-toolbar-btn ag-planning-btn ${showSkills ? "ag-planning-btn--active" : ""}`}
              onClick={() => setShowSkills(v => !v)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
              </svg>
              Skills
            </button>
          )}
        </div>

        {/* Right side: ctx ring */}
        <div className="ag-toolbar-right">
          {hasConversationContent && (
            <AgentRuntimeSetup
              providers={providers}
              activeProfile={activeProfile}
              activeProviderId={activeProviderId}
              isStreaming={isStreaming}
              compact
              onSelectProviderVendor={onSelectProviderVendor}
              onSelectModel={onSelectModel}
            />
          )}
          {ctxPct > 0 && (
            <div className="ag-ctx-ring" title={`上下文 ${ctxPct}%`}>
              <svg viewBox="0 0 20 20" width="16" height="16">
                <circle cx="10" cy="10" r="7" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="2.5"/>
                <circle
                  cx="10" cy="10" r="7"
                  fill="none"
                  stroke="rgba(255,255,255,0.6)"
                  strokeWidth="2.5"
                  strokeDasharray={`${(ctxPct / 100) * 44} 44`}
                  strokeLinecap="round"
                  transform="rotate(-90 10 10)"
                  style={{ transition: "stroke-dasharray 0.4s ease" }}
                />
              </svg>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Flatten project tree for @ mentions ─────────────── */
function flattenTree(nodes: ProjectNode[], prefix = ""): string[] {
  const result: string[] = [];
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.kind === "file") {
      result.push(path);
    }
    if (node.children) {
      result.push(...flattenTree(node.children, path));
    }
  }
  return result;
}

/* ─── Slash commands ──────────────────────────────────── */
interface SlashCommand {
  name: string;
  description: string;
  action: "send" | "callback";
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/compile", description: "编译 LaTeX 项目", action: "send" },
  { name: "/clear", description: "清空当前对话", action: "callback" },
  { name: "/new", description: "新建对话", action: "callback" },
  { name: "/help", description: "显示可用命令", action: "callback" },
  { name: "/bash", description: "执行 shell 命令", action: "send" },
  { name: "/files", description: "列出项目文件", action: "send" },
];

function getSessionTitle(session: AgentSessionSummary) {
  return (session.title || session.lastMessagePreview || session.id).trim();
}

function getSessionPreview(session: AgentSessionSummary) {
  const preview = session.lastMessagePreview.trim();
  const title = getSessionTitle(session);
  if (!preview || preview === title) {
    return `共 ${session.messageCount} 条消息`;
  }
  return preview;
}

function formatSessionTimestamp(value: string) {
  if (!value.trim()) {
    return "";
  }

  // SQLite datetime('now') produces UTC without timezone suffix; ensure JS parses as UTC
  const normalized = value.trim();
  const date = new Date(
    normalized.includes("T") || normalized.includes("Z") || normalized.includes("+")
      ? normalized
      : normalized.replace(" ", "T") + "Z"
  );
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((startOfToday.getTime() - startOfTarget.getTime()) / 86_400_000);

  if (diffDays === 0) {
    return `今天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }
  if (diffDays === 1) {
    return `昨天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }
  if (diffDays > 1 && diffDays < 7) {
    return `${diffDays} 天前`;
  }

  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleString("zh-CN", sameYear
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "2-digit", day: "2-digit" });
}

/* ─── Main ChatPanel ──────────────────────────────────── */
export interface ChatPanelProps {
  messages: AgentMessage[];
  sessions: AgentSessionSummary[];
  activeSessionId: string;
  providers: ProviderConfig[];
  activeProfile: AgentProfile | null;
  activeProviderId?: string;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onRunAgent: () => void;
  onSendMessage: (text: string) => void;
  onSelectProviderVendor: (vendor: AgentVendor) => Promise<void>;
  onSelectModel: (model: string) => Promise<void>;
  onCancelAgent?: () => void;
  pendingPatchSummary?: string;
  pendingPatchDiff?: DiffLine[];
  onApplyPatch: () => void;
  onDismissPatch: () => void;
  streamThinkingText?: string;
  streamThinkingHistoryText?: string;
  streamThinkingDurationMs?: number;
  streamContent?: string;
  streamError?: string;
  isStreaming?: boolean;
  skills: SkillManifest[];
  onToggleSkill: (skill: SkillManifest) => Promise<void>;
  usageRecords: UsageRecord[];
  projectTree?: ProjectNode[];
  activeResearchTask?: AgentTaskContext | null;
  composerPreset?: { id: number; text: string } | null;
  onExitResearchTaskMode?: () => void;
  onOpenResearchCanvas?: () => void;
  onApplyTaskUpdateSuggestion?: (suggestion: TaskUpdateSuggestion) => Promise<void> | void;
}

export function ChatPanel({
  messages, sessions, activeSessionId, providers, activeProfile, activeProviderId,
  onSelectSession, onNewSession,
  onRunAgent, onSendMessage, onSelectProviderVendor, onSelectModel, onCancelAgent,
  pendingPatchSummary, pendingPatchDiff, onApplyPatch, onDismissPatch,
  streamThinkingText,
  streamThinkingHistoryText,
  streamThinkingDurationMs,
  streamContent, streamError, isStreaming,
  skills, onToggleSkill,
  usageRecords, projectTree,
  activeResearchTask,
  composerPreset,
  onExitResearchTaskMode,
  onOpenResearchCanvas,
  onApplyTaskUpdateSuggestion,
}: ChatPanelProps) {
  const [inputText, setInputText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sessionSearchRef = useRef<HTMLInputElement>(null);
  const [isSessionPickerOpen, setIsSessionPickerOpen] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const [dismissedSuggestionKeys, setDismissedSuggestionKeys] = useState<string[]>(() => Array.from(_appliedSuggestionKeys));
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const filteredSessions = useMemo(() => {
    const keyword = sessionQuery.trim().toLowerCase();
    if (!keyword) {
      return sessions;
    }
    return sessions.filter((session) => {
      const haystacks = [session.title, session.lastMessagePreview, session.id];
      return haystacks.some((value) => value.toLowerCase().includes(keyword));
    });
  }, [sessionQuery, sessions]);
  const latestTaskSuggestion = useMemo(() => {
    const candidate = [...messages].reverse().find((message) => {
      if (message.role !== "assistant") {
        return false;
      }
      const { suggestion } = extractTaskUpdateSuggestion(message.content);
      if (!suggestion) {
        return false;
      }
      const key = `${message.sessionId}:${message.id}`;
      return !dismissedSuggestionKeys.includes(key);
    });
    if (!candidate) {
      return null;
    }
    const { suggestion } = extractTaskUpdateSuggestion(candidate.content);
    if (!suggestion) {
      return null;
    }
    return {
      key: `${candidate.sessionId}:${candidate.id}`,
      suggestion,
    };
  }, [dismissedSuggestionKeys, messages]);

  // @ file mention state
  const [showAtMenu, setShowAtMenu] = useState(false);
  const [atFilter, setAtFilter] = useState("");
  const [atIndex, setAtIndex] = useState(0);
  const flatFiles = useMemo(() => flattenTree(projectTree ?? []), [projectTree]);
  const filteredFiles = useMemo(() => {
    if (!atFilter) return flatFiles.slice(0, 12);
    const lower = atFilter.toLowerCase();
    return flatFiles.filter(f => f.toLowerCase().includes(lower)).slice(0, 12);
  }, [flatFiles, atFilter]);

  // / slash command state
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const filteredCommands = useMemo(() => {
    if (!slashFilter) return SLASH_COMMANDS;
    const lower = slashFilter.toLowerCase();
    return SLASH_COMMANDS.filter(c => c.name.toLowerCase().includes(lower));
  }, [slashFilter]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: isStreaming ? "auto" : "smooth" });
  }, [isStreaming, messages, streamContent, streamError, streamThinkingText]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, [inputText]);

  useEffect(() => {
    if (!composerPreset) {
      return;
    }
    const nextText = composerPreset.text;
    let focusFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      setInputText(nextText);
      focusFrame = window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus();
        const nextCursor = nextText.length;
        textarea.setSelectionRange(nextCursor, nextCursor);
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (focusFrame) {
        window.cancelAnimationFrame(focusFrame);
      }
    };
  }, [composerPreset]);

  useEffect(() => {
    if (!isSessionPickerOpen) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      sessionSearchRef.current?.focus();
    });

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsSessionPickerOpen(false);
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [isSessionPickerOpen]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setDismissedSuggestionKeys(Array.from(_appliedSuggestionKeys));
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeSessionId]);

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text || isStreaming) return;
    setInputText("");
    setShowAtMenu(false);
    setShowSlashMenu(false);
    // Handle / commands
    const slashMatch = text.match(/^\/(\w+)\s*(.*)?$/);
    if (slashMatch) {
      const cmd = SLASH_COMMANDS.find(c => c.name === `/${slashMatch[1]}`);
      if (cmd) {
        if (cmd.action === "callback") {
          if (cmd.name === "/clear" || cmd.name === "/new") { onNewSession(); return; }
          if (cmd.name === "/help") {
            onSendMessage("Show me the available commands and what you can do.");
            return;
          }
        }
        if (cmd.name === "/compile") { onSendMessage("Compile the LaTeX project now."); return; }
        if (cmd.name === "/bash") { onSendMessage(`Run this shell command: ${slashMatch[2] || "ls"}`); return; }
        if (cmd.name === "/files") { onSendMessage("List all project files."); return; }
      }
    }
    onSendMessage(text);
  }, [inputText, isStreaming, onSendMessage, onNewSession]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputText(val);

    // @ mention detection
    const cursorPos = e.target.selectionStart;
    const textBefore = val.slice(0, cursorPos);
    const atMatch = textBefore.match(/@([^\s@]*)$/);
    if (atMatch) {
      setShowAtMenu(true);
      setAtFilter(atMatch[1]);
      setAtIndex(0);
      setShowSlashMenu(false);
    } else {
      setShowAtMenu(false);
    }

    // / command detection (only at start of input)
    const slashMatch = val.match(/^\/([^\s]*)$/);
    if (slashMatch && !showAtMenu) {
      setShowSlashMenu(true);
      setSlashFilter(slashMatch[1]);
      setSlashIndex(0);
    } else if (!val.startsWith("/")) {
      setShowSlashMenu(false);
    }
  }, [showAtMenu]);

  const insertAtMention = useCallback((filePath: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursorPos = ta.selectionStart;
    const textBefore = inputText.slice(0, cursorPos);
    const atStart = textBefore.lastIndexOf("@");
    if (atStart === -1) return;
    const newText = inputText.slice(0, atStart) + `@${filePath} ` + inputText.slice(cursorPos);
    setInputText(newText);
    setShowAtMenu(false);
    ta.focus();
  }, [inputText]);

  const insertSlashCommand = useCallback((cmd: SlashCommand) => {
    if (cmd.name === "/bash") {
      setInputText(`${cmd.name} `);
    } else {
      setInputText(cmd.name);
    }
    setShowSlashMenu(false);
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // @ menu navigation
    if (showAtMenu && filteredFiles.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setAtIndex(i => Math.min(i + 1, filteredFiles.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setAtIndex(i => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertAtMention(filteredFiles[atIndex]); return; }
      if (e.key === "Escape") { e.preventDefault(); setShowAtMenu(false); return; }
    }
    // / menu navigation
    if (showSlashMenu && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSlashIndex(i => Math.min(i + 1, filteredCommands.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSlashIndex(i => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertSlashCommand(filteredCommands[slashIndex]); return; }
      if (e.key === "Escape") { e.preventDefault(); setShowSlashMenu(false); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend, showAtMenu, filteredFiles, atIndex, insertAtMention, showSlashMenu, filteredCommands, slashIndex, insertSlashCommand]);

  const handleOpenSessionPicker = useCallback(() => {
    if (isStreaming) {
      return;
    }
    setSessionQuery("");
    setIsSessionPickerOpen(true);
  }, [isStreaming]);

  const handleSelectSession = useCallback((sessionId: string) => {
    onSelectSession(sessionId);
    setIsSessionPickerOpen(false);
  }, [onSelectSession]);
  const hasConversationContent =
    messages.length > 0 ||
    Boolean(activeSessionId) ||
    Boolean(streamContent) ||
    Boolean(streamThinkingText) ||
    Boolean(streamThinkingHistoryText) ||
    Boolean(streamError);

  return (
    <div className="ag-panel">
      <div className="ag-session-bar">
        <div className="ag-session-actions">
          <button
            type="button"
            className="ag-session-btn ag-session-btn--primary"
            onClick={onNewSession}
            disabled={isStreaming}
            aria-label="新对话"
            title="新对话"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            type="button"
            className={`ag-session-btn${activeSession ? " ag-session-btn--active" : ""}`}
            onClick={handleOpenSessionPicker}
            disabled={isStreaming}
            aria-label="历史对话"
            title={activeSession ? `历史对话 · ${getSessionTitle(activeSession)}` : "历史对话"}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" width="15" height="15">
              <path d="M12 8v5l3 2" />
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
        </div>
      </div>

      {activeResearchTask && (
        <div className="ag-task-mode-bar">
          <div className="ag-task-mode-bar__copy">
            <span className="ag-task-mode-bar__eyebrow">任务模式</span>
            <strong>{activeResearchTask.title}</strong>
            <span>{activeResearchTask.stage}</span>
          </div>
          <div className="ag-task-mode-bar__actions">
            {onOpenResearchCanvas ? (
              <button type="button" className="ag-patch-open-btn" onClick={onOpenResearchCanvas}>
                返回画布
              </button>
            ) : null}
            {onExitResearchTaskMode ? (
              <button type="button" className="ag-patch-open-btn" onClick={onExitResearchTaskMode}>
                退出任务模式
              </button>
            ) : null}
          </div>
        </div>
      )}

      {isSessionPickerOpen && (
        <div
          className="ag-session-picker-backdrop"
          role="presentation"
          onClick={() => setIsSessionPickerOpen(false)}
        >
          <div
            className="ag-session-picker"
            role="dialog"
            aria-modal="true"
            aria-label="选择历史会话"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ag-session-picker-head">
              <div>
                <div className="ag-session-picker-eyebrow">历史对话</div>
                <div className="ag-session-picker-title">选择一个继续处理的会话</div>
              </div>
              <button
                type="button"
                className="ag-session-picker-close"
                aria-label="关闭历史会话"
                onClick={() => setIsSessionPickerOpen(false)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="16" height="16">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>

            <label className="ag-session-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="15" height="15">
                <circle cx="11" cy="11" r="6" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                ref={sessionSearchRef}
                type="text"
                value={sessionQuery}
                onChange={(event) => setSessionQuery(event.target.value)}
                placeholder="搜索标题或历史内容"
              />
            </label>

            <div className="ag-session-picker-list">
              {filteredSessions.length === 0 ? (
                <div className="ag-session-picker-empty">
                  <div className="ag-session-picker-empty-title">
                    {sessions.length === 0 ? "还没有历史对话" : "没有匹配的历史会话"}
                  </div>
                  <div className="ag-session-picker-empty-sub">
                    {sessions.length === 0
                      ? "发送第一条消息后，对话会自动保存在这里。"
                      : "换个关键词，或者直接开始新对话。"}
                  </div>
                </div>
              ) : (
                filteredSessions.map((session) => {
                  const isActive = session.id === activeSessionId;
                  return (
                    <button
                      key={session.id}
                      type="button"
                      className={`ag-session-item${isActive ? " ag-session-item--active" : ""}`}
                      onClick={() => handleSelectSession(session.id)}
                    >
                      <div className="ag-session-item-main">
                        <div className="ag-session-item-row">
                          <span className="ag-session-item-title">{getSessionTitle(session)}</span>
                          <span className="ag-session-item-time">{formatSessionTimestamp(session.updatedAt)}</span>
                        </div>
                        <div className="ag-session-item-preview">{getSessionPreview(session)}</div>
                      </div>
                      <div className="ag-session-item-meta">
                        <span>{session.messageCount} 条</span>
                        {isActive && (
                          <span className="ag-session-item-check" aria-hidden="true">
                            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
                              <path d="M3 8.5 6.2 11.5 13 4.5" />
                            </svg>
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {!hasConversationContent && (
        <AgentRuntimeSetup
          providers={providers}
          activeProfile={activeProfile}
          activeProviderId={activeProviderId}
          isStreaming={isStreaming}
          onSelectProviderVendor={onSelectProviderVendor}
          onSelectModel={onSelectModel}
        />
      )}

      {/* Messages scroll area */}
      <div className="ag-messages">
        {!hasConversationContent && !isStreaming && (
          <div className="ag-empty">
            <div className="ag-empty-glyph">✦</div>
            <div className="ag-empty-title">开始一个新对话</div>
            <div className="ag-empty-sub">发送消息，或从历史对话里继续上一次上下文。</div>
          </div>
        )}

        {messages.map(msg => {
          if (msg.role === "user") return <UserMessage key={msg.id} msg={msg} />;
          if (msg.role === "tool") return null; // folded into assistant card
          return <AssistantMessage key={msg.id} msg={msg} />;
        })}

        {isStreaming && streamContent !== undefined && (
          <AssistantMessage
            streaming={{
              thinkingText: streamThinkingText,
              thinkingHistoryText: streamThinkingHistoryText,
              thinkingDurationMs: streamThinkingDurationMs,
              content: streamContent,
              streamError,
            }}
          />
        )}

        {pendingPatchSummary && (
          <PatchCard
            summary={pendingPatchSummary}
            diff={pendingPatchDiff}
            onApply={onApplyPatch}
            onDismiss={onDismissPatch}
          />
        )}

        {latestTaskSuggestion && onApplyTaskUpdateSuggestion && (
          <TaskSuggestionCard
            suggestion={latestTaskSuggestion.suggestion}
            activeTask={activeResearchTask}
            onDismiss={() => {
              _appliedSuggestionKeys.add(latestTaskSuggestion.key);
              setDismissedSuggestionKeys((current) => [...current, latestTaskSuggestion.key]);
            }}
            onApply={async () => {
              await onApplyTaskUpdateSuggestion(latestTaskSuggestion.suggestion);
              _appliedSuggestionKeys.add(latestTaskSuggestion.key);
              setDismissedSuggestionKeys((current) => [...current, latestTaskSuggestion.key]);
            }}
          />
        )}

        <div ref={endRef} />
      </div>

      {/* Input box */}
      <div className="ag-input-wrap">
        {/* @ file mention dropdown */}
        {showAtMenu && filteredFiles.length > 0 && (
          <div className="ag-autocomplete-menu">
            {filteredFiles.map((file, i) => (
              <button
                key={file}
                type="button"
                className={`ag-autocomplete-item${i === atIndex ? " ag-autocomplete-item--active" : ""}`}
                onMouseDown={(e) => { e.preventDefault(); insertAtMention(file); }}
              >
                <span className="ag-autocomplete-icon">📄</span>
                <span className="ag-autocomplete-path">{file}</span>
              </button>
            ))}
          </div>
        )}
        {/* / slash command dropdown */}
        {showSlashMenu && filteredCommands.length > 0 && (
          <div className="ag-autocomplete-menu">
            {filteredCommands.map((cmd, i) => (
              <button
                key={cmd.name}
                type="button"
                className={`ag-autocomplete-item${i === slashIndex ? " ag-autocomplete-item--active" : ""}`}
                onMouseDown={(e) => { e.preventDefault(); insertSlashCommand(cmd); }}
              >
                <span className="ag-autocomplete-icon">/</span>
                <span className="ag-autocomplete-path">{cmd.name}</span>
                <span className="ag-autocomplete-desc">{cmd.description}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="ag-input"
          value={inputText}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={
            isStreaming
              ? "AI 正在回复…"
              : activeResearchTask
                ? `围绕「${activeResearchTask.title}」继续讨论…`
                : "Ask anything, @ to mention, / for commands…"
          }
          disabled={isStreaming}
          rows={1}
        />
        {isStreaming ? (
          <button
            className="ag-send-btn ag-cancel-btn"
            type="button"
            onClick={onCancelAgent}
            aria-label="取消"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
          </button>
        ) : (
          <button
            className="ag-send-btn"
            type="button"
            onClick={handleSend}
            disabled={!inputText.trim()}
            aria-label="发送"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        )}
      </div>

      {/* Bottom toolbar */}
      <BottomBar
        onRunAgent={onRunAgent}
        skills={skills}
        onToggleSkill={onToggleSkill}
        usageRecords={usageRecords}
        hasConversationContent={hasConversationContent}
        providers={providers}
        activeProfile={activeProfile}
        activeProviderId={activeProviderId}
        isStreaming={isStreaming}
        onSelectProviderVendor={onSelectProviderVendor}
        onSelectModel={onSelectModel}
      />
    </div>
  );
}
