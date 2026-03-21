import clsx from "clsx";
import { useEffect, useState } from "react";

import { ChatPanel } from "./ChatPanel";
import { CommentPanel } from "./CommentPanel";
import { SkillArsenal } from "./SkillArsenal";
import type { CollabAuthSession } from "../lib/collaboration/auth";
import type { CollabConfig } from "../lib/collaboration/collab-config";
import type {
  AppLocale,
  AgentMessage,
  AgentProfile,
  AgentSessionSummary,
  CollabStatus,
  CompileEnvironmentStatus,
  DrawerTab,
  FigureBriefDraft,
  GeneratedAsset,
  LatexEngine,
  ProjectConfig,
  ProviderConfig,
  ReviewComment,
  SkillManifest,
  UsageRecord,
  WorkspaceCollabMetadata,
} from "../types";

interface SidebarProps {
  locale: AppLocale;
  tab: DrawerTab;
  messages: AgentMessage[];
  sessions: AgentSessionSummary[];
  activeSessionId: string;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onRunAgent: () => void;
  pendingPatchSummary?: string;
  onApplyPatch: () => void;
  compileStatus: string;
  compileLog: string;
  projectConfig: ProjectConfig;
  compileEnvironment: CompileEnvironmentStatus | null;
  isCheckingCompileEnvironment: boolean;
  onRefreshCompileEnvironment: () => void;
  onSetCompileEngine: (engine: LatexEngine) => void;
  onSetAutoCompile: (enabled: boolean) => void;
  diagnosticsCount: number;
  briefs: FigureBriefDraft[];
  assets: GeneratedAsset[];
  selectedBriefId?: string;
  selectedAssetId?: string;
  onCreateBrief: () => void;
  onRunFigureSkill: () => void;
  onGenerateFigure: () => void;
  onInsertFigure: () => void;
  onSelectBrief: (briefId: string) => void;
  onSelectAsset: (assetId: string) => void;
  providers: ProviderConfig[];
  activeProviderId?: string;
  activeChatProfile: AgentProfile | null;
  skills: SkillManifest[];
  usageRecords: UsageRecord[];
  onSelectChatVendor: (vendor: "claude-code" | "codex") => Promise<void>;
  onSelectChatModel: (model: string) => Promise<void>;
  onToggleSkill: (skill: SkillManifest) => Promise<void>;
  onSkillsChanged?: () => void;
  streamThinkingText?: string;
  streamThinkingHistoryText?: string;
  streamThinkingDurationMs?: number;
  streamContent?: string;
  streamError?: string;
  isStreaming?: boolean;
  onSendMessage: (text: string) => void;
  onDismissPatch: () => void;
  onCancelAgent?: () => void;
  pendingPatchDiff?: import("../types").DiffLine[];
  projectTree?: import("../types").ProjectNode[];
  // Collab props
  collabAuthSession: CollabAuthSession | null;
  collabConfig: CollabConfig | null;
  cloudCollab: WorkspaceCollabMetadata | null;
  collabBusyAction:
    | "save-config"
    | "create-project"
    | "link-project"
    | "unlink-project"
    | "sync-project"
    | "pull-project"
    | null;
  collabNotice: { tone: "success" | "error"; text: string } | null;
  collabStatus: CollabStatus;
  activeFilePath: string;
  onOpenLoginModal: () => void;
  onLogout: () => void;
  onSaveCollabConfig: (config: CollabConfig) => void;
  onCreateCloudProject: () => void;
  onLinkCloudProject: () => void;
  onUnlinkCloudProject: () => void;
  onCopyShareLink: () => void;
  onWorkerLogin: () => Promise<void> | void;
  onWorkerDeploy: () => Promise<void> | void;
  onWorkerLoginAndDeploy: () => Promise<void> | void;
  // Comment props
  comments: ReviewComment[];
  onResolveComment: (id: string) => void;
  onReplyComment: (id: string, text: string) => void;
  onDeleteComment: (id: string) => void;
  onJumpToCommentLine: (line: number) => void;
}


