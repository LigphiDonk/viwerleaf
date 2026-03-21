export type AgentVendor = "claude-code" | "codex";

export interface AgentBrand {
  label: string;
  icon: string;
  gradient: string;
  accentColor: string;
  accentBg: string;
  borderActive: string;
  description: string;
  models: { value: string; label: string }[];
  defaultModel: string;
}

export const AGENT_BRANDS: Record<AgentVendor, AgentBrand> = {
  "claude-code": {
    label: "Claude Code",
    icon: "⚡",
    gradient: "linear-gradient(135deg, #fef3e2 0%, #fde8c9 50%, #fce4bb 100%)",
    accentColor: "#c2410c",
    accentBg: "rgba(194, 65, 12, 0.08)",
    borderActive: "#ea580c",
    description: "Anthropic 本机 CLI Agent",
    defaultModel: "claude-opus-4-6",
    models: [
      { value: "claude-opus-4-6", label: "Opus 4.6" },
      { value: "sonnet", label: "Sonnet" },
      { value: "opus", label: "Opus" },
      { value: "haiku", label: "Haiku" },
      { value: "sonnet[1m]", label: "Sonnet [1M]" },
    ],
  },
  codex: {
    label: "Codex",
    icon: "🧠",
    gradient: "linear-gradient(135deg, #ecfdf5 0%, #d1fae5 50%, #a7f3d0 100%)",
    accentColor: "#047857",
    accentBg: "rgba(4, 120, 87, 0.08)",
    borderActive: "#059669",
    description: "OpenAI 本机 CLI Agent",
    defaultModel: "gpt-5.4",
    models: [
      { value: "gpt-5.4", label: "GPT-5.4" },
      { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { value: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
      { value: "gpt-5.2", label: "GPT-5.2" },
      { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
      { value: "o3", label: "O3" },
      { value: "o4-mini", label: "O4 Mini" },
    ],
  },
};

export const FALLBACK_BRAND = {
  label: "Agent",
  icon: "🤖",
  gradient: "linear-gradient(135deg, #f0f4f8 0%, #e2e8f0 100%)",
  accentColor: "#475569",
  accentBg: "rgba(71, 85, 105, 0.08)",
  borderActive: "#64748b",
  description: "CLI Agent",
  models: [],
  defaultModel: "",
};

export function isAgentVendor(vendor: string): vendor is AgentVendor {
  return vendor === "claude-code" || vendor === "codex";
}

export function getAgentBrand(vendor: string) {
  return isAgentVendor(vendor) ? AGENT_BRANDS[vendor] : FALLBACK_BRAND;
}
