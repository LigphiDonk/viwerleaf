import { useState } from "react";
import type { CollabAuthSession } from "../lib/collaboration/auth";

interface CollabLoginModalProps {
  currentSession: CollabAuthSession | null;
  preserveUserId?: boolean;
  onSave: (session: CollabAuthSession) => void;
  onClose: () => void;
}

const DEFAULT_COLORS = [
  "#4f8cff", "#ff6b6b", "#51cf66", "#fcc419", "#cc5de8",
  "#20c997", "#ff922b", "#845ef7", "#339af0", "#f06595",
];

function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || `user-${Date.now()}`;
}

function encodeDevTokenName(name: string) {
  return encodeURIComponent(name).replace(/%20/g, "+");
}

export function CollabLoginModal({
  currentSession,
  preserveUserId = true,
  onSave,
  onClose,
}: CollabLoginModalProps) {
  const [name, setName] = useState(currentSession?.name ?? "");
  const [email, setEmail] = useState(currentSession?.email ?? "");
  const [color, setColor] = useState(currentSession?.color ?? "#4f8cff");

  function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const userId = preserveUserId && currentSession?.userId
      ? currentSession.userId
      : slugify(trimmedName);
    const token = `dev:${userId}:${encodeDevTokenName(trimmedName)}`;
    onSave({
      token,
      userId,
      email: email.trim() || undefined,
      name: trimmedName,
      color,
    });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
        <div className="modal-header">
          <span>{currentSession ? "编辑身份" : "登录协作"}</span>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="collab-config-field">
            <label>显示名称 *</label>
            <input
              className="sidebar-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="你的名字"
              autoFocus
            />
          </div>
          <div className="collab-config-field">
            <label>邮箱（选填）</label>
            <input
              className="sidebar-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@example.com"
              type="email"
            />
          </div>
          <div className="collab-config-field">
            <label>标识颜色</label>
            <div className="collab-color-picker">
              {DEFAULT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`collab-color-swatch${color === c ? " is-active" : ""}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="collab-color-input"
                title="自定义颜色"
              />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={handleSave} disabled={!name.trim()}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
