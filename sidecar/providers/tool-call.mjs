const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const TOOL_TAGS = [
  { open: "<tool_call>", close: "</tool_call>" },
  { open: "[TOOL_CALL]", close: "[/TOOL_CALL]" },
  { open: "<minimax:tool_call", close: "</minimax:tool_call>", needsOpenBracketClose: true },
  { open: "minimax:tool_call", close: "</tool>", payloadOffset: 0 },
];
const MAX_OPEN_MARKER_LENGTH = Math.max(
  THINK_OPEN.length,
  ...TOOL_TAGS.map((tag) => tag.open.length),
);

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

function normalizeArgKey(key) {
  return String(key || "")
    .trim()
    .replace(/^--/, "")
    .replace(/-+/g, "_");
}

function parseShellStyleArgs(raw) {
  const args = {};
  const pattern = /--([a-zA-Z0-9_-]+)(?:\s+(?:"([^"]*)"|'([^']*)'|([^\s}]+)))?/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const key = normalizeArgKey(match[1]);
    const value = match[2] ?? match[3] ?? match[4] ?? true;
    args[key] = value;
  }
  return args;
}

function parseArrowStyleObject(raw) {
  const args = {};
  const pattern = /([a-zA-Z0-9_-]+)\s*=>\s*(?:"([^"]*)"|'([^']*)'|([^\s,}]+))/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const key = normalizeArgKey(match[1]);
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    args[key] = value;
  }
  return args;
}

function parseColonStyleObject(raw) {
  const args = {};
  const pattern = /([a-zA-Z0-9_-]+)\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s<>,}]+))/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const key = normalizeArgKey(match[1]);
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    args[key] = value;
  }
  return args;
}

function parseInlineToolCommand(rawCommand) {
  if (typeof rawCommand !== "string" || !rawCommand.trim()) {
    return null;
  }

  const normalized = rawCommand
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return null;
  }

  const [name, ...rest] = normalized.split(/\s+/);
  if (!name || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
    return null;
  }

  const restText = rest.join(" ").trim();
  return {
    name,
    args: normalizeToolArguments(name, {
      ...parseArrowStyleObject(restText),
      ...parseColonStyleObject(restText),
      ...parseShellStyleArgs(restText),
    }),
  };
}

function parseNonJsonToolCallPayload(rawPayload) {
  if (typeof rawPayload !== "string" || !rawPayload.trim()) {
    return null;
  }

  const raw = rawPayload.trim();
  const minimaxInlineBody =
    raw.match(/(?:<)?minimax:tool_call\b[^>]*>([\s\S]*?)<\/tool>/i)?.[1] ||
    raw.match(/(?:<)?minimax:tool_call\b\s*([\s\S]*?)<\/tool>/i)?.[1] ||
    "";
  if (minimaxInlineBody) {
    const parsedInline = parseInlineToolCommand(minimaxInlineBody);
    if (parsedInline) {
      return parsedInline;
    }
  }

  const toolCodeBody = raw.match(/<tool_code\b[^>]*>([\s\S]*?)<\/tool_code>/i)?.[1] || "";
  if (toolCodeBody) {
    const normalizedBody = toolCodeBody.replace(/<id\b[^>]*>[\s\S]*?<\/id>/gi, " ").trim();
    const parsedInline = parseInlineToolCommand(normalizedBody);
    if (parsedInline) {
      return parsedInline;
    }
  }

  const genericToolBody = raw.match(/<tool\b[^>]*>([\s\S]*?)<\/tool>/i)?.[1] || "";
  if (genericToolBody) {
    const parsedInline = parseInlineToolCommand(genericToolBody);
    if (parsedInline) {
      return parsedInline;
    }
  }

  const genericOpenToolBody = raw.match(/<tool\b[^>]*>([\s\S]*)$/i)?.[1] || "";
  if (genericOpenToolBody) {
    const parsedInline = parseInlineToolCommand(genericOpenToolBody);
    if (parsedInline) {
      return parsedInline;
    }
  }

  const bareMinimaxCommand = raw.match(/^(?:<)?minimax:tool_call\b([\s\S]*)$/i)?.[1] || "";
  if (bareMinimaxCommand) {
    const parsedInline = parseInlineToolCommand(bareMinimaxCommand);
    if (parsedInline) {
      return parsedInline;
    }
  }

  const xmlInvokeName =
    raw.match(/<invoke\b[^>]*\bname="([^"]+)"/i)?.[1] ||
    raw.match(/<tool\b[^>]*\bname="([^"]+)"/i)?.[1] ||
    "";
  if (xmlInvokeName) {
    const attrs = {};
    const invokeTag = raw.match(/<(?:invoke|tool)\b([^>]*)>/i)?.[1] || "";
    const attrPattern = /([a-zA-Z0-9_:-]+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(invokeTag)) !== null) {
      const key = normalizeArgKey(attrMatch[1]);
      if (key === "name") {
        continue;
      }
      attrs[key] = attrMatch[2];
    }

    const body =
      raw.match(/<(?:invoke|tool)\b[^>]*>([\s\S]*?)<\/(?:invoke|tool)>/i)?.[1]?.trim() ||
      "";
    return {
      name: xmlInvokeName,
      args: normalizeToolArguments(xmlInvokeName, {
        ...attrs,
        ...parseArrowStyleObject(body),
        ...parseShellStyleArgs(body),
        ...(parseJsonObject(body) || {}),
      }),
    };
  }

  const name =
    raw.match(/(?:tool|name|toolName)\s*=>\s*"([^"]+)"/i)?.[1] ||
    raw.match(/(?:tool|name|toolName)\s*:\s*"([^"]+)"/i)?.[1] ||
    "";
  if (!name) {
    return parseInlineToolCommand(raw);
  }

  const argsBlock =
    raw.match(/args(?:uments)?\s*=>\s*\{([\s\S]*?)\}\s*$/i)?.[1] ||
    raw.match(/args(?:uments)?\s*:\s*\{([\s\S]*?)\}\s*$/i)?.[1] ||
    "";
  const args = {
    ...parseArrowStyleObject(argsBlock),
    ...parseColonStyleObject(argsBlock),
    ...parseShellStyleArgs(argsBlock),
  };

  const parsedNamed = {
    name,
    args: normalizeToolArguments(name, args),
  };
  if (Object.keys(parsedNamed.args).length > 0) {
    return parsedNamed;
  }

  return parseInlineToolCommand(raw);
}

