import { createOpenAIProvider } from "./openai.mjs";

export function createGenericProvider(config) {
  return createOpenAIProvider(config);
}
