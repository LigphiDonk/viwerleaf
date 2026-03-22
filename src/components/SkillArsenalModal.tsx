import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { weaponSvg, BUILTIN_SKILLS } from "../lib/weaponPixels";
import { desktop } from "../lib/desktop";
import type { AcademicSkill, SkillManifest } from "../types";

/* ── Types ───────────────────────────────────────── */

interface SkillArsenalModalProps {
  open: boolean;
  skills: SkillManifest[];
  onClose: () => void;
  onToggleSkill: (skill: SkillManifest) => Promise<void>;
  onSkillAction?: (skill: AcademicSkill) => void;
  onSkillsChanged?: () => void;
}

type ResearchBundleId =
  | "survey"
  | "ideation"
  | "experiment"
  | "publication"
  | "promotion"
  | "utility";

type ModalView =
  | { kind: "grid" }
  | { kind: "folder"; bundleId: ResearchBundleId }
  | { kind: "detail"; skillId: string };

/* ── Constants ───────────────────────────────────── */

const RESEARCH_BUNDLE_ORDER: ResearchBundleId[] = [
  "survey",
  "ideation",
  "experiment",
  "publication",
  "promotion",
  "utility",
];

const RESEARCH_BUNDLE_META: Record<
  ResearchBundleId,
  { title: string; subtitle: string; gradient: string }
> = {
  survey: {
    title: "领域调研与文献整理",
    subtitle: "文献检索 · 领域图谱",
    gradient: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  },
  ideation: {
    title: "Idea 生成",
    subtitle: "想法生成 · novelty 检查",
    gradient: "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
  },
  experiment: {
    title: "实验推进",
    subtitle: "实验设计 · 分析检查",
    gradient: "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)",
  },
  publication: {
    title: "论文写作",
    subtitle: "结构 · 证据映射 · 投稿",
    gradient: "linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)",
  },
  promotion: {
    title: "成果传播",
    subtitle: "Slides · 摘要 · 展示",
    gradient: "linear-gradient(135deg, #fa709a 0%, #fee140 100%)",
  },
  utility: {
    title: "通用工具",
    subtitle: "跨阶段能力",
    gradient: "linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)",
  },
};

function resolveResearchBundleId(manifest: SkillManifest): ResearchBundleId {
  const normalizedStages = (manifest.stages ?? []).map((s) => s.toLowerCase());
  for (const bundleId of RESEARCH_BUNDLE_ORDER) {
    if (bundleId !== "utility" && normalizedStages.includes(bundleId)) {
      return bundleId;
    }
  }
  return "utility";
}

/* ── Component ───────────────────────────────────── */

