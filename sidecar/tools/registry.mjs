import { applyPatchTool } from "./apply-patch.mjs";
import { applyTextPatch } from "./apply-text-patch.mjs";
import { editTool } from "./edit.mjs";
import { globTool } from "./glob.mjs";
import { grepTool } from "./grep.mjs";
import { insertAtLine } from "./insert-at-line.mjs";
import { listFiles } from "./list-files.mjs";
import { listTool } from "./list.mjs";
import { listSections } from "./list-sections.mjs";
import { readBibEntries } from "./read-bib-entries.mjs";
import { readSection } from "./read-section.mjs";
import { readTool } from "./read.mjs";
import { searchProject } from "./search-project.mjs";
import { writeTool } from "./write.mjs";

const TOOL_SPECS = [
  {
    tool: listTool,
    keywords: ["project", "workspace", "structure", "tree", "files", "folders", "目录", "结构", "项目", "工作区"],
  },
  {
    tool: readTool,
    keywords: ["read", "file", "content", "lines", "查看", "读取", "内容", "文件"],
  },
  {
    tool: globTool,
    keywords: ["glob", "match", "pattern", "find files", "查找文件", "文件匹配"],
  },
  {
    tool: grepTool,
    keywords: ["grep", "search", "keyword", "regex", "text search", "搜索", "关键词", "查找内容"],
  },
  {
    tool: editTool,
    keywords: ["edit", "replace", "modify", "rewrite", "change", "修改", "替换", "改写"],
  },
  {
    tool: writeTool,
    keywords: ["write", "create", "overwrite", "generate", "写入", "创建", "生成文件"],
  },
  {
    tool: applyPatchTool,
    keywords: ["patch", "diff", "multi-file", "批量修改", "补丁", "多文件"],
  },
  {
    tool: listFiles,
    keywords: ["legacy", "project structure", "latex files", "旧版结构工具"],
  },
  {
    tool: readSection,
    keywords: ["latex", "section", "tex", "line range", "论文", "章节", "tex"],
  },
  {
    tool: listSections,
    keywords: ["latex outline", "sections", "subsections", "提纲", "章节结构", "论文结构"],
  },
  {
    tool: readBibEntries,
    keywords: ["bib", "bibliography", "citation", "reference", "参考文献", "引用"],
  },
  {
    tool: searchProject,
    keywords: ["legacy search", "tex search", "bib search", "旧版搜索"],
  },
  {
    tool: applyTextPatch,
    keywords: ["legacy patch", "tex replace", "line replace", "旧版 tex 修改"],
  },
  {
    tool: insertAtLine,
    keywords: ["insert line", "tex insert", "插入行", "旧版 tex 插入"],
  },
];

const TOOL_SEARCH_DESCRIPTION =
  "Search the available tools and return the most relevant tool ids for the current request. Use this first when you are not sure which tool to call next.";

function scoreToolMatch(spec, query, context) {
  const haystack = `${spec.tool.id} ${spec.tool.description} ${spec.keywords.join(" ")}`.toLowerCase();
  const activeFilePath = String(context?.activeFilePath || "").toLowerCase();
  let score = 0;

  for (const token of query.split(/\s+/).filter(Boolean)) {
    if (haystack.includes(token)) {
      score += token.length > 2 ? 3 : 1;
    }
  }

  if ((activeFilePath.endsWith(".tex") || activeFilePath.endsWith(".bib")) && spec.keywords.some((item) => /latex|tex|bib|citation|论文|章节|参考文献/.test(item))) {
    score += 2;
  }

  if (spec.tool.id === "read" && /read|view|读取|查看|内容/.test(query)) {
    score += 3;
  }
  if (spec.tool.id === "list" && /project|workspace|structure|目录|结构|项目/.test(query)) {
    score += 3;
  }
  if (spec.tool.id === "grep" && /search|keyword|grep|查|搜索|找/.test(query)) {
    score += 3;
  }
  if ((spec.tool.id === "edit" || spec.tool.id === "write" || spec.tool.id === "apply_patch") && /edit|modify|change|rewrite|replace|写|改|修改|替换|补丁/.test(query)) {
    score += 3;
  }

  return score;
}

