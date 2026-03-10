import { createAnthropicProvider } from "./anthropic.mjs";
import { createGenericProvider } from "./generic.mjs";
import { createOpenAIProvider } from "./openai.mjs";

export function loadProvider(providerConfig) {
  switch (providerConfig.vendor) {
    case "openai":
      return createOpenAIProvider(providerConfig);
    case "anthropic":
      return createAnthropicProvider(providerConfig);
    case "openrouter":
    case "deepseek":
    case "google":
    case "custom":
    default:
      return createGenericProvider(providerConfig);
  }
}