export function SkillArsenalModal({
  open,
  skills,
  onClose,
  onToggleSkill,
  onSkillAction,
  onSkillsChanged,
}: SkillArsenalModalProps) {
  const [view, setView] = useState<ModalView>({ kind: "grid" });
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [gitUrl, setGitUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Reset view when opening
  useEffect(() => {
    if (open) {
      setView({ kind: "grid" });
      setSearch("");
      setClosing(false);
    }
  }, [open]);

  // Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (view.kind === "detail") {
          setView({ kind: "folder", bundleId: resolvedDetailBundleId() });
        } else if (view.kind === "folder") {
          setView({ kind: "grid" });
        } else {
          handleClose();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  // Map manifests to AcademicSkill
  const mappedSkills: AcademicSkill[] = useMemo(
    () =>
      skills.map((manifest) => {
        const enabled = manifest.isEnabled ?? manifest.enabled ?? false;
        const builtin = BUILTIN_SKILLS.find((c) => c.id === manifest.id);
        if (builtin) {
          return {
            ...builtin,
            description:
              manifest.summary || manifest.description || builtin.description,
            enabled,
          };
        }
        return {
          id: manifest.id,
          name: manifest.name ?? manifest.id,
          description: manifest.summary || manifest.description || "",
          weaponType: "blade" as const,
          themeColors: {
            primary: "#7c6f9f",
            secondary: "#3a3550",
            accent: "#c9b8ff",
          },
          actionLabel: "Use",
          enabled,
          isCustom: true,
        };
      }),
    [skills],
  );

  const manifestById = useMemo(
    () => new Map(skills.map((m) => [m.id, m])),
    [skills],
  );
  const skillById = useMemo(
    () => new Map(mappedSkills.map((s) => [s.id, s])),
    [mappedSkills],
  );

  // Group skills by bundle
  const groupedSkills = useMemo(() => {
    const groups = new Map<ResearchBundleId, AcademicSkill[]>();
    mappedSkills.forEach((skill) => {
      const manifest = manifestById.get(skill.id);
      const bundleId = manifest ? resolveResearchBundleId(manifest) : "utility";
      const current = groups.get(bundleId) ?? [];
      current.push(skill);
      groups.set(bundleId, current);
    });
    return RESEARCH_BUNDLE_ORDER.map((bundleId) => ({
      id: bundleId,
      ...RESEARCH_BUNDLE_META[bundleId],
      skills: (groups.get(bundleId) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name, "zh-CN"),
      ),
    })).filter((g) => g.skills.length > 0);
  }, [manifestById, mappedSkills]);

  // Filter skills by search
  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groupedSkills;
    return groupedSkills
      .map((g) => ({
        ...g,
        skills: g.skills.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.id.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.skills.length > 0);
  }, [groupedSkills, search]);

  const resolvedDetailBundleId = useCallback((): ResearchBundleId => {
    if (view.kind !== "detail") return "utility";
    const manifest = manifestById.get(view.skillId);
    return manifest ? resolveResearchBundleId(manifest) : "utility";
  }, [view, manifestById]);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => {
      onClose();
      setClosing(false);
    }, 220);
  }, [onClose]);

  const handleToggle = async (skill: AcademicSkill) => {
    const manifest = skills.find((m) => m.id === skill.id);
    if (!manifest || pending === skill.id) return;
    setPending(skill.id);
    try {
      await onToggleSkill(manifest);
    } finally {
      setPending(null);
    }
  };

  const handleAction = (skill: AcademicSkill) => {
    onSkillAction?.(skill);
  };

  const handleImport = async () => {
    const url = gitUrl.trim();
    if (!url || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      await desktop.importSkillFromGit(url);
      setGitUrl("");
      onSkillsChanged?.();
    } catch (error: unknown) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  };

  const handleRemove = async (skillId: string) => {
    if (pending === skillId) return;
    setPending(skillId);
    try {
      await desktop.removeSkill(skillId);
      onSkillsChanged?.();
      // Go back if we're in the detail view for the removed skill
      if (view.kind === "detail" && view.skillId === skillId) {
        setView({ kind: "grid" });
      }
    } catch {
      // ignore
    } finally {
      setPending(null);
    }
  };

  if (!open && !closing) return null;

  const currentGroup =
    view.kind === "folder"
      ? filteredGroups.find((g) => g.id === view.bundleId) ?? null
      : null;
  const currentSkill =
    view.kind === "detail" ? skillById.get(view.skillId) ?? null : null;
  const currentManifest =
    view.kind === "detail" ? manifestById.get(view.skillId) ?? null : null;

  return (
    <div
      className={`skill-modal-overlay ${closing ? "skill-modal-overlay--exit" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        ref={panelRef}
        className={`skill-modal-panel ${closing ? "skill-modal-panel--exit" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Top bar ── */}
        <div className="skill-modal-topbar">
          {view.kind !== "grid" && (
            <button
              className="skill-modal-back"
              onClick={() => {
                if (view.kind === "detail") {
                  setView({
                    kind: "folder",
                    bundleId: resolvedDetailBundleId(),
                  });
                } else {
                  setView({ kind: "grid" });
                }
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                width="18"
                height="18"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}
          <h2 className="skill-modal-title">
            {view.kind === "grid"
              ? "应用与技能"
              : view.kind === "folder" && currentGroup
                ? currentGroup.title
                : currentSkill?.name ?? "Skill"}
          </h2>
          <button className="skill-modal-close" onClick={handleClose}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              width="20"
              height="20"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* ── Search bar (grid & folder view) ── */}
        {view.kind !== "detail" && (
          <div className="skill-modal-search-row">
            <div className="skill-modal-search-wrapper">
              <svg
                className="skill-modal-search-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                width="16"
                height="16"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                className="skill-modal-search"
                type="text"
                placeholder="搜索技能…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        )}

        {/* ── Import bar (grid view only) ── */}
        {view.kind === "grid" && (
          <div className="skill-modal-import-row">
            <input
              className="skill-modal-import-input"
              type="text"
              placeholder="输入 Git 仓库地址导入 Skill…"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleImport()}
              disabled={importing}
            />
            <button
              className="skill-modal-import-btn"
              onClick={handleImport}
              disabled={importing || !gitUrl.trim()}
            >
              {importing ? "导入中…" : "导入"}
            </button>
            {importError ? (
              <div className="skill-modal-import-error">{importError}</div>
            ) : null}
          </div>
        )}

        {/* ── Content area ── */}
        <div className="skill-modal-body">
          {/* ─ Grid view: folders ─ */}
          {view.kind === "grid" && (
            <div className="skill-modal-grid">
              {filteredGroups.map((group, gi) => (
                <button
                  key={group.id}
                  className="skill-modal-folder"
                  style={
                    {
                      animationDelay: `${gi * 50}ms`,
                      "--folder-gradient": group.gradient,
                    } as React.CSSProperties
                  }
                  onClick={() =>
                    setView({ kind: "folder", bundleId: group.id })
                  }
                >
                  <div className="skill-modal-folder__preview">
                    {group.skills.slice(0, 4).map((skill) => {
                      const svg = weaponSvg(
                        skill.weaponType,
                        28,
                        skill.themeColors.primary,
                        skill.themeColors.accent,
                      );
                      return (
                        <div
                          key={skill.id}
                          className="skill-modal-folder__icon"
                          dangerouslySetInnerHTML={{ __html: svg }}
                        />
                      );
                    })}
                  </div>
                  <div className="skill-modal-folder__info">
                    <span className="skill-modal-folder__name">
                      {group.title}
                    </span>
                    <span className="skill-modal-folder__count">
                      {group.skills.length}
                    </span>
                  </div>
                </button>
              ))}
              {filteredGroups.length === 0 && skills.length > 0 && (
                <div className="skill-modal-empty">没有匹配的技能</div>
              )}
              {skills.length === 0 && (
                <div className="skill-modal-empty">
                  还没有安装任何 Skill，通过上方输入框从 Git 仓库导入。
                </div>
              )}
            </div>
          )}

          {/* ─ Folder view: skill list ─ */}
          {view.kind === "folder" && currentGroup && (
            <div className="skill-modal-list skill-modal-list--enter">
              {currentGroup.skills.map((skill, si) => {
                const manifest = manifestById.get(skill.id);
                const active =
                  manifest?.isEnabled ?? manifest?.enabled ?? false;
                const svg = weaponSvg(
                  skill.weaponType,
                  40,
                  skill.themeColors.primary,
                  skill.themeColors.accent,
                );
                return (
                  <button
                    key={skill.id}
                    className={`skill-modal-app ${active ? "skill-modal-app--active" : ""}`}
                    style={{ animationDelay: `${si * 40}ms` }}
                    onClick={() =>
                      setView({ kind: "detail", skillId: skill.id })
                    }
                  >
                    <div
                      className="skill-modal-app__icon"
                      dangerouslySetInnerHTML={{ __html: svg }}
                    />
                    <div className="skill-modal-app__meta">
                      <span className="skill-modal-app__name">
                        {skill.name}
                      </span>
                      <span className="skill-modal-app__desc">
                        {skill.description}
                      </span>
                    </div>
                    <div className="skill-modal-app__status">
                      {active ? (
                        <span className="skill-modal-dot skill-modal-dot--on" />
                      ) : (
                        <span className="skill-modal-dot skill-modal-dot--off" />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {view.kind === "folder" && !currentGroup && (
            <div className="skill-modal-empty">该分组为空</div>
          )}

          {/* ─ Detail view ─ */}
          {view.kind === "detail" && currentSkill && currentManifest && (
            <div className="skill-modal-detail skill-modal-detail--enter">
              <div className="skill-modal-detail__hero">
                <div
                  className="skill-modal-detail__icon"
                  dangerouslySetInnerHTML={{
                    __html: weaponSvg(
                      currentSkill.weaponType,
                      64,
                      currentSkill.themeColors.primary,
                      currentSkill.themeColors.accent,
                    ),
                  }}
                />
                <div className="skill-modal-detail__hero-info">
                  <h3>{currentSkill.name}</h3>
                  <span className="skill-modal-detail__id">
                    {currentManifest.id}
                  </span>
                  {currentManifest.version && (
                    <span className="skill-modal-detail__version">
                      v{currentManifest.version}
                    </span>
                  )}
                </div>
              </div>

              <p className="skill-modal-detail__desc">
                {currentSkill.description || "暂无描述。"}
              </p>

              {/* Tags */}
              <div className="skill-modal-detail__tags">
                {currentManifest.stages?.map((s) => (
                  <span key={s} className="skill-modal-detail__tag">
                    {s}
                  </span>
                ))}
                {currentManifest.domains?.map((d) => (
                  <span
                    key={d}
                    className="skill-modal-detail__tag skill-modal-detail__tag--soft"
                  >
                    {d}
                  </span>
                ))}
                {currentManifest.resourceFlags?.hasScripts && (
                  <span className="skill-modal-detail__tag skill-modal-detail__tag--soft">
                    scripts
                  </span>
                )}
                {currentManifest.resourceFlags?.hasTemplates && (
                  <span className="skill-modal-detail__tag skill-modal-detail__tag--soft">
                    templates
                  </span>
                )}
                {currentManifest.status && (
                  <span className="skill-modal-detail__tag skill-modal-detail__tag--soft">
                    {currentManifest.status}
                  </span>
                )}
              </div>

              {/* Capabilities */}
              {currentManifest.capabilities &&
                currentManifest.capabilities.length > 0 && (
                  <div className="skill-modal-detail__section">
                    <h4>能力</h4>
                    <ul className="skill-modal-detail__list">
                      {currentManifest.capabilities.map((cap, i) => (
                        <li key={i}>{cap}</li>
                      ))}
                    </ul>
                  </div>
                )}

              {/* Actions */}
              <div className="skill-modal-detail__actions">
                <button
                  className="skill-modal-detail__btn skill-modal-detail__btn--primary"
                  onClick={() => handleAction(currentSkill)}
                >
                  {currentSkill.actionLabel || "Use"}
                </button>
                <button
                  className={`skill-modal-detail__btn ${
                    currentSkill.enabled
                      ? "skill-modal-detail__btn--active"
                      : "skill-modal-detail__btn--secondary"
                  }`}
                  onClick={() => handleToggle(currentSkill)}
                  disabled={pending === currentSkill.id}
                >
                  {currentSkill.enabled ? "已启用" : "启用"}
                </button>
                {currentSkill.isCustom && (
                  <button
                    className="skill-modal-detail__btn skill-modal-detail__btn--danger"
                    onClick={() => handleRemove(currentSkill.id)}
                    disabled={pending === currentSkill.id}
                  >
                    删除
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
