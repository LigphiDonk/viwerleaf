import { useState, useEffect } from "react";
import type { ProviderConfig, CliAgentStatus } from "../types";
import {
  AGENT_BRANDS,
  getAgentBrand as getBrand,
  normalizeProviderMcpServers,
  readProviderMcpServers,
  writeProviderMcpServers,
} from "../lib/agentCatalog";
import { desktop } from "../lib/desktop";

/* ── Provider Card (active provider display) ───────────────── */
interface CardProps {
  provider: ProviderConfig;
  isActive: boolean;
  testState?: string;
  onActivate: (id: string) => void;
  onTest: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
}

export function ProviderCard({ provider, isActive, onActivate, onDelete, onEdit }: CardProps) {
  const brand = getBrand(provider.vendor);
  const name = provider.name || brand.label;

  return (
    <div className="acard" style={{
      borderColor: isActive ? brand.borderActive : undefined,
      boxShadow: isActive ? `0 0 0 1px ${brand.borderActive}, 0 4px 20px ${brand.accentBg}` : undefined,
    }}>
      <div className="acard-header" style={{ background: brand.gradient }}>
        <div className="acard-icon">{brand.icon}</div>
        <div className="acard-meta">
          <div className="acard-name">{name}</div>
          <div className="acard-desc">{brand.description}</div>
        </div>
        <div className="acard-badge-area">
          {isActive ? (
            <div className="acard-badge acard-badge--active" style={{ 
              background: brand.accentBg, 
              color: brand.accentColor,
              borderColor: `${brand.accentColor}22`,
            }}>
              <span className="acard-badge-dot" style={{ background: brand.accentColor }} />
              使用中
            </div>
          ) : (
            <button 
              className="acard-badge acard-badge--enable" 
              type="button" 
              onClick={() => onActivate(provider.id)}
            >
              启用
            </button>
          )}
        </div>
      </div>

      <div className="acard-body">
        <div className="acard-model-row">
          <span className="acard-model-label">模型</span>
          <span className="acard-model-value">{provider.defaultModel || "未选择"}</span>
        </div>
        <div className="acard-toolbar">
          <button 
            className="acard-action-btn" 
            type="button" 
            title="编辑" 
            onClick={() => onEdit(provider.id)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            <span>编辑</span>
          </button>
          <button 
            className="acard-action-btn acard-action-btn--danger" 
            type="button" 
            title="删除" 
            onClick={() => onDelete(provider.id)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            <span>删除</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Agent Selector (add new provider) ─────────────────────── */
interface AgentSelectorProps {
  onAdd: (provider: ProviderConfig) => Promise<void>;
  existingCount: number;
}

export function AgentSelector({ onAdd, existingCount }: AgentSelectorProps) {
  const [selectedVendor, setSelectedVendor] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cliStatus, setCliStatus] = useState<Record<string, CliAgentStatus>>({});
  const [detectingCli, setDetectingCli] = useState(true);

  useEffect(() => {
    desktop
      .detectCliAgents()
      .then((agents) => {
        const map: Record<string, CliAgentStatus> = {};
        for (const a of agents) map[a.name] = a;
        setCliStatus(map);
      })
      .catch((error) => {
        console.warn("failed to detect CLI agents", error);
      })
      .finally(() => setDetectingCli(false));
  }, []);

  const brand = selectedVendor ? getBrand(selectedVendor) : null;

  async function handleAdd() {
    if (!selectedVendor || !selectedModel) return;
    setIsSubmitting(true);
    try {
      const b = getBrand(selectedVendor);
      await onAdd({
        id: `${selectedVendor}-${Date.now()}`,
        name: b.label,
        vendor: selectedVendor,
        baseUrl: "",
        defaultModel: selectedModel,
        apiKey: "",
        isEnabled: true,
        sortOrder: existingCount,
        metaJson: "{}",
      });
      setSelectedVendor(null);
      setSelectedModel("");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="agent-selector">
      <div className="agent-selector-title">选择 Agent</div>
      <div className="agent-selector-grid">
        {Object.entries(AGENT_BRANDS).map(([vendor, brand]) => {
          const status = cliStatus[vendor];
          const isAvailable = status?.available ?? false;
          const version = status?.version;
          return (
            <button
              key={vendor}
              type="button"
              className={`agent-option ${selectedVendor === vendor ? "agent-option--selected" : ""} ${!detectingCli && !isAvailable ? "agent-option--unavailable" : ""}`}
              style={{
                background: selectedVendor === vendor ? brand.gradient : undefined,
                borderColor: selectedVendor === vendor ? brand.borderActive : undefined,
                boxShadow: selectedVendor === vendor ? `0 0 0 1px ${brand.borderActive}20` : undefined,
              }}
              onClick={() => { 
                setSelectedVendor(vendor); 
                setSelectedModel(brand.defaultModel || brand.models[0]?.value || ""); 
              }}
            >
              <div className="agent-option-icon">{brand.icon}</div>
              <div className="agent-option-text">
                <div className="agent-option-name">
                  {brand.label}
                  {detectingCli ? (
                    <span className="agent-version-badge agent-version-loading">检测中…</span>
                  ) : isAvailable && version ? (
                    <span className="agent-version-badge agent-version-ok" style={{ color: brand.accentColor, background: brand.accentBg }}>v{version}</span>
                  ) : (
                    <span className="agent-version-badge agent-version-missing">未安装</span>
                  )}
                </div>
                <div className="agent-option-desc">{brand.description}</div>
              </div>
            </button>
          );
        })}
      </div>

      {selectedVendor && brand && (
        <div className="agent-model-section fade-in">
          <div className="agent-model-header">
            <span className="agent-model-title">选择模型</span>
          </div>
          <div className="agent-model-chips">
            {brand.models.map((model) => (
              <button
                key={model.value}
                type="button"
                className={`model-chip ${selectedModel === model.value ? "model-chip--active" : ""}`}
                style={{
                  ...(selectedModel === model.value ? { 
                    background: brand.accentBg, 
                    color: brand.accentColor,
                    borderColor: brand.borderActive,
                  } : {}),
                }}
                onClick={() => setSelectedModel(model.value)}
              >
                {model.label}
              </button>
            ))}
          </div>

          <div className="agent-custom-model">
            <input
              className="sidebar-input agent-model-input"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              placeholder="或输入自定义模型名"
            />
          </div>

          <button
            className="agent-add-btn"
            type="button"
            style={{ 
              background: brand.accentColor,
              opacity: (!selectedModel.trim() || isSubmitting) ? 0.5 : 1,
            }}
            disabled={isSubmitting || !selectedModel.trim()}
            onClick={() => void handleAdd()}
          >
            {isSubmitting ? "添加中…" : `+ 添加 ${brand.label}`}
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Edit modal ─────────────────────────────── */
interface EditModalProps {
  provider: ProviderConfig;
  onSave: (patch: Partial<ProviderConfig>) => Promise<void>;
  onClose: () => void;
}

export function ProviderEditModal({ provider, onSave, onClose }: EditModalProps) {
  const brand = getBrand(provider.vendor);
  const zoteroPreset = JSON.stringify(
    {
      zotero: {
        type: "stdio",
        command: "zotero-mcp",
        env: {
          ZOTERO_LOCAL: "true",
        },
      },
    },
    null,
    2,
  );
  const [form, setForm] = useState({
    name: provider.name ?? "",
    defaultModel: provider.defaultModel ?? "",
    mcpJson: JSON.stringify(readProviderMcpServers(provider), null, 2),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    let parsedMcpServers;
    try {
      parsedMcpServers = form.mcpJson.trim()
        ? normalizeProviderMcpServers(JSON.parse(form.mcpJson))
        : {};
    } catch {
      setError("MCP 配置必须是合法 JSON。");
      return;
    }

    setSaving(true);
    try {
      await onSave({
        name: form.name.trim() || brand.label,
        defaultModel: form.defaultModel.trim(),
        metaJson: writeProviderMcpServers(provider, parsedMcpServers),
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box">
        <div className="modal-header">
          <span>{brand.icon} 编辑 {brand.label}</span>
          <button className="modal-close" type="button" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <label className="modal-label">
            自定义名称
            <input className="sidebar-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={brand.label} autoFocus />
          </label>
          <label className="modal-label">
            模型
            <input className="sidebar-input" value={form.defaultModel} onChange={e => setForm(f => ({ ...f, defaultModel: e.target.value }))} placeholder={brand.models[0]?.value || "model-name"} />
          </label>
          <label className="modal-label">
            MCP Servers JSON
            <textarea
              className="sidebar-input"
              rows={9}
              value={form.mcpJson}
              onChange={(e) => {
                setError("");
                setForm((current) => ({ ...current, mcpJson: e.target.value }));
              }}
              spellCheck={false}
              placeholder={`{\n  "zotero": {\n    "type": "stdio",\n    "command": "zotero-mcp"\n  }\n}`}
              style={{ resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
            />
          </label>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 8 }}>
            <div style={{ color: "rgba(15, 23, 42, 0.7)", fontSize: 12, lineHeight: 1.5 }}>
              目前仅支持 `stdio` MCP。若本机已安装 `zotero-mcp`，应用会自动把 Zotero 作为默认 MCP 挂上。
            </div>
            <button
              className="btn-secondary"
              type="button"
              onClick={() => {
                setError("");
                setForm((current) => ({ ...current, mcpJson: zoteroPreset }));
              }}
            >
              填入 Zotero 预设
            </button>
          </div>
          {error ? (
            <div style={{ marginTop: 8, color: "#b91c1c", fontSize: 12 }}>
              {error}
            </div>
          ) : null}
          <div className="agent-model-chips" style={{ marginTop: 8 }}>
            {brand.models.map((model) => (
              <button
                key={model.value}
                type="button"
                className={`model-chip ${form.defaultModel === model.value ? "model-chip--active" : ""}`}
                style={{
                  ...(form.defaultModel === model.value ? { 
                    background: brand.accentBg, 
                    color: brand.accentColor,
                    borderColor: brand.borderActive,
                  } : {}),
                }}
                onClick={() => setForm(f => ({ ...f, defaultModel: model.value }))}
              >
                {model.label}
              </button>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" type="button" onClick={onClose}>取消</button>
          <button className="btn-primary" type="button" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
