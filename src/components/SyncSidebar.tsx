import clsx from "clsx";
import { useState } from "react";

import type { AppLocale, CloudProjectRole, CollabFileSyncState, CollabStatus } from "../types";

type SyncChangeEntry = {
  path: string;
  state: CollabFileSyncState;
};

interface SyncSidebarProps {
  locale: AppLocale;
  projectId: string | null;
  workspaceLabel: string;
  linkedAt: string;
  notice: { tone: "success" | "error"; text: string } | null;
  lastSyncAt: string;
  role: CloudProjectRole | null;
  collabStatus: CollabStatus;
  busyAction: "save-config" | "create-project" | "link-project" | "unlink-project" | "sync-project" | "pull-project" | null;
  changes: SyncChangeEntry[];
  ignoredPaths: Set<string>;
  onIgnorePath: (path: string) => void;
  onUnignorePath: (path: string) => void;
  onPush: () => void;
  onPull: () => void;
  onOpenShareModal: () => void;
  onCreateProject: () => void;
  onLinkProject: () => void;
  onOpenCollabSettings: () => void;
}

type SyncGraphEntry = {
  id: string;
  title: string;
  subtitle: string;
  badge?: string;
  tone: "neutral" | "push" | "pull" | "conflict" | "success" | "error";
};

function roleLabel(role: CloudProjectRole | null, locale: AppLocale) {
  const isZh = locale === "zh-CN";
  if (role === "owner") return isZh ? "所有者" : "Owner";
  if (role === "editor") return isZh ? "可编辑" : "Editor";
  if (role === "commenter") return isZh ? "可批注" : "Commenter";
  if (role === "viewer") return isZh ? "只读" : "Viewer";
  return isZh ? "未连接" : "Disconnected";
}

function stateLabel(state: CollabFileSyncState, locale: AppLocale) {
  const isZh = locale === "zh-CN";
  if (state === "synced") return isZh ? "已同步" : "Synced";
  if (state === "pending-push") return isZh ? "待推送" : "Pending push";
  if (state === "pending-pull") return isZh ? "待拉取" : "Pending pull";
  if (state === "ignored") return isZh ? "已忽略" : "Ignored";
  return isZh ? "冲突" : "Conflict";
}

function formatTimestamp(value: string, locale: AppLocale) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function summarizeEntries(entries: SyncChangeEntry[]) {
  if (entries.length === 0) {
    return "当前没有文件。";
  }
  const preview = entries.slice(0, 2).map((entry) => entry.path);
  if (entries.length <= 2) {
    return preview.join(" · ");
  }
  return `${preview.join(" · ")} +${entries.length - 2}`;
}

