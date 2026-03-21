import { useEffect, useMemo, useRef, useState } from "react";

import { desktop } from "../lib/desktop";
import { useStableCallback as useEffectEvent } from "./useStableCallback";
import type {
  AgentMessage,
  AgentProfile,
  AgentProfileId,
  AgentSessionSummary,
  DiffLine,
  ProjectFile,
  UsageRecord,
  WorkspaceSnapshot,
} from "../types";

function safelyDisposeListener(listener?: (() => void | Promise<void>) | null) {
  if (!listener) {
    return;
  }

  try {
    const result = listener();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      void (result as Promise<unknown>).catch((error) => {
        console.warn("failed to dispose listener", error);
      });
    }
  } catch (error) {
    console.warn("failed to dispose listener", error);
  }
}

function buildAssistantSnapshotContent({
  thinkingText,
  content,
}: {
  thinkingText: string;
  content: string;
}) {
  const parts: string[] = [];
  const trimmedThinking = thinkingText.trim();
  const trimmedContent = content.trim();

  if (trimmedThinking) {
    parts.push(`<think>\n${trimmedThinking}\n</think>`);
  }
  if (trimmedContent) {
    parts.push(trimmedContent);
  }

  return parts.join("\n\n").trim();
}

function mergeThinkingSegments(historyText: string, currentText: string) {
  const parts = [historyText.trim(), currentText.trim()].filter((value, index, all) => value && all.indexOf(value) === index);
  return parts.join("\n\n");
}

interface UseAgentChatParams {
  snapshot: WorkspaceSnapshot | null;
  activeFile: ProjectFile | null;
  selectedText: string;
  cursorLine: number;
  replaceFileContent: (path: string, content: string) => void;
  addDirtyPath: (path: string) => void;
  refreshWorkspace: () => Promise<void>;
}

export interface AgentChatState {
  messages: AgentMessage[];
  agentSessions: AgentSessionSummary[];
  activeSessionId: string;
  usageRecords: UsageRecord[];
  activeProfileId: AgentProfileId;
  activeProfile: AgentProfile | null;
  isStreaming: boolean;
  streamThinkingText: string;
  streamThinkingHistoryText: string;
  streamThinkingDurationMs: number;
  streamContent: string;
  streamError: string;
  pendingPatch: { filePath: string; content: string; summary: string; diff?: DiffLine[] } | null;
  setActiveProfileId: (profileId: AgentProfileId) => void;
  handleRunAgent: () => Promise<void>;
  handleSendMessage: (text: string) => Promise<void>;
  handleNewSession: () => void;
  handleSelectSession: (sessionId: string) => Promise<void>;
  handleApplyPatch: () => Promise<void>;
  handleDismissPatch: () => void;
  handleCancelAgent: () => Promise<void>;
  resetForSnapshot: () => void;
}

