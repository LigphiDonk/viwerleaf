import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";

import { EditorPane } from "./components/EditorPane";
import { PdfPane } from "./components/PdfPane";
import { ProjectTree } from "./components/ProjectTree";
import { Sidebar } from "./components/Sidebar";
import { desktop } from "./lib/desktop";
import type {
  AgentMessage,
  AgentProfileId,
  DrawerTab,
  FigureBriefDraft,
  GeneratedAsset,
  ProjectFile,
  ProviderConfig,
  SkillManifest,
  TestResult,
  WorkspaceSnapshot,
} from "./types";

function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [bootstrapError, setBootstrapError] = useState("");
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeFilePath, setActiveFilePath] = useState("");
  const [highlightedPage, setHighlightedPage] = useState(1);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("explorer");
  const [cursorLine, setCursorLine] = useState(1);
  const [selectedText, setSelectedText] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<AgentProfileId>("outline");
  const [pendingPatch, setPendingPatch] = useState<{ filePath: string; content: string; summary: string } | null>(null);
  const [selectedBrief, setSelectedBrief] = useState<FigureBriefDraft | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<GeneratedAsset | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");

  const activeFile = useMemo<ProjectFile | null>(() => {
    if (!snapshot) {
      return null;
    }
    return snapshot.files.find((file) => file.path === activeFilePath) ?? snapshot.files[0] ?? null;
  }, [activeFilePath, snapshot]);

  const activeProfile = useMemo(
    () => snapshot?.profiles.find((profile) => profile.id === activeProfileId) ?? null,
    [activeProfileId, snapshot?.profiles],
  );

  const deferredActiveFile = useDeferredValue(activeFile);

  const refreshWorkspace = useEffectEvent(async (options?: {
    activeFilePath?: string;
    openTabs?: string[];
  }) => {
    const nextSnapshot = await desktop.openProject();
    const requestedActiveFile = options?.activeFilePath;
    const nextActiveFile =
      requestedActiveFile && nextSnapshot.files.some((file) => file.path === requestedActiveFile)
        ? requestedActiveFile
        : nextSnapshot.activeFile;
    const nextTabsSource = options?.openTabs ?? openTabs;
    const nextTabs = Array.from(
      new Set(
        [nextActiveFile, ...nextTabsSource].filter((path) =>
          nextSnapshot.files.some((file) => file.path === path),
        ),
      ),
    );

    setSnapshot(nextSnapshot);
    setOpenTabs(nextTabs);
    setActiveFilePath(nextActiveFile);
    setSelectedBrief((current) =>
      current ? nextSnapshot.figureBriefs.find((item) => item.id === current.id) ?? null : null,
    );
    setSelectedAsset((current) =>
      current ? nextSnapshot.assets.find((item) => item.id === current.id) ?? null : null,
    );

    return nextSnapshot;
  });

  useEffect(() => {
    void (async () => {
      try {
        const nextSnapshot = await refreshWorkspace();
        const nextMessages = await desktop.getAgentMessages();
        setMessages(nextMessages);

        if (nextSnapshot.projectConfig.autoCompile && nextSnapshot.compileResult.status === "idle") {
          const compileResult = await desktop.compileProject(nextSnapshot.activeFile);
          setSnapshot((current) =>
            current
              ? {
                  ...current,
                  compileResult,
                }
              : current,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setBootstrapError(message);
      }
    })();
  }, [refreshWorkspace]);

  const runForwardSync = useEffectEvent(async (filePath: string, line: number) => {
    if (!snapshot?.projectConfig.forwardSync || snapshot.compileResult.status !== "success") {
      return;
    }
    try {
      const location = await desktop.forwardSearch(filePath, line);
      setHighlightedPage(location.page);
    } catch (error) {
      console.warn("forward sync failed", error);
    }
  });

  useEffect(() => {
    if (!deferredActiveFile) {
      return;
    }
    const timer = window.setTimeout(() => {
      void runForwardSync(deferredActiveFile.path, cursorLine);
    }, 420);
    return () => window.clearTimeout(timer);
  }, [cursorLine, deferredActiveFile, runForwardSync, snapshot?.compileResult.status]);

  async function saveAndCompile(filePath: string, content: string) {
    await desktop.saveFile(filePath, content);
    if (!snapshot?.projectConfig.autoCompile) {
      return;
    }
    setSnapshot((current) =>
      current
        ? {
            ...current,
            compileResult: {
              ...current.compileResult,
              status: "running",
              logOutput: "Compile queued…",
              diagnostics: current.compileResult.diagnostics,
              logPath: current.compileResult.logPath,
              timestamp: new Date().toISOString(),
            },
          }
        : current,
    );

    const compileResult = await desktop.compileProject(filePath);
    setSnapshot((current) =>
      current
        ? {
            ...current,
            compileResult,
          }
        : current,
    );
  }

  function replaceFileContent(filePath: string, content: string) {
    setSnapshot((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        files: current.files.map((file) => (file.path === filePath ? { ...file, content } : file)),
      };
    });
  }

  function handleFileChange(content: string) {
    if (!activeFile) {
      return;
    }
    replaceFileContent(activeFile.path, content);
    void saveAndCompile(activeFile.path, content);
  }

  function handleOpenFile(path: string) {
    startTransition(() => {
      setActiveFilePath(path);
      setOpenTabs((current) => (current.includes(path) ? current : [...current, path]));
    });
  }

  async function handleRunAgent() {
    if (!activeFile || isStreaming) {
      return;
    }

    setDrawerTab("ai");
    setIsStreaming(true);
    setStreamText("");
    setPendingPatch(null);

    const unlisten = await desktop.onAgentStream((chunk) => {
      switch (chunk.type) {
        case "text_delta":
          setStreamText((current) => current + chunk.content);
          break;
        case "tool_call_start":
          setStreamText((current) => `${current}\n[Tool: ${chunk.toolId}]\n`);
          break;
        case "tool_call_result":
          setStreamText((current) => `${current}\n[Result: ${chunk.output.slice(0, 240)}]\n`);
          break;
        case "patch":
          setPendingPatch({
            filePath: chunk.filePath,
            content: chunk.newContent,
            summary: `Patch from agent for ${chunk.filePath}`,
          });
          break;
        case "error":
          setStreamText((current) => `${current}\n[Error: ${chunk.message}]\n`);
          setIsStreaming(false);
          break;
        case "done":
          setIsStreaming(false);
          break;
      }
    });

    try {
      const result = await desktop.runAgent(activeProfileId, activeFile.path, selectedText);
      const allMessages = await desktop.getAgentMessages();
      const nextMessages =
        allMessages.length > 0 ? allMessages : await desktop.getAgentMessages(result.sessionId);
      setMessages(nextMessages);
      if (result.suggestedPatch) {
        setPendingPatch(result.suggestedPatch);
      }
      setStreamText("");
    } finally {
      unlisten();
      setIsStreaming(false);
    }
  }

  async function handleApplyPatch() {
    if (!pendingPatch) {
      return;
    }
    await desktop.applyAgentPatch(pendingPatch.filePath, pendingPatch.content);
    replaceFileContent(pendingPatch.filePath, pendingPatch.content);
    setPendingPatch(null);
  }

  async function handleCreateBrief() {
    if (!activeFile) {
      return;
    }
    const brief = await desktop.createFigureBrief(activeFile.path, selectedText);
    setSnapshot((current) =>
      current
        ? {
            ...current,
            figureBriefs: [brief, ...current.figureBriefs.filter((item) => item.id !== brief.id)],
          }
        : current,
    );
    setSelectedBrief(brief);
    setDrawerTab("figures");
  }

  async function handleRunFigureSkill() {
    if (!selectedBrief) {
      return;
    }
    const updated = await desktop.runFigureSkill(selectedBrief.id);
    setSelectedBrief(updated);
    setSnapshot((current) =>
      current
        ? {
            ...current,
            figureBriefs: current.figureBriefs.map((item) => (item.id === updated.id ? updated : item)),
          }
        : current,
    );
  }

  async function handleGenerateFigure() {
    if (!selectedBrief) {
      return;
    }
    const asset = await desktop.runBananaGeneration(selectedBrief.id);
    await desktop.registerGeneratedAsset(asset);
    setSelectedAsset(asset);
    setSnapshot((current) =>
      current
        ? {
            ...current,
            assets: [asset, ...current.assets.filter((item) => item.id !== asset.id)],
          }
        : current,
    );
  }

  async function handleInsertFigure() {
    if (!activeFile || !selectedAsset) {
      return;
    }
    const result = await desktop.insertFigureSnippet(
      activeFile.path,
      selectedAsset.id,
      "Workflow overview of ViewerLeaf.",
      cursorLine + 1,
    );
    replaceFileContent(result.filePath, result.content);
  }

  async function handlePageJump(page: number) {
    if (snapshot?.compileResult.status !== "success") {
      return;
    }
    setHighlightedPage(page);
    try {
      const location = await desktop.reverseSearch(page);
      handleOpenFile(location.filePath);
      setCursorLine(location.line);
    } catch (error) {
      console.warn("reverse sync failed", error);
    }
  }

  async function handleAddProvider(provider: ProviderConfig) {
    await desktop.addProvider(provider);
    const providers = await desktop.listProviders();
    setSnapshot((current) => (current ? { ...current, providers } : current));
  }

  async function handleDeleteProvider(providerId: string) {
    await desktop.deleteProvider(providerId);
    const providers = await desktop.listProviders();
    setSnapshot((current) => (current ? { ...current, providers } : current));
  }

  function handleTestProvider(providerId: string): Promise<TestResult> {
    return desktop.testProvider(providerId);
  }

  async function handleToggleSkill(skill: SkillManifest) {
    const enabled = !(skill.isEnabled ?? skill.enabled ?? false);
    await desktop.enableSkill(skill.id, enabled);
    setSnapshot((current) =>
      current
        ? {
            ...current,
            skills: current.skills.map((item) =>
              item.id === skill.id ? { ...item, enabled, isEnabled: enabled } : item,
            ),
          }
        : current,
    );
  }

  async function handleCreateFile(parentDir: string, fileName: string) {
    const targetPath = parentDir ? `${parentDir}/${fileName}` : fileName;
    await desktop.createFile(targetPath, "");
    await refreshWorkspace({ activeFilePath: targetPath, openTabs: [...openTabs, targetPath] });
  }

  async function handleDeleteFile(path: string) {
    const nextOpenTabs = openTabs.filter((tab) => tab !== path);
    await desktop.deleteFile(path);
    await refreshWorkspace({ activeFilePath: activeFilePath === path ? undefined : activeFilePath, openTabs: nextOpenTabs });
  }

  async function handleRenameFile(oldPath: string, newPath: string) {
    const nextOpenTabs = openTabs.map((tab) => (tab === oldPath ? newPath : tab));
    const nextActive = activeFilePath === oldPath ? newPath : activeFilePath;
    await desktop.renameFile(oldPath, newPath);
    await refreshWorkspace({ activeFilePath: nextActive, openTabs: nextOpenTabs });
  }

  if (bootstrapError) {
    return <div className="app-shell loading-shell">ViewerLeaf failed to start: {bootstrapError}</div>;
  }

  if (!snapshot || !deferredActiveFile) {
    return <div className="app-shell loading-shell">正在启动 ViewerLeaf…</div>;
  }

  return (
    <div className="app-shell fade-in">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand-title">ViewerLeaf 工作台</span>
        </div>
        <div className="topbar-center">
          <span className="topbar-metric">排版引擎 <strong>{snapshot.projectConfig.engine}</strong></span>
          <span className="topbar-metric">
            编译状态
            <strong>
              {snapshot.compileResult.status === "success"
                ? "成功"
                : snapshot.compileResult.status === "failed"
                  ? "失败"
                  : snapshot.compileResult.status === "running"
                    ? "正在编译"
                    : "空闲"}
            </strong>
          </span>
        </div>
        <div className="topbar-right">
          <span className="topbar-metric">诊断结果 <strong>{snapshot.compileResult.diagnostics.length} 项</strong></span>
          <button className="btn-primary hover-spring" onClick={handleRunAgent} type="button" disabled={isStreaming}>
            {isStreaming ? "执行中..." : `执行 ${activeProfile?.label ?? "当前配置"}`}
          </button>
        </div>
      </header>

      <div className="workspace-container">
        <div className="activity-bar">
          <button
            className={`activity-icon hover-spring ${drawerTab === "explorer" ? "is-active" : ""}`}
            onClick={() => setDrawerTab("explorer")}
            title="项目资源 (Explorer)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
          </button>
          <button
            className={`activity-icon hover-spring ${drawerTab === "ai" ? "is-active" : ""}`}
            onClick={() => setDrawerTab("ai")}
            title="AI 智能体助手"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>
          </button>
          <button
            className={`activity-icon hover-spring ${drawerTab === "figures" ? "is-active" : ""}`}
            onClick={() => setDrawerTab("figures")}
            title="图表工作区 (Figures)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
          </button>
          <button
            className={`activity-icon hover-spring ${drawerTab === "skills" ? "is-active" : ""}`}
            onClick={() => setDrawerTab("skills")}
            title="应用与技能 (App Store)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
          </button>
          <button
            className={`activity-icon hover-spring ${drawerTab === "providers" ? "is-active" : ""}`}
            onClick={() => setDrawerTab("providers")}
            title="API 配置区 (Providers)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          </button>

          <div style={{ flex: 1 }}></div>

          <button
            className={`activity-icon hover-spring ${drawerTab === "logs" ? "is-active" : ""}`}
            onClick={() => setDrawerTab("logs")}
            title="编译日志"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
            {snapshot.compileResult.diagnostics.length > 0 && <span style={{ position: "absolute", top: 2, right: 2, width: 8, height: 8, borderRadius: "50%", background: "var(--danger)" }}></span>}
          </button>
        </div>

        <Sidebar
          tab={drawerTab}
          messages={messages}
          profiles={snapshot.profiles}
          activeProfileId={activeProfileId}
          onSelectProfile={(profileId: string) => setActiveProfileId(profileId as AgentProfileId)}
          onRunAgent={handleRunAgent}
          pendingPatchSummary={pendingPatch?.summary}
          onApplyPatch={handleApplyPatch}
          compileLog={snapshot.compileResult.logOutput}
          diagnosticsCount={snapshot.compileResult.diagnostics.length}
          briefs={snapshot.figureBriefs}
          assets={snapshot.assets}
          selectedBriefId={selectedBrief?.id}
          selectedAssetId={selectedAsset?.id}
          onCreateBrief={handleCreateBrief}
          onRunFigureSkill={handleRunFigureSkill}
          onGenerateFigure={handleGenerateFigure}
          onInsertFigure={handleInsertFigure}
          onSelectBrief={(briefId: string) => setSelectedBrief(snapshot.figureBriefs.find((brief) => brief.id === briefId) ?? null)}
          onSelectAsset={(assetId: string) => setSelectedAsset(snapshot.assets.find((asset) => asset.id === assetId) ?? null)}
          providers={snapshot.providers}
          onAddProvider={handleAddProvider}
          onDeleteProvider={handleDeleteProvider}
          onTestProvider={handleTestProvider}
          streamText={streamText}
          isStreaming={isStreaming}
          explorerNode={
            <ProjectTree
              nodes={snapshot.tree}
              activeFile={activeFilePath}
              onOpenFile={handleOpenFile}
              onCreateFile={handleCreateFile}
              onDeleteFile={handleDeleteFile}
              onRenameFile={handleRenameFile}
            />
          }
        />

        {drawerTab === "skills" ? (
          <div className="full-page-view" style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--bg-app)", overflow: "auto", padding: "32px" }}>
            <div style={{ maxWidth: "1000px", margin: "0 auto", width: "100%" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderBottom: "1px solid var(--border-light)", paddingBottom: "16px", marginBottom: "32px" }}>
                <div>
                  <h1 style={{ fontSize: "28px", fontWeight: 600, color: "var(--text-primary)", margin: "0 0 8px 0" }}>所有应用与技能</h1>
                  <p style={{ color: "var(--text-secondary)", margin: 0, fontSize: "14px" }}>管理安装在工作区中的自定义处理脚本和智能体工作流，像使用手机 App 一样简单。</p>
                </div>
                <button className="btn-primary hover-spring" style={{ padding: "10px 20px", fontSize: "14px" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: "8px" }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                  导入自定义技能
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "24px" }}>
                {snapshot.skills.map((skill) => {
                  const enabled = skill.isEnabled ?? skill.enabled ?? false;
                  const getAppIcon = (name: string) => name.substring(0, 2).toUpperCase();

                  return (
                    <div
                      key={skill.id}
                      className={`hover-spring ${enabled ? "enabled" : ""}`}
                      style={{
                        background: "var(--bg-surface)",
                        border: "1px solid var(--border-light)",
                        borderRadius: "var(--radius-xl)",
                        padding: "24px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "16px",
                        cursor: "pointer",
                        boxShadow: "var(--shadow-sm)",
                      }}
                    >
                      <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
                        <div
                          style={{
                            width: "64px",
                            height: "64px",
                            borderRadius: "18px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "28px",
                            fontWeight: 600,
                            background: enabled ? "linear-gradient(135deg, #e0f2fe, #bae6fd)" : "linear-gradient(135deg, #f0f0f0, #e0e0e0)",
                            color: enabled ? "#0284c7" : "var(--text-tertiary)",
                            boxShadow: "inset 0 2px 4px rgba(255,255,255,0.5), 0 4px 12px rgba(0,0,0,0.05)",
                          }}
                        >
                          {getAppIcon(skill.name)}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <h3 style={{ margin: "0 0 4px 0", fontSize: "16px", fontWeight: 600, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{skill.name}</h3>
                          <div style={{ fontSize: "12px", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: "6px" }}>
                            <span
                              style={{
                                display: "inline-block",
                                width: "8px",
                                height: "8px",
                                borderRadius: "50%",
                                background: enabled ? "var(--accent-primary)" : "var(--text-tertiary)",
                              }}
                            ></span>
                            {enabled ? "已启用" : "未启用"}
                          </div>
                        </div>
                      </div>
                      <div style={{ fontSize: "13px", color: "var(--text-muted)", lineHeight: 1.5, flex: 1 }}>
                        这个技能可以通过 {skill.source} 源获取，并在系统流水线中使用。
                      </div>
                      <div style={{ display: "flex", gap: "8px", marginTop: "auto" }}>
                        <button
                          className={enabled ? "btn-secondary hover-spring" : "btn-primary hover-spring"}
                          style={{ flex: 1 }}
                          type="button"
                          onClick={() => void handleToggleSkill(skill)}
                        >
                          {enabled ? "停用" : "启用"}
                        </button>
                        <button className="btn-secondary hover-spring" style={{ flex: 1 }} type="button">
                          配置
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {snapshot.skills.length === 0 && (
                <div style={{ textAlign: "center", padding: "64px", background: "var(--bg-sidebar)", borderRadius: "var(--radius-xl)", border: "1px dashed var(--border-light)" }}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-tertiary)", marginBottom: "16px" }}><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
                  <h3 style={{ margin: "0 0 8px 0", color: "var(--text-primary)" }}>暂无技能应用</h3>
                  <p style={{ color: "var(--text-secondary)", margin: "0 0 24px 0", fontSize: "14px" }}>您还没有导入任何技能应用。请导入技能工作流文件来扩展排版工作台的功能。</p>
                  <button className="btn-primary hover-spring">前往市场下载</button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="editor-area">
              <div className="editor-tabs">
                {openTabs.map((tab) => (
                  <button
                    key={tab}
                    className={`editor-tab ${tab === activeFilePath ? "is-active" : ""}`}
                    onClick={() => handleOpenFile(tab)}
                    type="button"
                  >
                    <span style={{ marginRight: 8 }}>{tab.split("/").at(-1)}</span>
                    <span
                      className="icon-btn"
                      style={{ width: 16, height: 16 }}
                      onClick={(event) => {
                        event.stopPropagation();
                        setOpenTabs((current) => current.filter((item) => item !== tab));
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </span>
                  </button>
                ))}
              </div>
              <div className="editor-content">
                <EditorPane
                  file={deferredActiveFile}
                  openTabs={openTabs}
                  onChange={handleFileChange}
                  onCursorChange={(line, selection) => {
                    setCursorLine(line);
                    setSelectedText(selection);
                  }}
                  onSelectTab={handleOpenFile}
                  onSave={(content) => {
                    if (!deferredActiveFile) {
                      return;
                    }
                    replaceFileContent(deferredActiveFile.path, content);
                    void saveAndCompile(deferredActiveFile.path, content);
                  }}
                  onRunAgent={() => {
                    void handleRunAgent();
                  }}
                />
              </div>
            </div>

            <div className="preview-area">
              <PdfPane compileResult={snapshot.compileResult} highlightedPage={highlightedPage} onPageJump={handlePageJump} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