function formatUsageTimestamp(createdAt: string) {
  if (!createdAt.trim()) {
    return "";
  }

  const normalized = createdAt.includes("T") ? createdAt : createdAt.replace(" ", "T");
  const withTimezone = normalized.endsWith("Z") ? normalized : `${normalized}Z`;
  const date = new Date(withTimezone);
  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  return sameDay
    ? date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    : date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
}

const LATEX_ENGINES: LatexEngine[] = ["xelatex", "pdflatex", "lualatex"];
const LATEX_ENGINE_LABELS: Record<LatexEngine, string> = {
  xelatex: "XeLaTeX",
  pdflatex: "pdfLaTeX",
  lualatex: "LuaLaTeX",
};

export function Sidebar({
  locale,
  tab,
  messages,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onRunAgent,
  pendingPatchSummary,
  onApplyPatch,
  compileStatus,
  compileLog,
  projectConfig,
  compileEnvironment,
  isCheckingCompileEnvironment,
  onRefreshCompileEnvironment,
  onSetCompileEngine,
  onSetAutoCompile,
  diagnosticsCount,
  briefs,
  assets,
  selectedBriefId,
  selectedAssetId,
  onCreateBrief,
  onRunFigureSkill,
  onGenerateFigure,
  onInsertFigure,
  onSelectBrief,
  onSelectAsset,
  providers,
  activeProviderId,
  activeChatProfile,
  skills,
  usageRecords,
  onSelectChatVendor,
  onSelectChatModel,
  onToggleSkill,
  onSkillsChanged,
  streamThinkingText,
  streamThinkingHistoryText,
  streamThinkingDurationMs,
  streamContent,
  streamError,
  isStreaming,
  onSendMessage,
  onDismissPatch,
  onCancelAgent,
  pendingPatchDiff,
  projectTree,
  collabAuthSession,
  collabConfig: collabConfigProp,
  cloudCollab,
  collabBusyAction,
  collabNotice,
  collabStatus,
  activeFilePath,
  onOpenLoginModal,
  onLogout,
  onSaveCollabConfig,
  onCreateCloudProject,
  onLinkCloudProject,
  onUnlinkCloudProject,
  onCopyShareLink,
  onWorkerLogin,
  onWorkerDeploy,
  onWorkerLoginAndDeploy,
  comments,
  onResolveComment,
  onReplyComment,
  onDeleteComment,
  onJumpToCommentLine,
}: SidebarProps) {
  const isZh = locale === "zh-CN";
  const [collabConfigForm, setCollabConfigForm] = useState({
    httpBaseUrl: collabConfigProp?.httpBaseUrl ?? "",
    wsBaseUrl: collabConfigProp?.wsBaseUrl ?? "",
    teamLabel: collabConfigProp?.teamLabel ?? "",
  });
  const availableEngineSet = new Set<LatexEngine>(compileEnvironment?.availableEngines ?? []);
  const selectedEngineAvailable = availableEngineSet.has(projectConfig.engine as LatexEngine);
  const isWindows = typeof window !== "undefined" && /win/i.test(window.navigator.userAgent) && !/mac/i.test(window.navigator.userAgent);
  const providerLabelById = new Map(
    providers.map((provider) => [provider.id, provider.name?.trim() || provider.vendor || provider.id]),
  );

  const totalInputTokens = usageRecords.reduce((sum, item) => sum + item.inputTokens, 0);
  const totalOutputTokens = usageRecords.reduce((sum, item) => sum + item.outputTokens, 0);

  useEffect(() => {
    setCollabConfigForm({
      httpBaseUrl: collabConfigProp?.httpBaseUrl ?? "",
      wsBaseUrl: collabConfigProp?.wsBaseUrl ?? "",
      teamLabel: collabConfigProp?.teamLabel ?? "",
    });
  }, [collabConfigProp]);



  return (
    <div className="primary-sidebar">
      {tab === "latex" && (
        <>
          <div className="sidebar-header">{isZh ? "LaTeX 编译" : "LaTeX Setup"}</div>
          <div className="sidebar-content sidebar-stack">
            <div className="card latex-status-card">
              <div className="latex-status-header">
                <div>
                  <div className="card-header" style={{ marginBottom: 4 }}>本地编译环境</div>
                  <div className="text-subtle text-xs">
                    打开这个面板时会重新检查 `latexmk`、`synctex` 和可用引擎。
                  </div>
                </div>
                <button className="btn-secondary" type="button" onClick={onRefreshCompileEnvironment}>
                  {isCheckingCompileEnvironment ? "检查中..." : "重新检测"}
                </button>
              </div>

              <div className="latex-tool-pills">
                <span className={clsx("latex-tool-pill", compileEnvironment?.latexmkAvailable ? "ready" : "missing")}>
                  latexmk
                </span>
                <span className={clsx("latex-tool-pill", compileEnvironment?.synctexAvailable ? "ready" : "missing")}>
                  synctex
                </span>
                {LATEX_ENGINES.map((engine) => (
                  <span
                    key={engine}
                    className={clsx("latex-tool-pill", availableEngineSet.has(engine) ? "ready" : "missing")}
                  >
                    {LATEX_ENGINE_LABELS[engine]}
                  </span>
                ))}
              </div>
            </div>

            {(isCheckingCompileEnvironment && !compileEnvironment) || !compileEnvironment ? (
              <div className="card">
                <div className="sidebar-empty-state">正在检查本地 TeX 工具链…</div>
              </div>
            ) : !compileEnvironment.ready ? (
              <div className="card latex-setup-card">
                <div className="card-header">还没检测到完整的本地编译资源</div>
                <div className="text-subtle text-xs">
                  缺少: {compileEnvironment.missingTools.join(" / ") || "latexmk / synctex / engine"}
                </div>
                <ol className="latex-guide-list">
                  {isWindows ? (
                    <>
                      <li>安装 MiKTeX（推荐）或 TeX Live for Windows。MiKTeX 支持按需安装宏包，更轻量。</li>
                      <li>安装完成后，打开命令提示符确认 <code>latexmk -v</code>、<code>xelatex --version</code> 能正常执行。</li>
                      <li>如果刚安装完，重启 ViewerLeaf 后点"重新检测"。</li>
                    </>
                  ) : (
                    <>
                      <li>先安装一个本地 TeX 发行版。macOS 上优先用 MacTeX，轻量方案可选 TinyTeX。</li>
                      <li>安装完成后，在终端确认 `latexmk -v`、`xelatex --version`、`synctex` 至少能执行。</li>
                      <li>如果是刚安装完，再重启一次 ViewerLeaf，然后回到这里点"重新检测"。</li>
                    </>
                  )}
                </ol>
                {isWindows ? (
                  <pre className="latex-code-block">{`# 方案一：MiKTeX（推荐，支持按需安装宏包）
# 从 https://miktex.org/download 下载安装包

# 方案二：TeX Live for Windows
# 从 https://tug.org/texlive/windows.html 下载 install-tl-windows.exe

# 方案三：Scoop 包管理器（命令行）
scoop install latex`}</pre>
                ) : (
                  <pre className="latex-code-block">{`# 完整方案（推荐）
brew install --cask mactex-no-gui

# 轻量方案
curl -sL "https://yihui.org/tinytex/install-bin-unix.sh" | sh`}</pre>
                )}
              </div>
            ) : (
              <>
                <div className="card">
                  <div className="card-header">项目编译选项</div>
                  <label className="latex-toggle-row">
                    <div>
                      <div className="latex-row-title">自动编译</div>
                      <div className="text-subtle text-xs">保存当前文件后自动触发本地编译。</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={projectConfig.autoCompile}
                      onChange={(event) => onSetAutoCompile(event.target.checked)}
                    />
                  </label>

                  <div className="sidebar-section-title" style={{ marginTop: 16 }}>编译引擎</div>
                  <div className="latex-engine-grid">
                    {LATEX_ENGINES.map((engine) => {
                      const available = availableEngineSet.has(engine);
                      const active = projectConfig.engine === engine;
                      return (
                        <button
                          key={engine}
                          type="button"
                          className={clsx(
                            "latex-engine-option",
                            active && "is-active",
                            !available && "is-unavailable",
                          )}
                          disabled={!available}
                          onClick={() => onSetCompileEngine(engine)}
                        >
                          <span>{LATEX_ENGINE_LABELS[engine]}</span>
                          <span className="text-subtle text-xs">{available ? "已检测到" : "未检测到"}</span>
                        </button>
                      );
                    })}
                  </div>

                  {!selectedEngineAvailable && (
                    <div className="latex-warning-note">
                      当前项目配置为 {LATEX_ENGINE_LABELS[projectConfig.engine as LatexEngine] ?? projectConfig.engine}，
                      但本机没有检测到这个引擎。先切到可用引擎，再手动编译。
                    </div>
                  )}
                </div>

                <div className="card">
                  <div className="card-header">当前状态</div>
                  <div className="latex-inline-meta">
                    <span
                      className={clsx(
                        "status-badge",
                        compileStatus === "running" ? "running" : diagnosticsCount > 0 ? "failed" : "success",
                      )}
                    >
                      {compileStatus === "success"
                        ? "最近一次编译成功"
                        : compileStatus === "failed"
                          ? "最近一次编译失败"
                          : compileStatus === "running"
                            ? "正在编译"
                            : "等待编译"}
                    </span>
                    <span className="text-subtle text-xs">诊断 {diagnosticsCount} 项</span>
                  </div>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {tab === "ai" && (
        <div className="sidebar-content sidebar-content--chat">
          <ChatPanel
            messages={messages}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={onSelectSession}
            onNewSession={onNewSession}
            onRunAgent={onRunAgent}
            onSendMessage={onSendMessage}
            onCancelAgent={onCancelAgent}
            pendingPatchSummary={pendingPatchSummary}
            pendingPatchDiff={pendingPatchDiff}
            onApplyPatch={onApplyPatch}
            onDismissPatch={onDismissPatch}
            streamThinkingText={streamThinkingText}
            streamThinkingHistoryText={streamThinkingHistoryText}
            streamThinkingDurationMs={streamThinkingDurationMs}
            streamContent={streamContent}
            streamError={streamError}
            isStreaming={isStreaming}
            providers={providers}
            activeProfile={activeChatProfile}
            activeProviderId={activeProviderId}
            onSelectProviderVendor={onSelectChatVendor}
            onSelectModel={onSelectChatModel}
            skills={skills}
            onToggleSkill={onToggleSkill}
            usageRecords={usageRecords}
            projectTree={projectTree}
          />
        </div>
      )}

      {tab === "figures" && (
        <>
          <div className="sidebar-header">{isZh ? "图表生成" : "Figures"}</div>
          <div className="sidebar-content sidebar-stack">
            <div className="card">
              <div className="card-header">操作面板</div>
              <div className="sidebar-grid-actions">
                <button className="btn-primary" onClick={onCreateBrief}>新建概要</button>
                <button className="btn-secondary" disabled={!selectedBriefId} onClick={onRunFigureSkill}>预处理</button>
                <button className="btn-secondary" disabled={!selectedBriefId} onClick={onGenerateFigure}>生成图像</button>
                <button className="btn-secondary" disabled={!selectedAssetId} onClick={onInsertFigure}>插入文档</button>
              </div>
            </div>

            <div>
              <div className="sidebar-section-title">图表概要</div>
              <div className="sidebar-stack-compact">
                {briefs.map((brief) => (
                  <button
                    key={brief.id}
                    className={clsx("card", "sidebar-compact-card", selectedBriefId === brief.id && "sidebar-card-active")}
                    type="button"
                    onClick={() => onSelectBrief(brief.id)}
                  >
                    <div style={{ fontWeight: 500, fontSize: "12px", color: "var(--text-primary)" }}>
                      {brief.sourceSectionRef || "未命名节点"}
                    </div>
                    <div className="text-subtle text-xs">状态: {brief.status}</div>
                  </button>
                ))}
                {briefs.length === 0 && <div className="sidebar-empty-state">暂无概要</div>}
              </div>
            </div>

            <div>
              <div className="sidebar-section-title">已生成资源</div>
              <div className="sidebar-stack-compact">
                {assets.map((asset) => (
                  <button
                    key={asset.id}
                    className={clsx("card", "sidebar-compact-card", selectedAssetId === asset.id && "sidebar-card-active")}
                    type="button"
                    onClick={() => onSelectAsset(asset.id)}
                  >
                    <img
                      alt={asset.filePath}
                      src={asset.previewUri}
                      style={{ width: "100%", borderRadius: "var(--radius-sm)", marginBottom: "8px" }}
                    />
                    <div className="text-xs" style={{ wordBreak: "break-all" }}>{asset.filePath}</div>
                  </button>
                ))}
                {assets.length === 0 && <div className="sidebar-empty-state">暂无资源</div>}
              </div>
            </div>
          </div>
        </>
      )}

      {tab === "skills" && (
        <>
          <div className="sidebar-header">{isZh ? "技能军火库" : "Skill Arsenal"}</div>
          <div className="sidebar-content sidebar-stack">
            <SkillArsenal
              skills={skills}
              onToggleSkill={onToggleSkill}
              onSkillsChanged={onSkillsChanged}
            />

          </div>
        </>
      )}

      {tab === "usage" && (
        <>
          <div className="sidebar-header">{isZh ? "用量统计" : "Usage"}</div>
          <div className="sidebar-content sidebar-stack">
            <div className="sidebar-metrics-grid usage-summary-grid">
              <div className="card sidebar-metric-card usage-summary-card">
                <div className="text-subtle text-xs">调用次数</div>
                <div className="sidebar-metric-value">{usageRecords.length}</div>
              </div>
              <div className="card sidebar-metric-card usage-summary-card">
                <div className="text-subtle text-xs">输入 Tokens</div>
                <div className="sidebar-metric-value">{totalInputTokens}</div>
              </div>
              <div className="card sidebar-metric-card usage-summary-card">
                <div className="text-subtle text-xs">输出 Tokens</div>
                <div className="sidebar-metric-value">{totalOutputTokens}</div>
              </div>
            </div>

            <div className="usage-record-list">
              {usageRecords.map((record) => (
                <div key={record.id} className="usage-record-row">
                  <div className="usage-record-top">
                    <div className="usage-record-model" title={record.model}>{record.model}</div>
                    <div className="usage-record-time">{formatUsageTimestamp(record.createdAt)}</div>
                  </div>
                  <div className="usage-record-bottom">
                    <div className="usage-record-provider" title={providerLabelById.get(record.providerId) ?? record.providerId}>
                      {providerLabelById.get(record.providerId) ?? record.providerId}
                    </div>
                    <div className="usage-record-tokens">
                      <span className="usage-record-token">In {record.inputTokens}</span>
                      <span className="usage-record-token">Out {record.outputTokens}</span>
                    </div>
                  </div>
                </div>
              ))}
              {usageRecords.length === 0 && <div className="sidebar-empty-state">暂无调用记录</div>}
            </div>
          </div>
        </>
      )}

      {tab === "logs" && (
        <>
          <div className="sidebar-header">{isZh ? "编译日志" : "Compile Logs"}</div>
          <div className="sidebar-content sidebar-stack">
            <div className="card">
              <div className="card-header">编译状态</div>
              <span className={clsx("status-badge", diagnosticsCount > 0 ? "failed" : "success")}>
                {diagnosticsCount ? `发现 ${diagnosticsCount} 个问题` : "暂无编译问题"}
              </span>
            </div>
            <pre className="log-surface" style={{ flex: 1, minHeight: 0 }}>
              {compileLog || "无日志输出"}
            </pre>
          </div>
        </>
      )}

      {tab === "collab" && (
        <>
          <div className="sidebar-header">{isZh ? "云协作" : "Cloud Collaboration"}</div>
          <div className="sidebar-content sidebar-stack">
            {/* Card 1: Identity */}
            <div className="card">
              <div className="card-header">身份</div>
              {collabAuthSession ? (
                <div className="collab-identity-row">
                  <span className="collab-color-dot" style={{ background: collabAuthSession.color }} />
                  <span style={{ fontWeight: 500 }}>{collabAuthSession.name}</span>
                  {collabAuthSession.email && (
                    <span className="text-subtle text-xs">{collabAuthSession.email}</span>
                  )}
                  <span style={{ flex: 1 }} />
                  <button className="link-btn" onClick={onOpenLoginModal}>编辑</button>
                  <button className="link-btn" onClick={onLogout}>退出</button>
                </div>
              ) : (
                <button className="btn-primary" style={{ width: "100%" }} onClick={onOpenLoginModal}>
                  登录 / 设置身份
                </button>
              )}
            </div>

            {/* Card 2: Server config */}
            <div className="card">
              <div className="card-header">服务器配置</div>
              <div className="collab-config-field">
                <label>HTTP URL</label>
                <input
                  className="sidebar-input"
                  value={collabConfigForm.httpBaseUrl}
                  onChange={(e) => setCollabConfigForm((s) => ({ ...s, httpBaseUrl: e.target.value }))}
                  placeholder="http://localhost:8787"
                />
              </div>
              <div className="collab-config-field">
                <label>WebSocket URL</label>
                <input
                  className="sidebar-input"
                  value={collabConfigForm.wsBaseUrl}
                  onChange={(e) => setCollabConfigForm((s) => ({ ...s, wsBaseUrl: e.target.value }))}
                  placeholder="ws://localhost:8787"
                />
              </div>
              <div className="collab-config-field">
                <label>团队名称（选填）</label>
                <input
                  className="sidebar-input"
                  value={collabConfigForm.teamLabel}
                  onChange={(e) => setCollabConfigForm((s) => ({ ...s, teamLabel: e.target.value }))}
                  placeholder="我的团队"
                />
              </div>
              <button
                className="btn-primary"
                style={{ width: "100%", marginTop: 8 }}
                onClick={() => {
                  if (!collabConfigForm.httpBaseUrl.trim() || !collabConfigForm.wsBaseUrl.trim()) return;
                  onSaveCollabConfig({
                    httpBaseUrl: collabConfigForm.httpBaseUrl.trim(),
                    wsBaseUrl: collabConfigForm.wsBaseUrl.trim(),
                    teamLabel: collabConfigForm.teamLabel.trim(),
                  });
                }}
                disabled={
                  !collabConfigForm.httpBaseUrl.trim() ||
                  !collabConfigForm.wsBaseUrl.trim() ||
                  collabBusyAction === "save-config"
                }
              >
                {collabBusyAction === "save-config" ? "保存中..." : "保存配置"}
              </button>
              {collabNotice && (
                <div
                  className={clsx("collab-notice", collabNotice.tone === "error" && "is-error")}
                  role="status"
                >
                  {collabNotice.text}
                </div>
              )}
            </div>

            {/* Card 3: Worker quick deploy */}
            <div className="card">
              <div className="card-header">Worker 快捷部署</div>
              <div className="sidebar-stack-compact">
                <button
                  className="btn-secondary"
                  style={{ width: "100%" }}
                  onClick={() => void onWorkerLogin()}
                >
                  打开终端并登录 Wrangler
                </button>
                <button
                  className="btn-primary"
                  style={{ width: "100%" }}
                  onClick={() => void onWorkerDeploy()}
                >
                  一键远程部署 Worker
                </button>
                <button
                  className="btn-secondary"
                  style={{ width: "100%" }}
                  onClick={() => void onWorkerLoginAndDeploy()}
                >
                  登录检查 + 自动部署
                </button>
                <div className="text-subtle text-xs">
                  首次会把内置 Worker 模板释放到本机应用数据目录，再自动安装依赖并执行部署。
                  {isWindows && " Windows 上需要先安装 Node.js（nodejs.org），并确保 npx 在 PATH 中可用。"}
                </div>
              </div>
            </div>

            {/* Card 3: Cloud project */}
            <div className="card">
              <div className="card-header">云项目</div>
              {cloudCollab?.mode === "cloud" && cloudCollab.cloudProjectId ? (
                <div className="sidebar-stack-compact">
                  <div className="collab-identity-row">
                    <span
                      className={clsx(
                        "status-badge",
                        collabStatus.connectionError
                          ? "failed"
                          : collabStatus.hasConflict
                            ? "failed"
                          : collabStatus.syncInProgress
                            ? "running"
                            : collabStatus.synced
                              ? "success"
                              : "running",
                      )}
                    >
                      {collabStatus.connectionError
                        ? "同步失败"
                        : collabStatus.hasConflict
                          ? "存在冲突"
                        : collabStatus.syncInProgress
                          ? "同步中"
                        : collabStatus.synced
                            ? "已同步"
                            : collabStatus.pendingLocalChanges
                              ? "待推送"
                              : collabStatus.pendingRemoteChanges
                                ? "待拉取"
                                : "手动同步"}
                    </span>
                    <span className="text-subtle text-xs" style={{ wordBreak: "break-all" }}>
                      {cloudCollab.cloudProjectId.slice(0, 8)}…
                    </span>
                  </div>
                  <div className="text-subtle text-xs">
                    当前为手动同步模式，实时光标和在线成员已关闭。
                  </div>
                  <div className="text-subtle text-xs">
                    绿点已同步，黄点待推送，蓝点待拉取，红点表示本地和云端同时有未同步修改。
                  </div>
                  {collabStatus.lastSyncAt && (
                    <div className="text-subtle text-xs">
                      上次同步: {formatUsageTimestamp(collabStatus.lastSyncAt)}
                    </div>
                  )}
                  {collabStatus.connectionError && (
                    <div className="text-subtle text-xs" style={{ color: "var(--danger)" }}>
                      {collabStatus.connectionError}
                    </div>
                  )}
                  <div className="text-subtle text-xs">
                    推送和拉取入口已经移到顶部同步栏，以及左侧"源码管理"工具栏。
                  </div>
                  <button
                    className="btn-secondary"
                    style={{ width: "100%", marginTop: 8 }}
                    onClick={onCopyShareLink}
                    disabled={!collabStatus.canShare}
                  >
                    创建分享链接
                  </button>
                  <button
                    className="btn-secondary"
                    style={{ width: "100%" }}
                    onClick={onUnlinkCloudProject}
                    disabled={
                      collabBusyAction === "unlink-project" ||
                      collabBusyAction === "sync-project" ||
                      collabBusyAction === "pull-project"
                    }
                  >
                    {collabBusyAction === "unlink-project" ? "解除中..." : "解除当前工作区关联"}
                  </button>
                  <div className="text-subtle text-xs">
                    只解绑当前工作区，不会删除云端已有项目。
                  </div>
                </div>
              ) : (
                <div className="sidebar-stack-compact">
                  <div className="text-subtle text-xs">当前项目尚未关联到云端。</div>
                  <button
                    className="btn-primary"
                    style={{ width: "100%" }}
                    onClick={onCreateCloudProject}
                    disabled={
                      collabBusyAction === "create-project" ||
                      collabBusyAction === "link-project" ||
                      collabBusyAction === "unlink-project"
                    }
                  >
                    {collabBusyAction === "create-project" ? "创建中..." : "创建云协作项目"}
                  </button>
                  <button
                    className="btn-secondary"
                    style={{ width: "100%" }}
                    onClick={onLinkCloudProject}
                    disabled={
                      collabBusyAction === "create-project" ||
                      collabBusyAction === "link-project" ||
                      collabBusyAction === "unlink-project"
                    }
                  >
                    {collabBusyAction === "link-project" ? "关联中..." : "关联已有项目"}
                  </button>
                </div>
              )}
            </div>

            {/* Card 4: Comments */}
            <CommentPanel
              comments={comments}
              activeFilePath={activeFilePath}
              collabEnabled={cloudCollab?.mode === "cloud"}
              canComment={collabStatus.canComment}
              currentUserId={collabAuthSession?.userId ?? ""}
              onResolve={onResolveComment}
              onReply={onReplyComment}
              onDelete={onDeleteComment}
              onJumpToLine={onJumpToCommentLine}
            />
          </div>
        </>
      )}
    </div>
  );
}