export function normalizeToolArguments(toolName, rawArgs) {
  const args = parseJsonObject(rawArgs);
  const next = { ...args };
  const pathCandidate = firstString(
    next.filePath,
    next.file_path,
    next.path,
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
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return parseNonJsonToolCallPayload(typeof rawPayload === "string" ? rawPayload : "");
  }

  const name = firstString(
    payload.name,
    payload.tool,
    payload.toolName,
    payload.tool_name,
    payload.function?.name,
  );
  if (!name) {
    return parseNonJsonToolCallPayload(typeof rawPayload === "string" ? rawPayload : "");
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

export function consumeTaggedText(buffer, options = {}) {
  const flush = Boolean(options.flush);
  const nextState = {
    mode: options.state?.mode === "thinking" ? "thinking" : "text",
  };
  const events = [];
  let remaining = buffer;

  while (remaining.length > 0) {
    if (nextState.mode === "thinking") {
      const closeIndex = remaining.indexOf(THINK_CLOSE);
      if (closeIndex < 0) {
        if (flush) {
          events.push({ type: "thinking", text: remaining });
          remaining = "";
        } else {
          const safeLength = Math.max(0, remaining.length - (THINK_CLOSE.length - 1));
          if (safeLength > 0) {
            events.push({ type: "thinking", text: remaining.slice(0, safeLength) });
            remaining = remaining.slice(safeLength);
          }
        }
        break;
      }

      if (closeIndex > 0) {
        events.push({ type: "thinking", text: remaining.slice(0, closeIndex) });
      }
      events.push({ type: "thinking_end" });
      remaining = remaining.slice(closeIndex + THINK_CLOSE.length);
      nextState.mode = "text";
      continue;
    }

    const thinkIndex = remaining.indexOf(THINK_OPEN);
    const toolMatch = TOOL_TAGS
      .map((tag) => ({ tag, index: remaining.indexOf(tag.open) }))
      .filter((item) => item.index >= 0)
      .sort((left, right) => left.index - right.index)[0];
    const openIndexCandidates = [thinkIndex, toolMatch?.index ?? -1].filter((value) => value >= 0);
    const openIndex = openIndexCandidates.length > 0 ? Math.min(...openIndexCandidates) : -1;

    if (openIndex < 0) {
      if (flush) {
        events.push({ type: "text", text: remaining });
        remaining = "";
      } else {
        const safeLength = Math.max(0, remaining.length - (MAX_OPEN_MARKER_LENGTH - 1));
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
      continue;
    }

    if (remaining.startsWith(THINK_OPEN)) {
      events.push({ type: "thinking_start" });
      remaining = remaining.slice(THINK_OPEN.length);
      nextState.mode = "thinking";
      continue;
    }

    const matchedTag = TOOL_TAGS.find((tag) => remaining.startsWith(tag.open));
    if (!matchedTag) {
      events.push({ type: "text", text: remaining[0] });
      remaining = remaining.slice(1);
      continue;
    }

    const payloadStart = matchedTag.needsOpenBracketClose
      ? remaining.indexOf(">")
      : matchedTag.open.length + (matchedTag.payloadOffset ?? -1);
    if (matchedTag.needsOpenBracketClose && payloadStart < 0) {
      if (flush) {
        events.push({ type: "text", text: remaining });
        remaining = "";
      }
      break;
    }

    let effectiveClose = matchedTag.close;
    let closeIndex = remaining.indexOf(matchedTag.close, Math.max(matchedTag.open.length, payloadStart + 1));
    if (closeIndex < 0 && matchedTag.open.includes("minimax:tool_call")) {
      const toolCloseIndex = remaining.indexOf("</tool>", Math.max(matchedTag.open.length, payloadStart + 1));
      if (toolCloseIndex >= 0) {
        closeIndex = toolCloseIndex;
        effectiveClose = "</tool>";
      }
    }
    if (closeIndex < 0) {
      if (flush) {
        const rawPayload = remaining.slice(payloadStart + 1).trim();
        const parsed = normalizeToolCallPayload(rawPayload);
        if (parsed) {
          events.push({ type: "tool_call", name: parsed.name, args: parsed.args, source: "tagged" });
          remaining = "";
          break;
        }
        events.push({ type: "text", text: remaining });
        remaining = "";
      }
      break;
    }

    const block = remaining.slice(0, closeIndex + effectiveClose.length);
    const rawPayload = remaining.slice(payloadStart + 1, closeIndex).trim();
    const parsed = normalizeToolCallPayload(rawPayload);

    if (parsed) {
      events.push({ type: "tool_call", name: parsed.name, args: parsed.args, source: "tagged" });
    } else {
      events.push({ type: "text", text: block });
    }

    remaining = remaining.slice(closeIndex + effectiveClose.length);
  }

  return {
    events,
    remainder: remaining,
    state: nextState,
  };
}

export function consumeTextToolCalls(buffer, options = {}) {
  return consumeTaggedText(buffer, options);
}
