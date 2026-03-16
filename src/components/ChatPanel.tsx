import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import type {
  AgentMessage,
  AgentSessionSummary,
  DiffLine,
  ProjectNode,
  SkillManifest,
  StreamToolCall,
  UsageRecord,
} from "../types";

/* ─── stream block parser ─────────────────────────────── */
interface ToolCallBlock {
  id: string;
  toolId: string;
  args?: Record<string, unknown>;
  output?: string;
  status: "running" | "completed" | "error" | "requested";
}
interface StreamBlock {
  text: string;
  toolCalls: ToolCallBlock[];
  thoughtText: string;
}

const SERIALIZED_TOOL_BLOCK_RE = /\[Tool: ([^\]]+)\]\s*(?:\r?\n\[Result: ([\s\S]*?)\])?(?=(?:\r?\n){2}\[Tool: |\s*$)/g;
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

function parseStreamBlocks(raw: string): StreamBlock {
  const toolCalls: ToolCallBlock[] = [];
  const thoughtText = Array.from(raw.matchAll(/<think>\s*([\s\S]*?)\s*<\/think>/g))
    .map((match) => match[1]?.trim() ?? "")
    .filter((value) => value.length > 0)
    .join("\n\n");

  let m: RegExpExecArray | null;
  while ((m = SERIALIZED_TOOL_BLOCK_RE.exec(raw)) !== null) {
    if (m[1]) {
      const output = m[2]?.trim();
      toolCalls.push({
        id: `${m.index}-${m[1]}`,
        toolId: m[1],
        output,
        status: output ? "completed" : "running",
      });
    }
  }

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
  }
  const text = raw
    .replace(SERIALIZED_TOOL_BLOCK_RE, "")
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
  return { text, toolCalls, thoughtText };
}

function toToolCallBlock(call: StreamToolCall): ToolCallBlock {
  return {
    id: call.id,
    toolId: call.toolId,
    args: call.args,
    output: call.output,
    status: call.status,
  };
}

