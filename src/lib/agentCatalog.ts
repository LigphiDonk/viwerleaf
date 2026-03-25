import type { ProviderConfig, ProviderMcpServerConfig } from "../types";

export type AgentVendor = "claude-code" | "codex";
export type AgentReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentModelFamily {
  value: string;
  label: string;
  description: string;
  badge?: string;
  efforts?: AgentReasoningEffort[];
  defaultEffort?: AgentReasoningEffort;
  aliases?: string[];
}

export interface AgentModelVariant {
  key: string;
  model: string;
  label: string;
  description: string;
  familyLabel: string;
  badge?: string;
  effort?: AgentReasoningEffort;
  effortLabel?: string;
}

export interface AgentBrand {
  label: string;
  icon: string;
  gradient: string;
  accentColor: string;
  accentBg: string;
  borderActive: string;
  description: string;
  models: AgentModelFamily[];
  defaultModel: string;
}

const EFFORT_LABELS: Record<AgentReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

export const AGENT_BRANDS: Record<AgentVendor, AgentBrand> = {
  "claude-code": {
    label: "Claude Code",
    icon: "✦",
    gradient: "linear-gradient(135deg, #fff4e8 0%, #ffe7d0 52%, #ffd9b2 100%)",
    accentColor: "#c2410c",
    accentBg: "rgba(194, 65, 12, 0.12)",
    borderActive: "#ea580c",
    description: "Anthropic 本机 CLI Agent",
    defaultModel: "claude-sonnet-4-6",
    models: [
      {
        value: "cli-default",
        label: "CLI 默认",
        description: "使用 Claude Code CLI 自身配置的模型（支持自定义模型如 MiniMax 等）。",
        badge: "CLI",
      },
      {
        value: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        description: "主力编码模型，平衡速度、质量和稳定性。",
        badge: "Default",
        efforts: ["low", "medium", "high"],
        defaultEffort: "high",
        aliases: ["sonnet"],
      },
      {
        value: "claude-opus-4-6",
        label: "Claude Opus 4.6",
        description: "更重的推理与规划，适合复杂重构和架构决策。",
        efforts: ["medium", "high", "max"],
        defaultEffort: "high",
        aliases: ["opus"],
      },
      {
        value: "claude-haiku-4-5",
        label: "Claude Haiku",
        description: "更轻更快，适合快速问答和小修改。",
        efforts: ["low", "medium"],
        defaultEffort: "medium",
        aliases: ["haiku"],
      },
      {
        value: "sonnet[1m]",
        label: "Claude Sonnet 4.6 [1M]",
        description: "超长上下文别名，适合大仓库或长文档。",
        badge: "Long ctx",
        efforts: ["low", "medium", "high"],
        defaultEffort: "high",
      },
    ],
  },
  codex: {
    label: "Codex",
    icon: "◌",
    gradient: "linear-gradient(135deg, #eefbf5 0%, #d8f5e8 54%, #b8ecd5 100%)",
    accentColor: "#047857",
    accentBg: "rgba(4, 120, 87, 0.12)",
    borderActive: "#059669",
    description: "OpenAI 本机 CLI Agent",
    defaultModel: "gpt-5.4",
    models: [
      {
        value: "gpt-5.4",
        label: "GPT-5.4",
        description: "当前主力通用模型，适合绝大多数编码任务。",
        badge: "Default",
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
      },
      {
        value: "gpt-5.3-codex",
        label: "GPT-5.3 Codex",
        description: "偏向代码编辑与终端执行。",
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
      },
      {
        value: "gpt-5.2-codex",
        label: "GPT-5.2 Codex",
        description: "兼顾代码生成与补丁应用。",
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
      },
      {
        value: "gpt-5.2",
        label: "GPT-5.2",
        description: "标准通用变体。",
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
      },
      {
        value: "gpt-5.1-codex-max",
        label: "GPT-5.1 Codex Max",
        description: "更偏重复杂补丁和长链路任务。",
        badge: "Max",
        efforts: ["medium", "high", "xhigh"],
        defaultEffort: "high",
      },
      {
        value: "o3",
        label: "O3",
        description: "更偏推理和分析的变体。",
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
      },
      {
        value: "o4-mini",
        label: "O4 Mini",
        description: "轻量快速，适合短回合。",
        badge: "Fast",
        efforts: ["minimal", "low", "medium"],
        defaultEffort: "low",
      },
    ],
  },
};

export const FALLBACK_BRAND = {
  label: "Agent",
  icon: "◇",
  gradient: "linear-gradient(135deg, #f0f4f8 0%, #e2e8f0 100%)",
  accentColor: "#475569",
  accentBg: "rgba(71, 85, 105, 0.08)",
  borderActive: "#64748b",
  description: "CLI Agent",
  models: [],
  defaultModel: "",
} satisfies AgentBrand;

export function isAgentVendor(vendor: string): vendor is AgentVendor {
  return vendor === "claude-code" || vendor === "codex";
}

export function getAgentBrand(vendor: string) {
  return isAgentVendor(vendor) ? AGENT_BRANDS[vendor] : FALLBACK_BRAND;
}

function normalizeAgentEffort(value: unknown): AgentReasoningEffort | undefined {
  if (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }
  return undefined;
}