export function SyncSidebar({
  locale,
  projectId,
  workspaceLabel,
  linkedAt,
  notice,
  lastSyncAt,
  role,
  collabStatus,
  busyAction,
  changes,
  onIgnorePath,
  onUnignorePath,
  onPush,
  onPull,
  onOpenShareModal,
  onCreateProject,
  onLinkProject,
  onOpenCollabSettings,
}: SyncSidebarProps) {
  const isZh = locale === "zh-CN";
  const [ignoredExpanded, setIgnoredExpanded] = useState(false);
  const pendingPush = changes.filter((entry) => entry.state === "pending-push");
  const pendingPull = changes.filter((entry) => entry.state === "pending-pull");
  const conflicts = changes.filter((entry) => entry.state === "conflict");
  const ignored = changes.filter((entry) => entry.state === "ignored");
  const activeChanges = changes.filter((entry) => entry.state !== "ignored");
  const hasCloudProject = Boolean(projectId);
  const graphEntries: SyncGraphEntry[] = hasCloudProject
    ? [
      {
        id: "head",
        title: workspaceLabel || (isZh ? "当前工作区" : "Current workspace"),
        subtitle: `${isZh ? "当前权限" : "Role"}: ${roleLabel(role, locale)} · ${projectId?.slice(0, 8)}…`,
        badge: "HEAD",
        tone: "neutral",
      },
      ...(notice
        ? [{
          id: "notice",
          title: notice.tone === "error" ? (isZh ? "最近一次操作失败" : "Latest operation failed") : (isZh ? "最近一次操作" : "Latest operation"),
          subtitle: notice.text,
          badge: notice.tone === "error" ? "ERR" : "OK",
          tone: notice.tone === "error" ? "error" : "success",
        } satisfies SyncGraphEntry]
        : []),
      ...(pendingPush.length > 0
        ? [{
          id: "push",
          title: isZh ? `待推送 ${pendingPush.length} 个文件` : `${pendingPush.length} files pending push`,
          subtitle: summarizeEntries(pendingPush),
          badge: "PUSH",
          tone: "push",
        } satisfies SyncGraphEntry]
        : []),
      ...(pendingPull.length > 0
        ? [{
          id: "pull",
          title: isZh ? `待拉取 ${pendingPull.length} 个文件` : `${pendingPull.length} files pending pull`,
          subtitle: summarizeEntries(pendingPull),
          badge: "PULL",
          tone: "pull",
        } satisfies SyncGraphEntry]
        : []),
      ...(conflicts.length > 0
        ? [{
          id: "conflict",
          title: isZh ? `冲突 ${conflicts.length} 个文件` : `${conflicts.length} conflicting files`,
          subtitle: summarizeEntries(conflicts),
          badge: "CONFLICT",
          tone: "conflict",
        } satisfies SyncGraphEntry]
        : pendingPush.length === 0 && pendingPull.length === 0
          ? [{
            id: "synced",
            title: isZh ? "当前工作区与云端一致" : "Workspace is in sync with cloud",
            subtitle: lastSyncAt ? `${isZh ? "最近同步" : "Last sync"}: ${formatTimestamp(lastSyncAt, locale)}` : (isZh ? "还没有新的待同步文件。" : "There are no pending files right now."),
            badge: "SYNC",
            tone: "success",
          } satisfies SyncGraphEntry]
          : []),
      ...(lastSyncAt
        ? [{
          id: "last-sync",
          title: isZh ? "最近一次手动同步" : "Latest manual sync",
          subtitle: formatTimestamp(lastSyncAt, locale),
          badge: "SYNC",
          tone: "success",
        } satisfies SyncGraphEntry]
        : []),
      ...(linkedAt
        ? [{
          id: "linked",
          title: isZh ? "已关联云项目" : "Cloud project linked",
          subtitle: formatTimestamp(linkedAt, locale),
          badge: "LINK",
          tone: "neutral",
        } satisfies SyncGraphEntry]
        : []),
    ]
    : [];

  return (
    <aside className="primary-sidebar sync-sidebar">
      <div className="sync-sidebar-header">
        <div>
          <div className="sidebar-header">{isZh ? "源码管理" : "Source Control"}</div>
          <div className="sync-sidebar-title">{isZh ? "手动云同步" : "Manual Cloud Sync"}</div>
        </div>
        <button className="link-btn" type="button" onClick={onOpenCollabSettings}>
          {isZh ? "设置" : "Settings"}
        </button>
      </div>

      <div className="sync-sidebar-body">
        {!hasCloudProject ? (
          <div className="sync-empty-card">
            <div className="sync-empty-title">{isZh ? "当前工作区还没连接云协作" : "This workspace is not linked to cloud collaboration yet"}</div>
            <div className="sync-empty-text">
              {isZh
                ? "先创建云项目或关联已有项目，之后这里会像源码管理面板一样显示待推送、待拉取和冲突文件。"
                : "Create a cloud project or link an existing one. This panel will then show pending pushes, pulls, and conflicts."}
            </div>
            <div className="sync-empty-actions">
              <button className="btn-primary" type="button" onClick={onCreateProject}>
                {isZh ? "创建云项目" : "Create Cloud Project"}
              </button>
              <button className="btn-secondary" type="button" onClick={onLinkProject}>
                {isZh ? "关联已有项目" : "Link Existing Project"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="sync-summary-card">
              <div className="sync-summary-top">
                <span className="sync-role-pill">{roleLabel(role, locale)}</span>
                <span className="text-subtle text-xs">{projectId?.slice(0, 8)}…</span>
              </div>
              <div className="sync-summary-grid">
                <div className="sync-metric is-push">
                  <strong>{pendingPush.length}</strong>
                  <span>{isZh ? "待推送" : "Push"}</span>
                </div>
                <div className="sync-metric is-pull">
                  <strong>{pendingPull.length}</strong>
                  <span>{isZh ? "待拉取" : "Pull"}</span>
                </div>
                <div className="sync-metric is-conflict">
                  <strong>{conflicts.length}</strong>
                  <span>{isZh ? "冲突" : "Conflict"}</span>
                </div>
                <div className="sync-metric is-ignored">
                  <strong>{ignored.length}</strong>
                  <span>{isZh ? "已忽略" : "Ignored"}</span>
                </div>
              </div>
              <div className="sync-primary-actions">
                <button
                  className="btn-primary"
                  type="button"
                  onClick={onPush}
                  disabled={
                    busyAction === "sync-project" ||
                    busyAction === "pull-project" ||
                    (pendingPush.length === 0 && conflicts.length === 0) ||
                    !collabStatus.canComment
                  }
                >
                  {busyAction === "sync-project" ? (isZh ? "推送中..." : "Pushing...") : (isZh ? "推送" : "Push")}
                </button>
                <button
                  className="btn-secondary"
                  type="button"
                  onClick={onPull}
                  disabled={busyAction === "sync-project" || busyAction === "pull-project" || pendingPull.length === 0}
                >
                  {busyAction === "pull-project" ? (isZh ? "拉取中..." : "Pulling...") : (isZh ? "拉取" : "Pull")}
                </button>
              </div>
              <button
                className="sync-share-button"
                type="button"
                onClick={onOpenShareModal}
                disabled={!collabStatus.canShare}
              >
                {isZh ? "创建分享链接" : "Create Share Link"}
              </button>
            </div>

            <div className="sync-section sync-graph-section">
              <div className="sync-section-header">
                <span>{isZh ? "同步图" : "Sync Graph"}</span>
                <span className="text-subtle text-xs">{isZh ? `${graphEntries.length} 个节点` : `${graphEntries.length} nodes`}</span>
              </div>
              <div className="sync-graph-list">
                {graphEntries.map((entry, index) => (
                  <div key={entry.id} className="sync-graph-item">
                    <div className="sync-graph-rail" aria-hidden="true">
                      <span className={clsx("sync-graph-node", `is-${entry.tone}`)} />
                      {index < graphEntries.length - 1 && <span className="sync-graph-line" />}
                    </div>
                    <div className="sync-graph-card">
                      <div className="sync-graph-top">
                        <div className="sync-graph-title">{entry.title}</div>
                        {entry.badge && (
                          <span className={clsx("sync-graph-badge", `is-${entry.tone}`)}>{entry.badge}</span>
                        )}
                      </div>
                      <div className="sync-graph-subtitle">{entry.subtitle}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="sync-section">
              <div className="sync-section-header">
                <span>{isZh ? "变更" : "Changes"}</span>
                <span className="text-subtle text-xs">{isZh ? `${activeChanges.length} 个文件` : `${activeChanges.length} files`}</span>
              </div>

              {activeChanges.length === 0 ? (
                <div className="sync-section-empty">{isZh ? "当前没有待同步文件。" : "There are no pending files."}</div>
              ) : (
                <div className="sync-change-list">
                  {activeChanges.map((entry, index) => (
                    <div key={`${entry.state}:${entry.path}`} className="sync-change-item">
                      <div className="sync-change-rail" aria-hidden="true">
                        <span className={`sync-change-node is-${entry.state}`}></span>
                        {index < activeChanges.length - 1 && <span className="sync-change-line" />}
                      </div>
                      <span className="sync-change-path">{entry.path}</span>
                      <span
                        className={clsx(
                          "sync-change-state",
                          entry.state === "pending-push" && "is-push",
                          entry.state === "pending-pull" && "is-pull",
                          entry.state === "conflict" && "is-conflict",
                        )}
                      >
                        {stateLabel(entry.state, locale)}
                      </span>
                      {entry.state === "pending-push" && (
                        <button
                          className="sync-ignore-btn"
                          type="button"
                          title={isZh ? "忽略此文件（不推送）" : "Ignore this file (skip push)"}
                          onClick={() => onIgnorePath(entry.path)}
                        >
                          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8">
                            <line x1="3" y1="3" x2="13" y2="13"/>
                            <line x1="13" y1="3" x2="3" y2="13"/>
                          </svg>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {ignored.length > 0 && (
              <div className="sync-section">
                <button
                  className="sync-section-header sync-section-header--toggle"
                  type="button"
                  onClick={() => setIgnoredExpanded((v) => !v)}
                >
                  <span>{isZh ? "已忽略" : "Ignored"}</span>
                  <span className="text-subtle text-xs">
                    {isZh ? `${ignored.length} 个文件` : `${ignored.length} files`}
                    <span className="sync-ignored-chevron">{ignoredExpanded ? " ▲" : " ▼"}</span>
                  </span>
                </button>
                {ignoredExpanded && (
                  <div className="sync-change-list">
                    {ignored.map((entry) => (
                      <div key={`ignored:${entry.path}`} className="sync-change-item is-ignored">
                        <div className="sync-change-rail" aria-hidden="true">
                          <span className="sync-change-node is-ignored"></span>
                        </div>
                        <span className="sync-change-path">{entry.path}</span>
                        <button
                          className="sync-unignore-btn"
                          type="button"
                          title={isZh ? "取消忽略" : "Restore"}
                          onClick={() => onUnignorePath(entry.path)}
                        >
                          {isZh ? "恢复" : "Restore"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {conflicts.length > 0 && (
              <div className="sync-warning-card">
                {isZh
                  ? "红色冲突文件不会被自动推送或拉取，避免把正文直接覆盖掉。"
                  : "Conflicting files are not pushed or pulled automatically, to avoid overwriting manuscript content."}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
