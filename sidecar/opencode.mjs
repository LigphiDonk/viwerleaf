import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { emit } from "./utils/ndjson.mjs";

const OPENCODE_VENDOR_MAP = {
  openai: "openai",
  anthropic: "anthropic",
  openrouter: "openrouter",
  deepseek: "deepseek",
  google: "google",
  custom: "openai",
};

function normalizeVendor(vendor) {
  if (typeof vendor !== "string") {
    return "";
  }
  return OPENCODE_VENDOR_MAP[vendor] || "";
}

function resolveOpencodeCliEntry() {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return join(thisDir, "node_modules", "opencode-ai", "bin", "opencode");
}

function buildModelRef(providerId, model) {
  const trimmed = typeof model === "string" ? model.trim() : "";
  if (!trimmed) {
    return "";
  }
  if (trimmed.includes("/")) {
    return trimmed;
  }
  return `${providerId}/${trimmed}`;
}

function parseJsonLine(rawLine) {
  try {
    return JSON.parse(rawLine);
  } catch {
    return null;
  }
}

function parseEventErrorMessage(event) {
  if (!event || typeof event !== "object") {
    return "unknown opencode error";
  }
  const fromData = event.error?.data?.message;
  if (typeof fromData === "string" && fromData.trim()) {
    return fromData.trim();
  }
  const fromName = event.error?.name;
  if (typeof fromName === "string" && fromName.trim()) {
    return fromName.trim();
  }
  return "unknown opencode error";
}

function normalizeToolOutput(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function buildRunMessage(request) {
  const context = request.context || {};
  const userMessage = typeof request.userMessage === "string" ? request.userMessage.trim() : "";
  const selectedText = typeof context.selectedText === "string" ? context.selectedText.trim() : "";
  const activeFile = typeof context.activeFilePath === "string" ? context.activeFilePath.trim() : "";

  if (!selectedText) {
    if (!activeFile) {
      return userMessage || "Continue.";
    }
    return [userMessage, `Current active file: ${activeFile}`].filter(Boolean).join("\n\n") || "Continue.";
  }

  const selectedLabel = activeFile ? `Selected text from ${activeFile}:` : "Selected text:";
  const selectedBlock = `${selectedLabel}\n\`\`\`\n${selectedText}\n\`\`\``;

  if (!userMessage) {
    return selectedBlock;
  }
  if (userMessage === selectedText) {
    return selectedBlock;
  }
  return `${userMessage}\n\n${selectedBlock}`;
}

function sessionMapPath(projectRoot) {
  return join(projectRoot, ".viewerleaf", "opencode-session-map.json");
}

async function readSessionMap(projectRoot) {
  const filePath = sessionMapPath(projectRoot);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

async function writeSessionMap(projectRoot, map) {
  const filePath = sessionMapPath(projectRoot);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(map, null, 2), "utf8");
}

function createOpencodeConfig(request, providerId, modelRef) {
  const providerOptions = {};
  const apiKey = request.provider?.apiKey;
  const baseUrl = request.provider?.baseUrl;

  if (typeof apiKey === "string" && apiKey.trim()) {
    providerOptions.apiKey = apiKey.trim();
  }
  if (typeof baseUrl === "string" && baseUrl.trim()) {
    providerOptions.baseURL = baseUrl.trim();
  }

  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    model: modelRef,
    enabled_providers: [providerId],
    provider: {
      [providerId]: {
        options: providerOptions,
      },
    },
  });
}

function handleOpencodeEvent(event, state) {
  if (!event || typeof event !== "object") {
    return;
  }
  if (typeof event.sessionID === "string" && event.sessionID.trim()) {
    state.opencodeSessionId = event.sessionID.trim();
  }

  if (event.type === "text") {
    const text = event.part?.text;
    if (typeof text === "string" && text.length > 0) {
      emit({ type: "text_delta", content: text });
    }
    return;
  }

  if (event.type === "tool_use") {
    const part = event.part;
    const partId = typeof part?.id === "string" ? part.id : randomUUID();
    const toolId = typeof part?.tool === "string" ? part.tool : "tool";
    const input = part?.state?.input && typeof part.state.input === "object" ? part.state.input : {};
    const status = part?.state?.status;

    if (!state.startedTools.has(partId)) {
      state.startedTools.add(partId);
      emit({ type: "tool_call_start", toolId, args: input });
    }

    if (status === "completed") {
      const output = normalizeToolOutput(part?.state?.output);
      emit({ type: "tool_call_result", toolId, output, status: "completed" });
      return;
    }

    if (status === "error") {
      const output = normalizeToolOutput(part?.state?.error || "tool failed");
      emit({ type: "tool_call_result", toolId, output, status: "error" });
    }
    return;
  }

  if (event.type === "error") {
    const message = parseEventErrorMessage(event);
    state.lastError = message;
    emit({ type: "error", message });
  }
}

