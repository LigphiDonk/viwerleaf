import type { ProviderPreset } from "../types";

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    vendor: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "o3-mini"],
  },
  {
    vendor: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-4", "claude-haiku-4-5", "claude-opus-4"],
  },
  {
    vendor: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: ["anthropic/claude-3.7-sonnet", "deepseek/deepseek-chat", "google/gemini-2.5-pro"],
  },
  {
    vendor: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    vendor: "google",
    name: "Google AI",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  {
    vendor: "banana",
    name: "Banana (ikun)",
    baseUrl: "https://api.ikuncode.cc/v1",
    models: ["gemini-3-pro-image-preview"],
  },
  {
    vendor: "custom",
    name: "Custom (OpenAI-compatible)",
    baseUrl: "",
    models: [],
  },
];
