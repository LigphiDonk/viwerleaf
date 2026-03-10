import clsx from "clsx";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { PROVIDER_PRESETS } from "../lib/providerPresets";
import type {
  AgentMessage,
  AgentProfile,
  FigureBriefDraft,
  GeneratedAsset,
  ProviderConfig,
  TestResult,
} from "../types";

interface SidebarProps {
  tab: string;
  messages: AgentMessage[];
  profiles: AgentProfile[];
  activeProfileId: string;
  onSelectProfile: (profileId: string) => void;
  onRunAgent: () => void;
  pendingPatchSummary?: string;
  onApplyPatch: () => void;
  compileLog: string;
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
  explorerNode: ReactNode;
  onAddProvider: (provider: ProviderConfig) => Promise<void>;
  onDeleteProvider: (providerId: string) => Promise<void>;
  onTestProvider: (providerId: string) => Promise<TestResult>;
  streamText?: string;
  isStreaming?: boolean;
}

function providerEnabled(provider: ProviderConfig) {
  return provider.isEnabled ?? true;
}

export function Sidebar({
  tab,
  messages,
  profiles,
  activeProfileId,
  onSelectProfile,
  onRunAgent,
  pendingPatchSummary,
  onApplyPatch,
  compileLog,
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
  explorerNode,
  onAddProvider,
  onDeleteProvider,
  onTestProvider,
  streamText,
  isStreaming,
}: SidebarProps) {
  const [selectedVendor, setSelectedVendor] = useState(PROVIDER_PRESETS[0]?.vendor ?? "openai");
  const [providerForm, setProviderForm] = useState(() => {
    const preset = PROVIDER_PRESETS[0];
    return {
      name: preset?.name ?? "OpenAI",
      baseUrl: preset?.baseUrl ?? "",
      apiKey: "",
      defaultModel: preset?.models[0] ?? "",
    };
  });
  const [providerActionState, setProviderActionState] = useState<Record<string, string>>({});
  const [isSubmittingProvider, setIsSubmittingProvider] = useState(false);

  const selectedPreset = useMemo(
    () => PROVIDER_PRESETS.find((preset) => preset.vendor === selectedVendor) ?? PROVIDER_PRESETS[0],
    [selectedVendor],
  );

  function updateProviderForm(nextVendor: string) {
    const preset = PROVIDER_PRESETS.find((item) => item.vendor === nextVendor);
    setSelectedVendor(nextVendor);
    setProviderForm((current) => ({
      ...current,
      name: preset?.name ?? current.name,
      baseUrl: preset?.baseUrl ?? current.baseUrl,
      defaultModel: preset?.models[0] ?? current.defaultModel,
    }));
  }

  async function handleAddProvider() {
    setIsSubmittingProvider(true);
    try {
      await onAddProvider({
        id: `${selectedVendor}-${Date.now()}`,
        name: providerForm.name,
        vendor: selectedVendor,
        baseUrl: providerForm.baseUrl,
        apiKey: providerForm.apiKey,
        defaultModel: providerForm.defaultModel,
        isEnabled: true,
        sortOrder: providers.length,
        metaJson: "{}",
      });
      setProviderForm((current) => ({ ...current, apiKey: "" }));
    } finally {
      setIsSubmittingProvider(false);
    }
  }

  async function handleTestProvider(providerId: string) {
    setProviderActionState((current) => ({ ...current, [providerId]: "测试中..." }));
    try {
      const result = await onTestProvider(providerId);
      setProviderActionState((current) => ({
        ...current,
        [providerId]: result.success
          ? `连接正常 · ${result.latencyMs}ms`
          : `失败: ${result.error ?? "unknown error"}`,
      }));
    } catch (error) {
      setProviderActionState((current) => ({
        ...current,
        [providerId]: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  return (
    <div className="primary-sidebar">
      {tab === "explorer" && (
        <>
          <div className="sidebar-header">项目资源 (Explorer)</div>
          <div className="sidebar-content" style={{ padding: "8px 0" }}>
            {explorerNode}
          </div>
        </>
      )}

      {tab === "ai" && (
        <>
          <div className="sidebar-header">AI 智能体助手</div>
          <div className="sidebar-content" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div className="card hover-spring">
              <div className="card-header">智能体配置</div>
              <select
                style={{ width: "100%", padding: "6px", borderRadius: "4px", border: "1px solid var(--border-light)", fontSize: "12px", marginBottom: "12px" }}
                value={activeProfileId}
                onChange={(event) => onSelectProfile(event.target.value)}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label} - {profile.model}
                  </option>
                ))}
              </select>

              <div style={{ display: "flex", gap: "8px" }}>
                <button className="btn-primary" onClick={onRunAgent} style={{ flex: 1 }} disabled={isStreaming}>
                  {isStreaming ? "处理中..." : "执行分析"}
                </button>
                <button className="btn-secondary" disabled={!pendingPatchSummary} onClick={onApplyPatch}>
                  应用补丁
                </button>
              </div>
              {pendingPatchSummary && (
                <div style={{ marginTop: "8px", fontSize: "11px", color: "var(--accent-primary)" }}>
                  待处理: {pendingPatchSummary}
                </div>
              )}
            </div>

            <div className="message-list">
              {messages.map((message) => (
                <div key={message.id} className={clsx("message", `role - ${message.role} `)}>
                  <div className="message-header">
                    {message.role === "user" ? "用户 (User)" : "助手 (Assistant)"} · {message.profileId}
                  </div>
                  <div className="message-bubble">{message.content}</div>
                </div>
              ))}
              {streamText && (
                <div className={clsx("message", "role - assistant")}>
                  <div className="message-header">助手 (Streaming)</div>
                  <div className="message-bubble" style={{ whiteSpace: "pre-wrap" }}>
                    {streamText}
                  </div>
                </div>
              )}
              {messages.length === 0 && !streamText && (
                <div style={{ textAlign: "center", color: "var(--text-tertiary)", marginTop: "20px", fontSize: "13px" }}>
                  暂无对话记录
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {tab === "logs" && (
        <>
          <div className="sidebar-header">编译日志 (Logs)</div>
          <div className="sidebar-content" style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ marginBottom: "12px", fontSize: "13px" }}>
              <span className={clsx("status-badge", diagnosticsCount > 0 ? "failed" : "success")}>
                {diagnosticsCount ? `发现 ${diagnosticsCount} 个问题` : "暂无编译问题"}
              </span>
            </div>
            <pre className="log-surface" style={{ flex: 1 }}>{compileLog || "无日志输出"}</pre>
          </div>
        </>
      )}

      {tab === "figures" && (
        <>
          <div className="sidebar-header">图表生成 (Figures)</div>
          <div className="sidebar-content">
            <div className="card">
              <div className="card-header">操作面板</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "8px" }}>
                <button className="btn-primary" onClick={onCreateBrief}>新建概要</button>
                <button className="btn-secondary" disabled={!selectedBriefId} onClick={onRunFigureSkill}>预处理</button>
                <button className="btn-secondary" disabled={!selectedBriefId} onClick={onGenerateFigure}>生成图像</button>
                <button className="btn-secondary" disabled={!selectedAssetId} onClick={onInsertFigure}>插入文档</button>
              </div>
            </div>

            <div style={{ marginTop: "16px", marginBottom: "8px", fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)" }}>
              图表概要 (Briefs)
            </div>
            <div style={{ display: "grid", gap: "8px" }}>
              {briefs.map((brief) => (
                <div
                  key={brief.id}
                  className={clsx("card hover-spring", selectedBriefId === brief.id && "is-active")}
                  style={{ cursor: "pointer", borderColor: selectedBriefId === brief.id ? "var(--accent-primary)" : "", marginBottom: 0 }}
                  onClick={() => onSelectBrief(brief.id)}
                >
                  <div style={{ fontWeight: 500, fontSize: "12px", color: "var(--text-primary)" }}>{brief.sourceSectionRef || "未命名节点"}</div>
                  <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>状态: {brief.status}</div>
                </div>
              ))}
              {briefs.length === 0 && <div className="text-subtle text-xs">暂无数据</div>}
            </div>

            <div style={{ marginTop: "16px", marginBottom: "8px", fontSize: "12px", fontWeight: 600, color: "var(--text-secondary)" }}>
              已生成资源 (Assets)
            </div>
            <div style={{ display: "grid", gap: "8px" }}>
              {assets.map((asset) => (
                <div
                  key={asset.id}
                  className="card hover-spring"
                  style={{ cursor: "pointer", borderColor: selectedAssetId === asset.id ? "var(--accent-primary)" : "", marginBottom: 0 }}
                  onClick={() => onSelectAsset(asset.id)}
                >
                  <img alt={asset.filePath} src={asset.previewUri} style={{ width: "100%", borderRadius: "4px", marginBottom: "6px" }} />
                  <div style={{ fontSize: "11px", wordBreak: "break-all" }}>{asset.filePath}</div>
                </div>
              ))}
              {assets.length === 0 && <div className="text-subtle text-xs">暂无数据</div>}
            </div>
          </div>
        </>
      )}

      {tab === "providers" && (
        <>
          <div className="sidebar-header">API 配置 (Providers)</div>
          <div className="sidebar-content">
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-header">添加 Provider</div>
              <div style={{ display: "grid", gap: 8 }}>
                <select value={selectedVendor} onChange={(event) => updateProviderForm(event.target.value)}>
                  {PROVIDER_PRESETS.map((preset) => (
                    <option key={preset.vendor} value={preset.vendor}>{preset.name}</option>
                  ))}
                </select>
                <input
                  value={providerForm.name}
                  onChange={(event) => setProviderForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="名称"
                />
                <input
                  value={providerForm.baseUrl}
                  onChange={(event) => setProviderForm((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder="Base URL"
                />
                <input
                  value={providerForm.defaultModel}
                  onChange={(event) => setProviderForm((current) => ({ ...current, defaultModel: event.target.value }))}
                  placeholder="默认模型"
                  list="provider-models"
                />
                <datalist id="provider-models">
                  {selectedPreset?.models.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
                <input
                  type="password"
                  value={providerForm.apiKey}
                  onChange={(event) => setProviderForm((current) => ({ ...current, apiKey: event.target.value }))}
                  placeholder="API Key"
                />
                <button className="btn-primary" onClick={() => void handleAddProvider()} disabled={isSubmittingProvider || !providerForm.name || !providerForm.defaultModel}>
                  {isSubmittingProvider ? "保存中..." : "添加 Provider"}
                </button>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {providers.map((provider) => (
                <div key={provider.id} className="card hover-spring">
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <div>
                      <div style={{ fontWeight: 600, color: "var(--text-primary)", fontSize: "13px" }}>
                        {provider.name ?? provider.vendor}
                      </div>
                      <div style={{ color: "var(--text-secondary)", fontSize: "12px", marginTop: "4px" }}>
                        默认模型: {provider.defaultModel}
                      </div>
                      <div style={{ color: "var(--text-tertiary)", fontSize: "11px", marginTop: "2px", wordBreak: "break-all" }}>
                        {provider.baseUrl}
                      </div>
                      <div style={{ color: providerEnabled(provider) ? "var(--accent-primary)" : "var(--text-tertiary)", fontSize: 11, marginTop: 6 }}>
                        {providerEnabled(provider) ? "已启用" : "已禁用"}
                      </div>
                    </div>
                    <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
                      <button className="btn-secondary" onClick={() => void handleTestProvider(provider.id)}>
                        测试连接
                      </button>
                      <button className="btn-secondary" onClick={() => void onDeleteProvider(provider.id)}>
                        删除
                      </button>
                    </div>
                  </div>
                  {providerActionState[provider.id] && (
                    <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-secondary)" }}>
                      {providerActionState[provider.id]}
                    </div>
                  )}
                </div>
              ))}
              {providers.length === 0 && (
                <div className="text-subtle text-xs" style={{ textAlign: "center", padding: "10px" }}>未提供API配置</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
