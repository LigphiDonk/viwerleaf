/**
 * Context window management for the agent loop.
 * Prevents token overflow by trimming conversation history.
 */

const MODEL_CONTEXT_LIMITS = {
  "claude-4": 200000,
  "claude-opus-4": 200000,
  "claude-sonnet-4": 200000,
  "claude-3.5": 200000,
  "claude-3-5": 200000,
  "claude-3": 200000,
  "gpt-4o": 128000,
  "gpt-4": 128000,
  "gpt-3.5": 16000,
  deepseek: 128000,
  default: 128000,
};

/**
 * Rough token estimation.
 * English: ~4 chars per token
 * CJK: ~2 chars per token
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const str = typeof text === "string" ? text : JSON.stringify(text);
  let cjkCount = 0;
  let otherCount = 0;
  for (const char of str) {
    if (
      /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u3040-\u309f\u30a0-\u30ff]/.test(
        char,
      )
    ) {
      cjkCount++;
    } else {
      otherCount++;
    }
  }
  return Math.ceil(cjkCount / 1.5 + otherCount / 4);
}

/**
 * Get the context token limit for a given model.
 */
export function getModelContextLimit(model) {
  const m = String(model || "").toLowerCase();
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (key !== "default" && m.includes(key)) {
      return limit;
    }
  }
  return MODEL_CONTEXT_LIMITS.default;
}

function estimateMessagesTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content);
    if (msg.tool_calls) {
      total += estimateTokens(JSON.stringify(msg.tool_calls));
    }
  }
  return total;
}

/**
 * Trim conversation history to fit within token budget.
 *
 * - Always keep the system prompt (first message)
 * - Always keep the last N messages (current round context)
 * - Remove oldest user/assistant pairs from the middle
 * - Reserve 30% of context for tool results and response
 */
export function trimHistory(messages, model) {
  const contextLimit = getModelContextLimit(model);
  const budget = Math.floor(contextLimit * 0.7);

  const currentTokens = estimateMessagesTokens(messages);
  if (currentTokens <= budget) {
    return [...messages];
  }

  const systemMessages = [];
  const conversationMessages = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      systemMessages.push(msg);
    } else {
      conversationMessages.push(msg);
    }
  }

  const systemTokens = estimateMessagesTokens(systemMessages);
  const availableBudget = budget - systemTokens;

  if (availableBudget <= 0) {
    return [
      ...systemMessages,
      conversationMessages[conversationMessages.length - 1],
    ].filter(Boolean);
  }

  const trimmed = [...conversationMessages];
  let trimmedTokens = estimateMessagesTokens(trimmed);
  const minKeep = Math.min(6, trimmed.length);

  while (trimmedTokens > availableBudget && trimmed.length > minKeep) {
    const removed = trimmed.shift();
    if (removed?.role === "user" && trimmed[0]?.role === "assistant") {
      trimmed.shift();
    }
    if (removed?.role === "assistant" && trimmed[0]?.role === "tool") {
      trimmed.shift();
    }
    trimmedTokens = estimateMessagesTokens(trimmed);
  }

  if (trimmed.length < conversationMessages.length) {
    const removedCount = conversationMessages.length - trimmed.length;
    const summaryMsg = {
      role: "user",
      content: `[System note: ${removedCount} earlier messages were trimmed to fit context window.]`,
    };
    return [...systemMessages, summaryMsg, ...trimmed];
  }

  return [...systemMessages, ...trimmed];
}
