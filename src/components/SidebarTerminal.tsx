import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";

import { desktop } from "../lib/desktop";
import type { TerminalEvent, TerminalSessionInfo } from "../types";

interface SidebarTerminalProps {
  workspaceRoot: string;
}

function safelyDisposeListener(listener?: (() => void | Promise<void>) | null) {
  if (!listener) return;
  try {
    const result = listener();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      void (result as Promise<unknown>).catch(() => {});
    }
  } catch {}
}

export function SidebarTerminal({ workspaceRoot }: SidebarTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef("");
  const isSessionStartingRef = useRef(false);
  const pendingEventsRef = useRef<Map<string, TerminalEvent[]>>(new Map());
  const workspaceRootRef = useRef(workspaceRoot);
  const [sessionInfo, setSessionInfo] = useState<TerminalSessionInfo | null>(null);
  const [statusText, setStatusText] = useState("");
  const [isListenerReady, setIsListenerReady] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const isDesktop = desktop.isTauriRuntime();

  const fitTerminal = () => {
    try {
      fitAddonRef.current?.fit();
    } catch {}
  };

  const resetTerminal = (message = "") => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.reset();
    if (message) terminal.writeln(message);
  };

  const closeSession = async () => {
    const sessionId = sessionIdRef.current;
    isSessionStartingRef.current = false;
    setIsStarting(false);
    if (!sessionId) return;

    sessionIdRef.current = "";
    pendingEventsRef.current.delete(sessionId);
    setSessionInfo(null);

    try {
      await desktop.closeTerminal(sessionId);
    } catch {}
  };

  const handleTerminalEvent = (event: TerminalEvent) => {
    if (!sessionIdRef.current) {
      const buffered = pendingEventsRef.current.get(event.sessionId) ?? [];
      pendingEventsRef.current.set(event.sessionId, [...buffered, event].slice(-24));
      return;
    }

    if (event.sessionId !== sessionIdRef.current) return;

    const terminal = terminalRef.current;
    if (!terminal) return;

    if (event.type === "output") {
      setIsStarting(false);
      terminal.write(event.data);
      return;
    }

    if (event.type === "exit") {
      setIsStarting(false);
      isSessionStartingRef.current = false;
      sessionIdRef.current = "";
      pendingEventsRef.current.delete(event.sessionId);
      setSessionInfo(null);
      const suffix = event.signal
        ? `signal ${event.signal}`
        : typeof event.exitCode === "number"
          ? `code ${event.exitCode}`
          : "shell closed";
      setStatusText(`终端已退出 · ${suffix}`);
      terminal.writeln(`\r\n[终端已退出 · ${suffix}]`);
      return;
    }

    setIsStarting(false);
    isSessionStartingRef.current = false;
    setStatusText(event.message);
    terminal.writeln(`\r\n[终端错误] ${event.message}`);
  };

  const startSession = async () => {
    if (
      !isDesktop ||
      !isListenerReady ||
      !workspaceRoot.trim() ||
      sessionIdRef.current ||
      isSessionStartingRef.current ||
      !terminalRef.current
    ) {
      return;
    }

    isSessionStartingRef.current = true;
    fitTerminal();
    setIsStarting(true);
    setStatusText("正在启动终端…");

    try {
      const terminal = terminalRef.current;
      const info = await desktop.startTerminal(
        workspaceRoot,
        Math.max(terminal.cols, 24),
        Math.max(terminal.rows, 8),
      );
      sessionIdRef.current = info.sessionId;
      setSessionInfo(info);
      setStatusText(`${info.shell} · ${info.cwd}`);
      setIsStarting(false);
      isSessionStartingRef.current = false;
      const pendingEvents = pendingEventsRef.current.get(info.sessionId) ?? [];
      pendingEventsRef.current.delete(info.sessionId);
      for (const event of pendingEvents) {
        handleTerminalEvent(event);
      }
      terminal.focus();
    } catch (error) {
      isSessionStartingRef.current = false;
      setIsStarting(false);
      const message = error instanceof Error ? error.message : String(error);
      setStatusText(message);
      resetTerminal(`[终端启动失败] ${message}`);
    }
  };

  // Initialize xterm instance
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      cursorWidth: 1,
      fontFamily:
        '"SF Mono", "Monaco", "Cascadia Code", "Menlo", "Consolas", monospace',
      fontSize: 12,
      lineHeight: 1.3,
      scrollback: 4000,
      theme: {
        background: "#0f1117",
        foreground: "#d4d4d8",
        cursor: "#a78bfa",
        cursorAccent: "#0f1117",
        selectionBackground: "rgba(167, 139, 250, 0.18)",
        black: "#1e1e2e",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#d4d4d8",
        brightBlack: "#6b7280",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde68a",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#f4f4f5",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const inputDisposable = terminal.onData((data) => {
      if (!sessionIdRef.current) return;
      void desktop.terminalWrite(sessionIdRef.current, data);
    });

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (!sessionIdRef.current) return;
      void desktop.resizeTerminal(sessionIdRef.current, cols, rows);
    });

    let rafId = 0;
    const scheduleFit = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        fitTerminal();
      });
    };

    const observer = new ResizeObserver(() => scheduleFit());
    observer.observe(host);
    queueMicrotask(() => scheduleFit());

    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      observer.disconnect();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      void closeSession();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Listen for terminal events
  useEffect(() => {
    let unlisten: (() => void | Promise<void>) | null = null;
    let cancelled = false;

    void desktop.onTerminalEvent(handleTerminalEvent).then((listener) => {
      if (cancelled) {
        safelyDisposeListener(listener);
        return;
      }
      unlisten = listener;
      setIsListenerReady(true);
    });

    return () => {
      cancelled = true;
      setIsListenerReady(false);
      safelyDisposeListener(unlisten);
    };
  }, []);

  // Auto-start session when listener is ready
  useEffect(() => {
    const timer = window.setTimeout(() => {
      fitTerminal();
      terminalRef.current?.focus();
      if (!sessionIdRef.current) {
        void startSession();
      }
    }, 60);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isListenerReady]);

  // Handle workspace root changes
  useEffect(() => {
    if (workspaceRootRef.current === workspaceRoot) return;

    workspaceRootRef.current = workspaceRoot;

    void (async () => {
      await closeSession();
      setSessionInfo(null);
      setIsStarting(false);
      setStatusText("");
      resetTerminal();
      await startSession();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceRoot]);

  const handleRestart = async () => {
    await closeSession();
    setIsStarting(false);
    setStatusText("");
    resetTerminal();
    await startSession();
  };

  const handleClear = () => {
    terminalRef.current?.clear();
  };

  const showOverlay = isDesktop && (!isListenerReady || isStarting);
  const overlayText = !isListenerReady
    ? "正在连接终端事件…"
    : statusText || sessionInfo?.cwd || workspaceRoot || "正在启动终端…";

  return (
    <div className="sidebar-terminal-shell">
      <div className="sidebar-terminal-bar">
        <span className="sidebar-terminal-status">
          {isDesktop
            ? statusText || sessionInfo?.cwd || workspaceRoot || "等待启动"
            : "内置终端仅支持桌面版"}
        </span>
        <div className="sidebar-terminal-actions">
          <button
            className="sidebar-terminal-btn"
            type="button"
            onClick={handleClear}
            disabled={!isDesktop}
            title="清屏"
          >
            清屏
          </button>
          <button
            className="sidebar-terminal-btn"
            type="button"
            onClick={() => void handleRestart()}
            disabled={!isDesktop}
            title="重开终端"
          >
            重开
          </button>
        </div>
      </div>

      <div className="sidebar-terminal-canvas-wrap">
        {isDesktop ? (
          <>
            <div ref={hostRef} className="sidebar-terminal-canvas" />
            {showOverlay && !sessionInfo ? (
              <div className="sidebar-terminal-overlay" aria-hidden="true">
                <div className="sidebar-terminal-overlay-label">{overlayText}</div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="sidebar-terminal-empty">内置终端仅支持桌面版应用。</div>
        )}
      </div>
    </div>
  );
}
