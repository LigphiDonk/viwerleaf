import { type ReactNode, useMemo, useState } from "react";

import type { WorkspaceEntry } from "../types";

interface WelcomeWorkspaceProps {
  recentWorkspaces: WorkspaceEntry[];
  onOpenProject: () => void;
  onCreateProject: () => void;
  onOpenRecentWorkspace: (rootPath: string) => void;
}

const RECENT_WORKSPACE_PREVIEW_COUNT = 4;

function WelcomeActivityIcon({
  children,
  accent = false,
}: {
  children: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={`welcome-activity-icon ${accent ? "is-accent" : ""}`} aria-hidden="true">
      {children}
    </div>
  );
}

export function WelcomeWorkspace({
  recentWorkspaces,
  onOpenProject,
  onCreateProject,
  onOpenRecentWorkspace,
}: WelcomeWorkspaceProps) {
  const [showAllRecent, setShowAllRecent] = useState(false);
  const visibleRecentWorkspaces = useMemo(
    () => (showAllRecent ? recentWorkspaces : recentWorkspaces.slice(0, RECENT_WORKSPACE_PREVIEW_COUNT)),
    [recentWorkspaces, showAllRecent],
  );
  const hasHiddenRecentWorkspaces = recentWorkspaces.length > visibleRecentWorkspaces.length;

  return (
    <div className="welcome-workspace">
      <aside className="welcome-activity-bar" aria-label="ViewerLeaf tools">
        <WelcomeActivityIcon accent>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 4h10l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"></path>
            <path d="M14 4v4h4"></path>
          </svg>
        </WelcomeActivityIcon>
        <WelcomeActivityIcon>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="4"></rect>
            <path d="M7 15l3-3 2 2 5-6"></path>
          </svg>
        </WelcomeActivityIcon>
        <WelcomeActivityIcon>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33"></path>
            <path d="M4.6 9A1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 8.92 4"></path>
            <path d="M9 19.08A1.65 1.65 0 0 0 7.18 19l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4 14.92"></path>
            <path d="M15 4.92A1.65 1.65 0 0 0 16.82 5l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 20 9.08"></path>
          </svg>
        </WelcomeActivityIcon>
        <WelcomeActivityIcon>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7"></rect>
            <rect x="14" y="3" width="7" height="7"></rect>
            <rect x="14" y="14" width="7" height="7"></rect>
            <rect x="3" y="14" width="7" height="7"></rect>
          </svg>
        </WelcomeActivityIcon>
        <WelcomeActivityIcon>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3v18h18"></path>
            <path d="M7 14l4-4 3 3 5-7"></path>
          </svg>
        </WelcomeActivityIcon>
      </aside>

      <section className="welcome-canvas">
        <div className="welcome-center">
          <div className="welcome-kicker">Workspace</div>
          <h1 className="welcome-title">打开项目</h1>
          <p className="welcome-copy">或创建一个新项目。</p>

          <div className="welcome-actions">
            <button className="btn-primary welcome-action-btn" type="button" onClick={onOpenProject}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7h5l2 2h11v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path>
              </svg>
              打开项目
            </button>
            <button className="btn-secondary welcome-action-btn welcome-action-btn--secondary" type="button" onClick={onCreateProject}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14"></path>
                <path d="M5 12h14"></path>
              </svg>
              创建项目
            </button>
          </div>

          <div className="welcome-recent-section">
            <div className="welcome-recent-label">最近项目</div>

            {visibleRecentWorkspaces.length > 0 ? (
              <div className="welcome-recent-list">
                {visibleRecentWorkspaces.map((workspace) => (
                  <button
                    key={workspace.rootPath}
                    className="welcome-recent-card"
                    type="button"
                    onClick={() => onOpenRecentWorkspace(workspace.rootPath)}
                  >
                    <div className="welcome-recent-main">
                      <div className="welcome-recent-title">{workspace.label}</div>
                      <div className="welcome-recent-path">{workspace.rootPath}</div>
                    </div>
                    <div className="welcome-recent-arrow" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12h14"></path>
                        <path d="M13 5l7 7-7 7"></path>
                      </svg>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="welcome-empty-note">暂无最近项目</div>
            )}

            {hasHiddenRecentWorkspaces && (
              <button className="welcome-more-btn" type="button" onClick={() => setShowAllRecent(true)}>
                更多
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