function searchToolSpecs({ allowlist, query, context, limit = 6 }) {
  const normalizedQuery = String(query || "").toLowerCase().trim();
  const allowed = new Set(allowlist);
  const matches = TOOL_SPECS.filter((spec) => allowed.has(spec.tool.id))
    .map((spec) => {
      const score = scoreToolMatch(spec, normalizedQuery, context);
      return {
        id: spec.tool.id,
        description: spec.tool.description,
        reason: spec.keywords.slice(0, 3).join(", "),
        score,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

  if (matches.length > 0) {
    return matches.slice(0, limit);
  }

  return TOOL_PRIORITY.filter((id) => allowed.has(id))
    .slice(0, limit)
    .map((id) => ({
      id,
      description: TOOL_MAP.get(id)?.description || "",
      reason: "default fallback",
      score: 0,
    }));
}

const toolSearchTool = {
  id: "tool_search",
  description: TOOL_SEARCH_DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What you are trying to do, in short natural language.",
      },
      limit: {
        type: "number",
        description: "Maximum number of candidate tools to return. Defaults to 6.",
      },
    },
    required: ["query"],
  },
  async execute(args, ctx) {
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(8, Number(args.limit))) : 6;
    const allowlist =
      Array.isArray(ctx.requestedToolIds) && ctx.requestedToolIds.length > 0
        ? ctx.requestedToolIds.filter((id) => id !== "tool_search")
        : getAllToolIds().filter((id) => id !== "tool_search");
    const discoveredTools = searchToolSpecs({
      allowlist,
      query: args.query,
      context: ctx,
      limit,
    });
    return {
      output: JSON.stringify(discoveredTools, null, 2),
      metadata: {
        discoveredToolIds: discoveredTools.map((item) => item.id),
      },
    };
  },
};

const ALL_TOOLS = [
  toolSearchTool,
  ...TOOL_SPECS.map((spec) => spec.tool),
];

const TOOL_MAP = new Map(ALL_TOOLS.map((tool) => [tool.id, tool]));

const TOOL_PRIORITY = [
  "tool_search",
  "list",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "apply_patch",
  "list_sections",
  "read_section",
  "read_bib_entries",
  "list_files",
  "search_project",
  "apply_text_patch",
  "insert_at_line",
];

const STRUCTURE_RE = /(project|workspace|structure|tree|files?|folders?|目录|结构|项目|工作区|文件|文件夹)/i;
const SEARCH_RE = /(search|find|grep|lookup|where|contains?|keyword|查|搜|搜索|找|定位|关键词)/i;
const EDIT_RE =
  /(edit|modify|change|rewrite|write|create|insert|replace|fix|update|patch|删除|添加|新增|插入|替换|修改|改写|润色|补充|生成|创建|写入)/i;
const LATEX_RE =
  /(latex|\.tex\b|tex\b|paper|thesis|论文|章节|section|subsection|outline|提纲|摘要|参考文献|bib|citation|cite|文献)/i;
const BIB_RE = /(bib|citation|cite|reference|references|参考文献|引用|文献)/i;