async function runAndStreamOpencode(request, args, env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: request.context?.projectRoot || process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const streamState = {
      startedTools: new Set(),
      opencodeSessionId: "",
      lastError: "",
      stderr: "",
    };

    let stdoutRemainder = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutRemainder += chunk;
      let lineBreak = stdoutRemainder.indexOf("\n");
      while (lineBreak >= 0) {
        const line = stdoutRemainder.slice(0, lineBreak).trim();
        stdoutRemainder = stdoutRemainder.slice(lineBreak + 1);
        if (line.length > 0) {
          const parsed = parseJsonLine(line);
          if (parsed) {
            handleOpencodeEvent(parsed, streamState);
          }
        }
        lineBreak = stdoutRemainder.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      streamState.stderr += chunk;
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      const finalLine = stdoutRemainder.trim();
      if (finalLine.length > 0) {
        const parsed = parseJsonLine(finalLine);
        if (parsed) {
          handleOpencodeEvent(parsed, streamState);
        }
      }

      if (code !== 0) {
        const message =
          streamState.stderr.trim() ||
          streamState.lastError ||
          `opencode exited with status ${code}`;
        reject(new Error(message));
        return;
      }
      resolve(streamState);
    });

    const message = buildRunMessage(request);
    child.stdin.write(message);
    child.stdin.end();
  });
}

export function supportsOpencodeVendor(vendor) {
  return Boolean(normalizeVendor(vendor));
}

export async function runAgentWithOpencode(request) {
  const providerId = normalizeVendor(request.provider?.vendor);
  if (!providerId) {
    throw new Error(`unsupported vendor for opencode runner: ${request.provider?.vendor ?? "unknown"}`);
  }

  const modelRef = buildModelRef(providerId, request.provider?.model);
  if (!modelRef) {
    throw new Error("missing model for opencode runner");
  }

  const entry = resolveOpencodeCliEntry();
  await access(entry);

  const projectRoot =
    typeof request.context?.projectRoot === "string" && request.context.projectRoot.trim()
      ? request.context.projectRoot.trim()
      : process.cwd();

  const viewSessionId = typeof request.sessionId === "string" ? request.sessionId.trim() : "";
  const map = await readSessionMap(projectRoot);
  const mappedOpencodeSession = viewSessionId ? map[viewSessionId] : "";
  const args = [entry, "run", "--format", "json", "--model", modelRef];
  if (mappedOpencodeSession) {
    args.push("--session", mappedOpencodeSession);
  }

  const opencodeHome = join(projectRoot, ".viewerleaf", "opencode-home");
  await mkdir(opencodeHome, { recursive: true });

  const env = {
    ...process.env,
    OPENCODE_CLIENT: "viewerleaf",
    OPENCODE_TEST_HOME: opencodeHome,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_AUTO_SHARE: "0",
    OPENCODE_CONFIG_CONTENT: createOpencodeConfig(request, providerId, modelRef),
  };

  let result;
  try {
    result = await runAndStreamOpencode(request, args, env);
  } catch (error) {
    const message = error?.message || String(error);
    const sessionMissing = Boolean(mappedOpencodeSession) && /session not found/i.test(message);
    if (!sessionMissing) {
      throw error;
    }

    if (viewSessionId) {
      delete map[viewSessionId];
      await writeSessionMap(projectRoot, map);
    }

    const retryArgs = [entry, "run", "--format", "json", "--model", modelRef];
    result = await runAndStreamOpencode(request, retryArgs, env);
  }

  const newSessionId = result.opencodeSessionId;
  if (viewSessionId && newSessionId && map[viewSessionId] !== newSessionId) {
    map[viewSessionId] = newSessionId;
    await writeSessionMap(projectRoot, map);
  }

  emit({
    type: "done",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      model: request.provider?.model || modelRef,
    },
  });
}
