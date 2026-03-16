import { createAnthropicProvider } from "./anthropic.mjs";
import { createGenericProvider } from "./generic.mjs";
import { createOpenAIProvider } from "./openai.mjs";

export function loadProvider(providerConfig) {
  switch (providerConfig.vendor) {
    case "openai":
    case "openrouter":
    case "deepseek":
      return createOpenAIProvider(providerConfig);
    case "custom":
      return createGenericProvider(providerConfig);
    case "anthropic":
    case "google":
    default:
      return createAnthropicProvider(providerConfig);
  }
}