function uniqToolIds(toolIds) {
  const seen = new Set();
  const result = [];
  for (const id of toolIds) {
    if (!TOOL_MAP.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

function prioritizeToolIds(toolIds) {
  const prioritized = [];
  const seen = new Set();
  for (const id of TOOL_PRIORITY) {
    if (toolIds.includes(id)) {
      prioritized.push(id);
      seen.add(id);
    }
  }
  for (const id of toolIds) {
    if (!seen.has(id)) {
      prioritized.push(id);
    }
  }
  return prioritized;
}

function addIfAllowed(selected, allowed, toolId) {
  if (allowed.has(toolId) && TOOL_MAP.has(toolId)) {
    selected.add(toolId);
  }
}

function inferIntent(userMessage, context) {
  const text = [
    typeof userMessage === "string" ? userMessage : "",
    typeof context?.selectedText === "string" ? context.selectedText : "",
    typeof context?.activeFilePath === "string" ? context.activeFilePath : "",
  ]
    .join("\n")
    .toLowerCase();

  const activeFilePath = String(context?.activeFilePath || "").toLowerCase();
  const isLatexFile = activeFilePath.endsWith(".tex") || activeFilePath.endsWith(".bib");

  return {
    wantsStructure: STRUCTURE_RE.test(text),
    wantsSearch: SEARCH_RE.test(text),
    wantsEdit: EDIT_RE.test(text),
    wantsLatex: LATEX_RE.test(text) || isLatexFile,
    wantsBibliography: BIB_RE.test(text) || activeFilePath.endsWith(".bib"),
  };
}

function chooseToolIds(allowedIds, userMessage, context) {
  const allowed = new Set(allowedIds);
  const selected = new Set();
  const intent = inferIntent(userMessage, context);

  if (!intent.wantsEdit || intent.wantsStructure || intent.wantsSearch || intent.wantsLatex) {
    addIfAllowed(selected, allowed, "list");
    addIfAllowed(selected, allowed, "read");
    addIfAllowed(selected, allowed, "glob");
    addIfAllowed(selected, allowed, "grep");
    addIfAllowed(selected, allowed, "list_files");
    addIfAllowed(selected, allowed, "search_project");
  }

  if (intent.wantsLatex) {
    addIfAllowed(selected, allowed, "list_sections");
    addIfAllowed(selected, allowed, "read_section");
  }

  if (intent.wantsBibliography) {
    addIfAllowed(selected, allowed, "read_bib_entries");
  }

  if (intent.wantsEdit || (context?.selectedText && String(context.selectedText).trim())) {
    addIfAllowed(selected, allowed, "read");
    addIfAllowed(selected, allowed, "edit");
    addIfAllowed(selected, allowed, "write");
    addIfAllowed(selected, allowed, "apply_patch");
    addIfAllowed(selected, allowed, "apply_text_patch");
    addIfAllowed(selected, allowed, "insert_at_line");
  }

  if (selected.size === 0) {
    for (const id of TOOL_PRIORITY) {
      if (allowed.has(id)) {
        selected.add(id);
      }
      if (selected.size >= 6) {
        break;
      }
    }
  }

  return prioritizeToolIds([...selected]);
}

function shouldStartWithToolSearch(intent, userMessage, context, allowlist, discoveredToolIds) {
  if (!allowlist.includes("tool_search") || discoveredToolIds.length > 0) {
    return false;
  }

  if (context?.selectedText && String(context.selectedText).trim()) {
    return false;
  }

  const text = String(userMessage || "");
  if (/tool|工具/.test(text)) {
    return true;
  }

  return intent.wantsStructure || intent.wantsSearch || intent.wantsLatex;
}

function buildDiscoveredToolSet(allowlist, discoveredToolIds) {
  const selected = new Set();
  const allowed = new Set(allowlist);

  if (allowed.has("tool_search")) {
    selected.add("tool_search");
  }

  for (const id of discoveredToolIds) {
    addIfAllowed(selected, allowed, id);
  }

  if ([...selected].some((id) => ["edit", "write", "apply_patch", "apply_text_patch", "insert_at_line"].includes(id))) {
    addIfAllowed(selected, allowed, "read");
  }

  return prioritizeToolIds([...selected]);
}

export function getTools(toolIds) {
  return uniqToolIds(toolIds).map((id) => TOOL_MAP.get(id));
}

export function getAllTools() {
  return [...ALL_TOOLS];
}

export function getAllToolIds() {
  return ALL_TOOLS.map((tool) => tool.id);
}

export function resolveActiveTools({ requestedToolIds, userMessage, context, discoveredToolIds = [] }) {
  const allowlist = uniqToolIds(
    Array.isArray(requestedToolIds) && requestedToolIds.length > 0 ? requestedToolIds : getAllToolIds(),
  );
  const intent = inferIntent(userMessage, context);
  let selectedToolIds;

  if (shouldStartWithToolSearch(intent, userMessage, context, allowlist, discoveredToolIds)) {
    selectedToolIds = ["tool_search"];
  } else if (Array.isArray(discoveredToolIds) && discoveredToolIds.length > 0) {
    selectedToolIds = buildDiscoveredToolSet(allowlist, uniqToolIds(discoveredToolIds));
  } else {
    selectedToolIds = chooseToolIds(allowlist, userMessage, context);
  }

  const tools = selectedToolIds.map((id) => TOOL_MAP.get(id)).filter(Boolean);

  if (tools.length > 0) {
    return {
      toolIds: selectedToolIds,
      tools,
    };
  }

  return {
    toolIds: allowlist,
    tools: allowlist.map((id) => TOOL_MAP.get(id)).filter(Boolean),
  };
}