export function useAgentChat({
  snapshot,
  activeFile,
  selectedText,
  replaceFileContent,
}: UseAgentChatParams): AgentChatState {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [agentSessions, setAgentSessions] = useState<AgentSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [usageRecords, setUsageRecords] = useState<UsageRecord[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<AgentProfileId>("chat");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamThinkingText, setStreamThinkingText] = useState("");
  const [streamThinkingHistoryText, setStreamThinkingHistoryText] = useState("");
  const [streamThinkingDurationMs, setStreamThinkingDurationMs] = useState(0);
  const [streamContent, setStreamContent] = useState("");
  const [streamError, setStreamError] = useState("");
  const [pendingPatch, setPendingPatch] = useState<{ filePath: string; content: string; summary: string; diff?: DiffLine[] } | null>(
    null,
  );

  const streamBufferRef = useRef("");
  const streamFlushTimerRef = useRef<number | null>(null);
  const streamThinkingRef = useRef("");
  const streamThinkingStartedAtRef = useRef<number | null>(null);
  const currentStreamSessionIdRef = useRef("");
  const didBootstrapRef = useRef(false);

  const activeProfile = useMemo(
    () => snapshot?.profiles.find((profile) => profile.id === activeProfileId) ?? null,
    [activeProfileId, snapshot?.profiles],
  );

  const flushStreamBuffer = useEffectEvent(() => {
    const delta = streamBufferRef.current;
    if (!delta) {
      return;
    }
    streamBufferRef.current = "";
    setStreamContent((current) => current + delta);
  });

  const scheduleStreamFlush = useEffectEvent(() => {
    if (streamFlushTimerRef.current !== null) {
      return;
    }

    const tick = () => {
      const queued = streamBufferRef.current;
      if (!queued) {
        streamFlushTimerRef.current = null;
        return;
      }

      const batchSize = queued.length > 96
        ? 8
        : queued.length > 48
          ? 4
          : queued.length > 12
            ? 2
            : 1;
      const delta = queued.slice(0, batchSize);
      streamBufferRef.current = queued.slice(batchSize);
      setStreamContent((current) => current + delta);
      streamFlushTimerRef.current = window.setTimeout(tick, 22);
    };

    streamFlushTimerRef.current = window.setTimeout(tick, 22);
  });

  const queueStreamDelta = useEffectEvent((delta: string) => {
    if (!delta) {
      return;
    }
    streamBufferRef.current += delta;
    scheduleStreamFlush();
  });

  const clearStreamBuffer = useEffectEvent(() => {
    if (streamFlushTimerRef.current !== null) {
      window.clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    streamBufferRef.current = "";
  });

  const appendThinkingDelta = useEffectEvent((delta: string) => {
    if (!delta) {
      return;
    }
    if (streamThinkingStartedAtRef.current === null) {
      streamThinkingStartedAtRef.current = Date.now();
      setStreamThinkingDurationMs(0);
    }
    streamThinkingRef.current += delta;
    setStreamThinkingText(streamThinkingRef.current);
    setStreamThinkingHistoryText(streamThinkingRef.current);
    setStreamThinkingDurationMs(Date.now() - streamThinkingStartedAtRef.current);
  });

  const clearThinkingText = useEffectEvent(() => {
    streamThinkingRef.current = "";
    streamThinkingStartedAtRef.current = null;
    setStreamThinkingText("");
  });

  const commitThinkingText = useEffectEvent(() => {
    if (streamThinkingRef.current && streamThinkingStartedAtRef.current !== null) {
      setStreamThinkingHistoryText(streamThinkingRef.current);
      setStreamThinkingDurationMs(Date.now() - streamThinkingStartedAtRef.current);
    }
    clearThinkingText();
  });

  const resetStreamState = useEffectEvent(() => {
    clearStreamBuffer();
    clearThinkingText();
    setStreamThinkingHistoryText("");
    setStreamThinkingDurationMs(0);
    setStreamContent("");
    setStreamError("");
  });

  const appendStreamMarker = useEffectEvent((marker: string) => {
    if (!marker) {
      return;
    }
    setStreamContent((current) => {
      const spacer = current && !current.endsWith("\n") ? "\n" : "";
      return `${current}${spacer}${marker}`;
    });
  });

  const appendAssistantErrorMessage = useEffectEvent((message: string) => {
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        profileId: activeProfileId,
        content: `Error: ${message}`,
        sessionId: activeSessionId || undefined,
        timestamp: new Date().toISOString(),
      },
    ]);
  });

  const appendInterruptedStreamMessage = useEffectEvent(() => {
    const content = buildAssistantSnapshotContent({
      thinkingText: mergeThinkingSegments(streamThinkingHistoryText, streamThinkingRef.current),
      content: `${streamContent}${streamBufferRef.current}`,
    });

    if (!content) {
      return;
    }

    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        profileId: activeProfileId,
        content,
        sessionId: currentStreamSessionIdRef.current || activeSessionId || undefined,
        timestamp: new Date().toISOString(),
      },
    ]);
  });

  const bootstrapSessions = useEffectEvent(async () => {
    const [nextSessions, nextUsage] = await Promise.all([
      desktop.listAgentSessions(),
      desktop.getUsageStats(),
    ]);
    const initialSessionId = nextSessions[0]?.id ?? "";
    const nextMessages = initialSessionId ? await desktop.getAgentMessages(initialSessionId) : [];
    setAgentSessions(nextSessions);
    setActiveSessionId(initialSessionId);
    setMessages(nextMessages);
    setUsageRecords(nextUsage);
  });

  const resetForSnapshot = useEffectEvent(() => {
    currentStreamSessionIdRef.current = "";
    didBootstrapRef.current = false;
    setMessages([]);
    setAgentSessions([]);
    setActiveSessionId("");
    setPendingPatch(null);
    resetStreamState();
  });

  useEffect(() => {
    if (!snapshot || didBootstrapRef.current) {
      return;
    }

    didBootstrapRef.current = true;
    void bootstrapSessions().catch((error) => {
      console.warn("failed to bootstrap agent sessions", error);
      // Retry once after a short delay in case backend wasn't ready
      didBootstrapRef.current = false;
      setTimeout(() => {
        if (!didBootstrapRef.current) {
          didBootstrapRef.current = true;
          void bootstrapSessions().catch(() => {});
        }
      }, 1500);
    });
  }, [bootstrapSessions, snapshot]);

  useEffect(() => {
    if (!snapshot?.profiles.length) {
      return;
    }

    if (snapshot.profiles.some((profile) => profile.id === activeProfileId)) {
      return;
    }

    const defaultProfile = snapshot.profiles.some((profile) => profile.id === "chat")
      ? "chat"
      : snapshot.profiles[0].id;
    setActiveProfileId(defaultProfile as AgentProfileId);
  }, [activeProfileId, snapshot?.profiles]);

  useEffect(() => {
    return () => {
      if (streamFlushTimerRef.current !== null) {
        window.clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
    };
  }, []);

  const handleNewSession = useEffectEvent(() => {
    if (isStreaming) {
      return;
    }
    setActiveSessionId("");
    setMessages([]);
    setPendingPatch(null);
    resetStreamState();
  });

  const handleSelectSession = useEffectEvent(async (sessionId: string) => {
    if (isStreaming || sessionId === activeSessionId) {
      return;
    }
    setActiveSessionId(sessionId);
    setPendingPatch(null);
    resetStreamState();
    setMessages(sessionId ? await desktop.getAgentMessages(sessionId) : []);
  });

  const handleRunAgent = useEffectEvent(async () => {
    if (!activeFile || isStreaming) {
      return;
    }

    setIsStreaming(true);
    resetStreamState();
    setPendingPatch(null);

    let unlistenFn: (() => void | Promise<void>) | undefined;
    const stopStream = () => {
      const current = unlistenFn;
      unlistenFn = undefined;
      safelyDisposeListener(current);
    };

    unlistenFn = await desktop.onAgentStream((chunk) => {
      switch (chunk.type) {
        case "text_delta":
          clearThinkingText();
          queueStreamDelta(chunk.content);
          break;
        case "thinking_delta":
          appendThinkingDelta(chunk.content);
          break;
        case "thinking_clear":
          clearThinkingText();
          break;
        case "thinking_commit":
          commitThinkingText();
          break;
        case "tool_call_start":
          flushStreamBuffer();
          appendStreamMarker(`[Tool: ${chunk.toolId}]`);
          break;
        case "tool_call_result":
          flushStreamBuffer();
          appendStreamMarker(
            `${chunk.status && chunk.status !== "completed" ? `[Status: ${chunk.status}]\n` : ""}[Result]\n${chunk.output}\n[/Result]`,
          );
          break;
        case "patch":
          setPendingPatch({
            filePath: chunk.filePath,
            content: chunk.newContent,
            summary: `Patch from agent for ${chunk.filePath}`,
            diff: chunk.diff,
          });
          break;
        case "error":
          appendInterruptedStreamMessage();
          clearThinkingText();
          clearStreamBuffer();
          setStreamError(chunk.message);
          appendAssistantErrorMessage(chunk.message);
          flushStreamBuffer();
          setIsStreaming(false);
          stopStream();
          break;
        case "done":
          flushStreamBuffer();
          stopStream();
          void Promise.all([desktop.listAgentSessions(), desktop.getUsageStats()]).then(([nextSessions, nextUsage]) => {
            setAgentSessions(nextSessions);
            setUsageRecords(nextUsage);
            const resolvedId = currentStreamSessionIdRef.current || nextSessions[0]?.id || "";
            if (resolvedId) {
              void desktop.getAgentMessages(resolvedId).then((nextMessages) => {
                setMessages(nextMessages);
                setActiveSessionId(resolvedId);
                setIsStreaming(false);
              });
            } else {
              setIsStreaming(false);
            }
          });
          break;
      }
    });

    try {
      const result = await desktop.runAgent(
        activeProfileId,
        activeFile.path,
        selectedText,
        undefined,
        activeSessionId || undefined,
      );
      const nextSessionId = result.sessionId ?? activeSessionId;
      if (nextSessionId) {
        currentStreamSessionIdRef.current = nextSessionId;
      }
      if (nextSessionId && nextSessionId !== activeSessionId) {
        setActiveSessionId(nextSessionId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("runAgent failed", error);
      appendInterruptedStreamMessage();
      clearThinkingText();
      clearStreamBuffer();
      setStreamError(message);
      appendAssistantErrorMessage(message);
      stopStream();
      setIsStreaming(false);
    }
  });

  const handleApplyPatch = useEffectEvent(async () => {
    if (!pendingPatch) {
      return;
    }
    await desktop.applyAgentPatch(pendingPatch.filePath, pendingPatch.content);
    replaceFileContent(pendingPatch.filePath, pendingPatch.content);
    setPendingPatch(null);
  });

  const handleDismissPatch = useEffectEvent(() => {
    setPendingPatch(null);
  });

  const handleCancelAgent = useEffectEvent(async () => {
    if (!isStreaming) {
      return;
    }
    try {
      await desktop.cancelAgent();
    } catch (error) {
      console.warn("failed to cancel agent", error);
    }
    flushStreamBuffer();
    clearThinkingText();
    setIsStreaming(false);
  });

  const handleSendMessage = useEffectEvent(async (text: string) => {
    if (isStreaming) {
      return;
    }

    setIsStreaming(true);
    resetStreamState();
    setPendingPatch(null);

    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: "user",
        profileId: activeProfileId,
        content: text,
        timestamp: new Date().toISOString(),
      },
    ]);

    let unlistenFn: (() => void | Promise<void>) | undefined;
    const stopStream = () => {
      const current = unlistenFn;
      unlistenFn = undefined;
      safelyDisposeListener(current);
    };

    unlistenFn = await desktop.onAgentStream((chunk) => {
      switch (chunk.type) {
        case "text_delta":
          clearThinkingText();
          queueStreamDelta(chunk.content);
          break;
        case "thinking_delta":
          appendThinkingDelta(chunk.content);
          break;
        case "thinking_clear":
          clearThinkingText();
          break;
        case "thinking_commit":
          commitThinkingText();
          break;
        case "tool_call_start":
          flushStreamBuffer();
          appendStreamMarker(`[Tool: ${chunk.toolId}]`);
          break;
        case "tool_call_result":
          flushStreamBuffer();
          appendStreamMarker(
            `${chunk.status && chunk.status !== "completed" ? `[Status: ${chunk.status}]\n` : ""}[Result]\n${chunk.output}\n[/Result]`,
          );
          break;
        case "patch":
          setPendingPatch({
            filePath: chunk.filePath,
            content: chunk.newContent,
            summary: `Patch from agent for ${chunk.filePath}`,
            diff: chunk.diff,
          });
          break;
        case "error":
          appendInterruptedStreamMessage();
          clearThinkingText();
          clearStreamBuffer();
          setStreamError(chunk.message);
          appendAssistantErrorMessage(chunk.message);
          flushStreamBuffer();
          setIsStreaming(false);
          stopStream();
          break;
        case "done":
          flushStreamBuffer();
          stopStream();
          void Promise.all([desktop.listAgentSessions(), desktop.getUsageStats()]).then(([nextSessions, nextUsage]) => {
            setAgentSessions(nextSessions);
            setUsageRecords(nextUsage);
            const resolvedId = currentStreamSessionIdRef.current || nextSessions[0]?.id || "";
            if (resolvedId) {
              void desktop.getAgentMessages(resolvedId).then((nextMessages) => {
                setMessages(nextMessages);
                setActiveSessionId(resolvedId);
                setIsStreaming(false);
              });
            } else {
              setIsStreaming(false);
            }
          });
          break;
      }
    });

    try {
      const result = await desktop.runAgent(
        activeProfileId,
        activeFile?.path ?? "",
        selectedText,
        text,
        activeSessionId || undefined,
      );
      const nextSessionId = result.sessionId ?? activeSessionId;
      if (nextSessionId) {
        currentStreamSessionIdRef.current = nextSessionId;
      }
      if (nextSessionId && nextSessionId !== activeSessionId) {
        setActiveSessionId(nextSessionId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("runAgent failed", error);
      appendInterruptedStreamMessage();
      clearThinkingText();
      clearStreamBuffer();
      setStreamError(message);
      appendAssistantErrorMessage(message);
      stopStream();
      setIsStreaming(false);
    }
  });

  return {
    messages,
    agentSessions,
    activeSessionId,
    usageRecords,
    activeProfileId,
    activeProfile,
    isStreaming,
    streamThinkingText,
    streamThinkingHistoryText,
    streamThinkingDurationMs,
    streamContent,
    streamError,
    pendingPatch,
    setActiveProfileId,
    handleRunAgent,
    handleSendMessage,
    handleNewSession,
    handleSelectSession,
    handleApplyPatch,
    handleDismissPatch,
    handleCancelAgent,
    resetForSnapshot,
  };
}
