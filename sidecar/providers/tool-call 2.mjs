const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";

function parseJsonObject(raw) {
  if (raw && typeof raw === "object") {
    return raw;
  }
  if (typeof raw !== "string" || !raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function normalizeToolArguments(toolName, rawArgs) {
  const args = parseJsonObject(rawArgs);
  const next = { ...args };
  const pathCandidate = firstString(
    next.filePath,
    next.file_path,
    next.uri,
    next.file,
    next.pathname,
    next.targetPath,
  );

  if (["read", "read_section", "list_sections", "edit", "write", "apply_text_patch", "insert_at_line"].includes(toolName)) {
    if (!firstString(next.filePath)) {
      next.filePath = pathCandidate || ".";
    }
  }

  if (["list", "glob"].includes(toolName)) {
    if (!firstString(next.path)) {
      next.path = pathCandidate || ".";
    }
  }

  if (toolName === "glob" && !firstString(next.pattern)) {
    next.pattern = firstString(next.glob, next.query, next.match);
  }

  if (["grep", "search_project"].includes(toolName) && !firstString(next.query)) {
    next.query = firstString(next.pattern, next.keyword, next.search, next.text);
  }

  const startLine = firstNumber(next.startLine, next.start_line, next.start);
  const endLine = firstNumber(next.endLine, next.end_line, next.end);
  if (startLine !== undefined && next.startLine === undefined) {
    next.startLine = startLine;
  }
  if (endLine !== undefined && next.endLine === undefined) {
    next.endLine = endLine;
  }

  const offset = firstNumber(next.offset, next.lineOffset, next.line_offset);
  const limit = firstNumber(next.limit, next.maxLines, next.max_lines);
  if (offset !== undefined) {
    next.offset = offset;
  }
  if (limit !== undefined) {
    next.limit = limit;
  }

  return next;
}

export function normalizeToolCallPayload(rawPayload) {
  const payload = parseJsonObject(rawPayload);
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const name = firstString(
    payload.name,
    payload.tool,
    payload.toolName,
    payload.tool_name,
    payload.function?.name,
  );
  if (!name) {
    return null;
  }

  const rawArgs =
    payload.arguments ??
    payload.input ??
    payload.args ??
    payload.parameters ??
    payload.function?.arguments ??
    {};

  return {
    name,
    args: normalizeToolArguments(name, rawArgs),
  };
}

export function consumeTextToolCalls(buffer, options = {}) {
  const flush = Boolean(options.flush);
  const events = [];
  let remaining = buffer;

  while (remaining.length > 0) {
    const openIndex = remaining.indexOf(TOOL_CALL_OPEN);
    if (openIndex < 0) {
      if (flush) {
        events.push({ type: "text", text: remaining });
        remaining = "";
      } else {
        const safeLength = Math.max(0, remaining.length - (TOOL_CALL_OPEN.length - 1));
        if (safeLength > 0) {
          events.push({ type: "text", text: remaining.slice(0, safeLength) });
          remaining = remaining.slice(safeLength);
        }
      }
      break;
    }

    if (openIndex > 0) {
      events.push({ type: "text", text: remaining.slice(0, openIndex) });
      remaining = remaining.slice(openIndex);
    }

    const closeIndex = remaining.indexOf(TOOL_CALL_CLOSE, TOOL_CALL_OPEN.length);
    if (closeIndex < 0) {
      if (flush) {
        events.push({ type: "text", text: remaining });
        remaining = "";
      }
      break;
    }

    const block = remaining.slice(0, closeIndex + TOOL_CALL_CLOSE.length);
    const rawPayload = remaining.slice(TOOL_CALL_OPEN.length, closeIndex).trim();
    const parsed = normalizeToolCallPayload(rawPayload);

    if (parsed) {
      events.push({ type: "tool_call", name: parsed.name, args: parsed.args });
    } else {
      events.push({ type: "text", text: block });
    }

    remaining = remaining.slice(closeIndex + TOOL_CALL_CLOSE.length);
  }

  return {
    events,
    remainder: remaining,
  };
}