function summarizeToolCall(call: ToolCallBlock) {
  const firstStringArg = (() => {
    if (!call.args) {
      return "";
    }
    const candidates = [
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
    default:
      return `${requestedPrefix}调用 ${call.toolId}${target ? ` · ${target}` : ""}`;
  }
}

/* ─── Tool call card ──────────────────────────────────── */
function ToolCallCard({ call }: { call: ToolCallBlock }) {
  const [open, setOpen] = useState(false);
  const isRunning = call.status === "running";
  const isError = call.status === "error";
  const isRequested = call.status === "requested";
  const summary = summarizeToolCall(call);
  const preview = call.output?.trim()
    ? call.output.trim().split("\n").find((line) => line.trim().length > 0) ?? ""
    : "";
  const shortPreview = preview.length > 92 ? `${preview.slice(0, 92)}…` : preview;

  // Extract a short arg summary for inline display
  const argSummary = (() => {
    if (!call.args) return "";
    const vals = Object.values(call.args).filter(v => typeof v === "string" || typeof v === "number");
    if (!vals.length) return "";
    const first = String(vals[0]);
    return first.length > 60 ? first.slice(0, 60) + "…" : first;
  })();

  return (
    <div className={`ag-tool-card${isError ? " ag-tool-card--error" : ""}`}>
      <button type="button" className="ag-tool-header" onClick={() => setOpen(v => !v)}>
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
        {argSummary && !shortPreview && <span className="ag-tool-arg">{argSummary}</span>}
        {shortPreview && !open && <span className="ag-tool-preview">{shortPreview}</span>}
        {(call.output || call.args) && (
          <span className="ag-tool-chevron">{open ? "▾" : "▸"}</span>
        )}
      </button>
      {open && (
        <div className="ag-tool-body">
          {call.args && Object.keys(call.args).length > 0 && (
            <pre className="ag-tool-args">{JSON.stringify(call.args, null, 2)}</pre>
          )}
          {call.output && (
            <pre className="ag-tool-output">{call.output}</pre>
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
    text: string;
    toolCalls?: ToolCallBlock[];
    streamError?: string;
  };
}) {
  const raw = msg?.content ?? streaming?.text ?? "";
  const parsed = parseStreamBlocks(raw);
  const clean = parsed.text;
  const toolCalls = streaming?.toolCalls ?? parsed.toolCalls;
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
      {clean && (
        <div className="ag-assistant-text">
          <ReactMarkdown>{clean}</ReactMarkdown>
        </div>
      )}
      {toolCalls.map((c, i) => (
        <ToolCallCard key={c.id || i} call={c} />
      ))}
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

/* ─── Bottom toolbar ──────────────────────────────────── */
function BottomBar({
  onRunAgent,
  skills,
  onToggleSkill,
  usageRecords,
}: {
  onRunAgent: () => void;
  skills: SkillManifest[];
  onToggleSkill: (skill: SkillManifest) => Promise<void>;
  usageRecords: UsageRecord[];
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
          {skills.map(skill => {
            const active = skill.isEnabled ?? skill.enabled ?? false;
            return (
              <button
                key={skill.id}
                type="button"
                className={`ag-skill-item ${active ? "ag-skill-item--on" : ""}`}
                onClick={() => void onToggleSkill(skill)}
              >
                <span className={`ag-skill-dot ${active ? "ag-skill-dot--on" : ""}`} />
                {skill.name}
              </button>
            );
          })}
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

  const date = new Date(value);
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
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onRunAgent: () => void;
  onSendMessage: (text: string) => void;
  onCancelAgent?: () => void;
  pendingPatchSummary?: string;
  pendingPatchDiff?: DiffLine[];
  onApplyPatch: () => void;
  onDismissPatch: () => void;
  streamThinkingText?: string;
  streamThinkingHistoryText?: string;
  streamThinkingDurationMs?: number;
  streamText?: string;
  streamToolCalls?: StreamToolCall[];
  streamError?: string;
  isStreaming?: boolean;
  skills: SkillManifest[];
  onToggleSkill: (skill: SkillManifest) => Promise<void>;
  usageRecords: UsageRecord[];
  projectTree?: ProjectNode[];
}

export function ChatPanel({
  messages, sessions, activeSessionId, onSelectSession, onNewSession,
  onRunAgent, onSendMessage, onCancelAgent,
  pendingPatchSummary, pendingPatchDiff, onApplyPatch, onDismissPatch,
  streamThinkingText,
  streamThinkingHistoryText,
  streamThinkingDurationMs,
  streamText, streamToolCalls, streamError, isStreaming,
  skills, onToggleSkill,
  usageRecords, projectTree,
}: ChatPanelProps) {
  const [inputText, setInputText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sessionSearchRef = useRef<HTMLInputElement>(null);
  const normalizedStreamToolCalls = (streamToolCalls ?? []).map(toToolCallBlock);
  const [isSessionPickerOpen, setIsSessionPickerOpen] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
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
  }, [isStreaming, messages, streamError, streamText, streamThinkingText, normalizedStreamToolCalls.length]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, [inputText]);

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
    if (isStreaming || sessions.length === 0) {
      return;
    }
    setSessionQuery("");
    setIsSessionPickerOpen(true);
  }, [isStreaming, sessions.length]);

  const handleSelectSession = useCallback((sessionId: string) => {
    onSelectSession(sessionId);
    setIsSessionPickerOpen(false);
  }, [onSelectSession]);

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
            disabled={isStreaming || sessions.length === 0}
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
                  <div className="ag-session-picker-empty-title">没有匹配的历史会话</div>
                  <div className="ag-session-picker-empty-sub">换个关键词，或者直接开始新对话。</div>
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

      {/* Messages scroll area */}
      <div className="ag-messages">
        {messages.length === 0 && !isStreaming && (
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

        {isStreaming && streamText !== undefined && (
          <AssistantMessage
            streaming={{
              thinkingText: streamThinkingText,
              thinkingHistoryText: streamThinkingHistoryText,
              thinkingDurationMs: streamThinkingDurationMs,
              text: streamText,
              toolCalls: normalizedStreamToolCalls,
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
          placeholder={isStreaming ? "AI 正在回复…" : "Ask anything, @ to mention, / for commands…"}
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
      />
    </div>
  );
}