export function parseProviderMetaJson(metaJson?: string): Record<string, unknown> {
  if (!metaJson?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(metaJson);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readAgentRuntimePreferences(provider?: Pick<ProviderConfig, "metaJson"> | null): {
  effort?: AgentReasoningEffort;
} {
  const meta = parseProviderMetaJson(provider?.metaJson);
  const runtime = meta.runtime;
  if (!runtime || typeof runtime !== "object") {
    return {};
  }
  const record = runtime as Record<string, unknown>;
  return {
    effort: normalizeAgentEffort(record.effort),
  };
}

export function writeAgentRuntimePreferences(
  provider: Pick<ProviderConfig, "metaJson"> | null | undefined,
  patch: { effort?: AgentReasoningEffort },
): string {
  const meta = parseProviderMetaJson(provider?.metaJson);
  const runtime = meta.runtime && typeof meta.runtime === "object"
    ? { ...(meta.runtime as Record<string, unknown>) }
    : {};

  if (patch.effort) {
    runtime.effort = patch.effort;
  } else {
    delete runtime.effort;
  }

  if (Object.keys(runtime).length === 0) {
    delete meta.runtime;
  } else {
    meta.runtime = runtime;
  }

  return JSON.stringify(meta);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}

export function normalizeProviderMcpServers(value: unknown): Record<string, ProviderMcpServerConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const servers: Record<string, ProviderMcpServerConfig> = {};
  for (const [name, rawConfig] of Object.entries(value)) {
    if (!name.trim() || !rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
      continue;
    }

    const config = rawConfig as Record<string, unknown>;
    const type = typeof config.type === "string" ? config.type : "stdio";
    const command = typeof config.command === "string" ? config.command.trim() : "";
    if (type !== "stdio" || !command) {
      continue;
    }

    const args = Array.isArray(config.args)
      ? config.args.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    const env = isStringRecord(config.env) ? config.env : undefined;

    servers[name] = {
      type: "stdio",
      command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  return servers;
}

export function readProviderMcpServers(
  provider?: Pick<ProviderConfig, "metaJson"> | null,
): Record<string, ProviderMcpServerConfig> {
  const meta = parseProviderMetaJson(provider?.metaJson);
  return normalizeProviderMcpServers(meta.mcpServers);
}

export function writeProviderMcpServers(
  provider: Pick<ProviderConfig, "metaJson"> | null | undefined,
  servers: Record<string, ProviderMcpServerConfig>,
): string {
  const meta = parseProviderMetaJson(provider?.metaJson);
  const normalized = normalizeProviderMcpServers(servers);

  if (Object.keys(normalized).length === 0) {
    delete meta.mcpServers;
  } else {
    meta.mcpServers = normalized;
  }

  return JSON.stringify(meta);
}

export function formatEffortLabel(effort?: AgentReasoningEffort) {
  return effort ? EFFORT_LABELS[effort] : "";
}

export function serializeAgentModelVariant(model: string, effort?: AgentReasoningEffort) {
  return `${encodeURIComponent(model)}::${effort ?? "default"}`;
}

export function buildAgentModelVariants(vendor: AgentVendor): AgentModelVariant[] {
  return AGENT_BRANDS[vendor].models.flatMap((family) => {
    const efforts = family.efforts?.length ? family.efforts : [undefined];
    return efforts.map((effort) => ({
      key: serializeAgentModelVariant(family.value, effort),
      model: family.value,
      label: effort ? `${family.label} (${formatEffortLabel(effort)})` : family.label,
      familyLabel: family.label,
      description: family.description,
      badge: family.badge,
      effort,
      effortLabel: effort ? formatEffortLabel(effort) : undefined,
    }));
  });
}

function findModelFamily(vendor: AgentVendor, model: string) {
  return AGENT_BRANDS[vendor].models.find((family) =>
    family.value === model || family.aliases?.includes(model),
  );
}

export function resolveAgentModelVariant(
  vendor: AgentVendor,
  model: string,
  effort?: AgentReasoningEffort,
): AgentModelVariant | null {
  const family = findModelFamily(vendor, model);
  if (!family) {
    return null;
  }

  const allowedEfforts = family.efforts ?? [];
  const resolvedEffort =
    (effort && allowedEfforts.includes(effort) ? effort : undefined) ??
    family.defaultEffort ??
    allowedEfforts[0];

  return {
    key: serializeAgentModelVariant(family.value, resolvedEffort),
    model: family.value,
    label: resolvedEffort ? `${family.label} (${formatEffortLabel(resolvedEffort)})` : family.label,
    familyLabel: family.label,
    description: family.description,
    badge: family.badge,
    effort: resolvedEffort,
    effortLabel: resolvedEffort ? formatEffortLabel(resolvedEffort) : undefined,
  };
}

export function resolveAgentModelSelection(
  vendor: AgentVendor,
  selection: string,
  fallbackEffort?: AgentReasoningEffort,
): AgentModelVariant {
  const [rawModel, rawEffort] = selection.split("::");
  const decodedModel = rawEffort ? decodeURIComponent(rawModel) : selection;
  const decodedEffort = rawEffort && rawEffort !== "default"
    ? normalizeAgentEffort(rawEffort)
    : fallbackEffort;
  return resolveAgentModelVariant(vendor, decodedModel, decodedEffort) ?? {
    key: serializeAgentModelVariant(decodedModel, decodedEffort),
    model: decodedModel,
    label: decodedEffort ? `${decodedModel} (${formatEffortLabel(decodedEffort)})` : decodedModel,
    familyLabel: decodedModel,
    description: "自定义模型",
    effort: decodedEffort,
    effortLabel: decodedEffort ? formatEffortLabel(decodedEffort) : undefined,
  };
}
