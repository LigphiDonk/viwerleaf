import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  flattenTasksForTree,
  defaultResearchSelection,
  selectionToEntity,
} from "../lib/researchCanvasGraph";

import { localizeResearchSnapshot } from "../lib/researchLocale";
import type {
  AppLocale,
  ResearchCanvasSnapshot,
  ResearchStageSummary,
  ResearchStage,
  ResearchTaskDraft,
  ResearchTask,
} from "../types";

interface ResearchCanvasProps {
  locale: AppLocale;
  research: ResearchCanvasSnapshot | null | undefined;
  activeTaskId?: string | null;
  requestedSelectionId?: string | null;
  requestedSelectionNonce?: number;
  isBusy?: boolean;
  onBootstrap: () => Promise<void> | void;
  onInitializeStage: (stage: ResearchStage) => Promise<void> | void;
  onOpenArtifact: (path: string) => void;
  onUseTaskInChat: (task: ResearchTask) => Promise<void> | void;
  onEnterTask: (task: ResearchTask) => Promise<void> | void;
  onAddTask: (draft: ResearchTaskDraft) => Promise<void> | void;
  onOpenLiteratureForTask: (taskId: string) => void;
  onOpenWriting: () => void;
  autoExperiment: ReturnType<typeof import("../hooks/useAutoExperiment").useAutoExperiment>;
}

/* ─── Helpers ─── */

const STATUS_ALIASES: Record<string, string> = {
  done: "done", completed: "done", complete: "done", finished: "done",
  "in-progress": "in-progress", running: "in-progress", active: "in-progress", started: "in-progress",
  pending: "pending", todo: "pending", "not-started": "pending", queued: "pending", waiting: "pending",
  review: "review", "in-review": "review",
  deferred: "deferred", blocked: "deferred", "on-hold": "deferred",
  cancelled: "cancelled", canceled: "cancelled", removed: "cancelled", skipped: "cancelled",
};

function normalizeTaskStatus(raw: string): string {
  return STATUS_ALIASES[raw.trim().toLowerCase().replace(/_/g, "-")] ?? raw.trim();
}

function cleanTaskDescription(raw: string): string {
  // Remove technical tool output markers
  return raw
    .replace(/\[Result\][\s\S]*?\[\/Result\]/g, '')
    .replace(/\[Tool:\s*\w+\]/g, '')
    .replace(/\[ToolUseId:\s*[\w_]+\]/g, '')
    .replace(/\[Args\][\s\S]*?\[\/Args\]/g, '')
    .replace(/\[Status:\s*\w+\]/g, '')
    .trim();
}

function formatTaskStatus(task: ResearchTask, isZh: boolean) {
  const status = normalizeTaskStatus(task.status);
  if (!isZh) {
    return status;
  }
  return ({
    pending: "待开始",
    "in-progress": "进行中",
    done: "已完成",
    review: "待检查",
    deferred: "已延后",
    cancelled: "已取消",
  }[status] ?? status);
}

function formatPriority(task: ResearchTask, isZh: boolean) {
  if (!isZh) {
    return task.priority;
  }
  return ({
    high: "高优先级",
    medium: "中优先级",
    low: "低优先级",
  }[task.priority] ?? task.priority);
}

interface ResearchTaskExecutionState {
  executableTaskIds: Set<string>;
  blockedTaskIds: Set<string>;
}

function resolveResearchTaskExecutionState(research: ResearchCanvasSnapshot): ResearchTaskExecutionState {
  const doneIds = new Set(
    research.tasks
      .filter((task) => normalizeTaskStatus(task.status) === "done")
      .map((task) => task.id),
  );
  const executableTaskIds = new Set(
    research.tasks
      .filter((task) => task.stage === research.currentStage)
      .filter((task) => ["in-progress", "review"].includes(normalizeTaskStatus(task.status)))
      .map((task) => task.id),
  );

  if (executableTaskIds.size === 0) {
    research.tasks
      .filter((task) => task.stage === research.currentStage)
      .filter((task) => ["pending", "review", ""].includes(normalizeTaskStatus(task.status)))
      .filter((task) => task.dependencies.every((dependencyId) => doneIds.has(dependencyId)))
      .forEach((task) => executableTaskIds.add(task.id));
  }

  const blockedTaskIds = new Set(
    research.tasks
      .filter((task) => normalizeTaskStatus(task.status) !== "done" && !executableTaskIds.has(task.id))
      .filter((task) => task.dependencies.some((dependencyId) => !doneIds.has(dependencyId)))
      .map((task) => task.id),
  );

  return { executableTaskIds, blockedTaskIds };
}

function splitComposerList(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

interface TaskComposerState {
  stage: ResearchStage;
  title: string;
  description: string;
  priority: string;
  taskType: string;
  dependencies: string[];
  inputsNeeded: string;
  suggestedSkills: string;
  nextActionPrompt: string;
}

function createTaskComposerState(stage: ResearchStage, dependencies: string[] = [], suggestedSkills: string[] = []): TaskComposerState {
  return {
    stage,
    title: "",
    description: "",
    priority: "medium",
    taskType: "custom",
    dependencies,
    inputsNeeded: "",
    suggestedSkills: suggestedSkills.join(", "),
    nextActionPrompt: "",
  };
}

/* ─── Onboarding (kept) ─── */

function ResearchOnboarding({
  locale,
  research,
  isBusy,
  onBootstrap,
}: {
  locale: AppLocale;
  research: ResearchCanvasSnapshot | null | undefined;
  isBusy?: boolean;
  onBootstrap: () => Promise<void> | void;
}) {
  const isZh = locale === "zh-CN";
  const status = research?.bootstrap.status ?? "needs-bootstrap";
  const requiresManualBriefFix = status === "invalid-brief";
  const needsRepair =
    status === "missing-brief"
    || status === "missing-tasks"
    || status === "partial"
    || requiresManualBriefFix;
  const title =
    needsRepair
      ? (isZh ? "修复研究画布脚手架" : "Repair the research canvas scaffold")
      : (isZh ? "启用研究画布" : "Enable the research canvas");
  const buttonLabel =
    needsRepair
      ? (isZh ? "修复工作流" : "Repair workflow")
      : (isZh ? "初始化工作流" : "Initialize workflow");

  return (
    <div className="research-onboarding">
      <div className="research-onboarding__card">
        <div className="research-onboarding__eyebrow">{isZh ? "研究画布" : "Research Canvas"}</div>
        <h2>{title}</h2>
        <p>{research?.bootstrap.message || (isZh ? "为当前项目初始化研究工作流。" : "Initialize the research workflow for this project.")}</p>
        <div className="research-onboarding__checklist">
          <span>{isZh ? "项目提示词：`AGENTS.md`、`CLAUDE.md`" : "Project prompts: `AGENTS.md`, `CLAUDE.md`"}</span>
          <span>{isZh ? "工作流状态：`instance.json`、`.pipeline/*`" : "Workflow state: `instance.json`, `.pipeline/*`"}</span>
          <span>{isZh ? "隐藏研究工作区：`.viewerleaf/research/*`" : "Hidden research workspace: `.viewerleaf/research/*`"}</span>
          <span>{isZh ? "项目技能与 agent skill 视图" : "Project skills and agent skill views"}</span>
        </div>
        {requiresManualBriefFix ? (
          <div style={{ marginTop: 16, color: "var(--color-red)" }}>
            {isZh
              ? "请手动修复 `.pipeline/docs/research_brief.json` 的 JSON 格式，然后重新打开研究画布。"
              : "Fix the JSON syntax in `.pipeline/docs/research_brief.json` manually, then reopen the research canvas."}
          </div>
        ) : (
          <button
            type="button"
            className="research-primary-btn"
            onClick={() => void onBootstrap()}
            disabled={isBusy}
          >
            {isBusy ? (isZh ? "处理中..." : "Working...") : buttonLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── TaskInspector (kept, with button fix) ─── */

function TaskInspector({
  locale,
  task,
  canUseTask,
  onOpenArtifact,
  onUseTaskInChat,
  onOpenWriting,
}: {
  locale: AppLocale;
  task: ResearchTask;
  canUseTask: boolean;
  onOpenArtifact: (path: string) => void;
  onUseTaskInChat: (task: ResearchTask) => Promise<void> | void;
  onOpenWriting: () => void;
}) {
  const isZh = locale === "zh-CN";

  /* Resolve button state based on actual task status */
  const normalized = normalizeTaskStatus(task.status);
  const isDone = normalized === "done";
  const isInProgress = normalized === "in-progress";
  const isReview = normalized === "review";
  const isCancelled = normalized === "cancelled";
  const isDeferred = normalized === "deferred";
  const isClosed = isDone || isCancelled || isDeferred;

  let buttonLabel: string;
  let buttonDisabled: boolean;

  if (isDone) {
    buttonLabel = isZh ? "✓ 已完成" : "✓ Completed";
    buttonDisabled = true;
  } else if (isCancelled) {
    buttonLabel = isZh ? "已取消" : "Cancelled";
    buttonDisabled = true;
  } else if (isDeferred) {
    buttonLabel = isZh ? "已延后" : "Deferred";
    buttonDisabled = true;
  } else if (isInProgress) {
    buttonLabel = isZh ? "进行中..." : "In Progress...";
    buttonDisabled = true;
  } else if (isReview) {
    buttonLabel = isZh ? "待检查" : "In Review";
    buttonDisabled = false;
  } else if (canUseTask) {
    buttonLabel = isZh ? "发送到聊天" : "Use in Chat";
    buttonDisabled = false;
  } else {
    buttonLabel = isZh ? "等待前置任务" : "Waiting on dependencies";
    buttonDisabled = true;
  }

  return (
    <div className="research-inspector__section">
      <div className="research-inspector__eyebrow">{task.stage}</div>
      <h3>{task.title}</h3>
      <p>{cleanTaskDescription(task.description)}</p>
      <div className="research-inspector__meta">
        <span>{isZh ? "状态" : "Status"}: {formatTaskStatus(task, isZh)}</span>
        <span>{isZh ? "优先级" : "Priority"}: {formatPriority(task, isZh)}</span>
      </div>
      {task.inputsNeeded.length > 0 ? (
        <>
          <div className="research-inspector__label">{isZh ? "缺失输入" : "Missing inputs"}</div>
          <div className="research-inspector__list">
            {task.inputsNeeded.map((item) => <span key={item}>{item}</span>)}
          </div>
        </>
      ) : null}
      {task.suggestedSkills.length > 0 ? (
        <>
          <div className="research-inspector__label">{isZh ? "推荐技能" : "Suggested skills"}</div>
          <div className="research-inspector__list">
            {task.suggestedSkills.map((item) => <span key={item}>{item}</span>)}
          </div>
        </>
      ) : null}
      <div className="research-inspector__actions">
        <button
          type="button"
          className={`research-primary-btn${isDone ? " is-done" : ""}`}
          onClick={() => void onUseTaskInChat(task)}
          disabled={buttonDisabled}
        >
          {buttonLabel}
        </button>
        {task.stage === "publication" && !isClosed ? (
          <button type="button" className="research-secondary-btn" onClick={onOpenWriting}>
            {isZh ? "进入写作台" : "Enter Writing Desk"}
          </button>
        ) : null}
      </div>
      {task.artifactPaths.length > 0 ? (
        <>
          <div className="research-inspector__label">{isZh ? "产物" : "Artifacts"}</div>
          <div className="research-artifact-list">
            {task.artifactPaths.map((path) => (
              <button key={path} type="button" onClick={() => onOpenArtifact(path)} title={path}>
                <span className="research-artifact-name">{path.split("/").pop() || path}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
      <div className="research-inspector__prompt">{task.nextActionPrompt}</div>
    </div>
  );
}

/* ─── StageInspector (kept) ─── */

function StageInspector({
  locale,
  stage,
  onAddTask,
  onInitializeStage,
  onOpenArtifact,
  onOpenWriting,
}: {
  locale: AppLocale;
  stage: ResearchStageSummary;
  onAddTask: (stage: ResearchStage) => void;
  onInitializeStage: (stage: ResearchStage) => Promise<void> | void;
  onOpenArtifact: (path: string) => void;
  onOpenWriting: () => void;
}) {
  const isZh = locale === "zh-CN";
  const completion = stage.totalTasks > 0 ? Math.round((stage.doneTasks / stage.totalTasks) * 100) : 0;
  return (
    <div className="research-inspector__section">
      <div className="research-inspector__eyebrow">{stage.label}</div>
      <h3>{stage.description}</h3>
      <div className="research-inspector__meta">
        <span>{isZh ? "状态" : "Status"}: {stage.status}</span>
        <span>{isZh ? "完成度" : "Completion"}: {completion}%</span>
        <span>{isZh ? "任务" : "Tasks"}: {stage.doneTasks}/{stage.totalTasks || 0}</span>
      </div>
      {stage.missingInputs.length > 0 ? (
        <>
          <div className="research-inspector__label">{isZh ? "待补输入" : "Open questions"}</div>
          <div className="research-inspector__list">
            {stage.missingInputs.map((item) => <span key={item}>{item}</span>)}
          </div>
        </>
      ) : null}
      {stage.suggestedSkills.length > 0 ? (
        <>
          <div className="research-inspector__label">
            {stage.bundleLabel || (isZh ? "推荐技能" : "Suggested skills")}
          </div>
          {stage.bundleDescription ? <p>{stage.bundleDescription}</p> : null}
          <div className="research-inspector__list">
            {stage.suggestedSkills.map((item) => <span key={item}>{item}</span>)}
          </div>
        </>
      ) : null}
      {stage.canInitialize ? (
        <div className="research-inspector__actions">
          <button
            type="button"
            className="research-primary-btn"
            onClick={() => void onInitializeStage(stage.stage)}
          >
            {isZh ? "开始本阶段" : "Start Stage"}
          </button>
          <button
            type="button"
            className="research-secondary-btn"
            onClick={() => onAddTask(stage.stage)}
          >
            {isZh ? "添加任务" : "Add Task"}
          </button>
        </div>
      ) : (
        <div className="research-inspector__actions">
          <button
            type="button"
            className="research-secondary-btn"
            onClick={() => onAddTask(stage.stage)}
          >
            {isZh ? "添加任务" : "Add Task"}
          </button>
        </div>
      )}
      {stage.stage === "publication" ? (
        <div className="research-inspector__actions">
          <button type="button" className="research-primary-btn" onClick={onOpenWriting}>
            {isZh ? "进入写作台" : "Enter Writing Desk"}
          </button>
        </div>
      ) : null}
      {stage.artifactPaths.length > 0 ? (
        <>
          <div className="research-inspector__label">{isZh ? "产物" : "Artifacts"}</div>
          <div className="research-artifact-list">
            {stage.artifactPaths.map((path) => (
              <button key={path} type="button" onClick={() => onOpenArtifact(path)} title={path}>
                <span className="research-artifact-name">{path.split("/").pop() || path}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ─── TaskComposer dialog (kept) ─── */

function TaskComposerDialog({
  locale,
  draft,
  dependencyOptions,
  onChange,
  onClose,
  onSubmit,
}: {
  locale: AppLocale;
  draft: TaskComposerState;
  dependencyOptions: ResearchTask[];
  onChange: (next: TaskComposerState) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const isZh = locale === "zh-CN";
  return (
    <div className="research-task-composer">
      <div className="research-task-composer__backdrop" onClick={onClose} />
      <div className="research-task-composer__panel">
        <div className="research-task-composer__head">
          <div>
            <div className="research-inspector__eyebrow">{isZh ? "手动添加任务" : "Add Task"}</div>
            <h3>{isZh ? "向当前阶段插入一个新任务" : "Insert a task into this stage"}</h3>
          </div>
          <button type="button" className="task-tree__stage-toggle" onClick={onClose}>×</button>
        </div>
        <label className="research-task-composer__field">
          <span>{isZh ? "标题" : "Title"}</span>
          <input value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} />
        </label>
        <label className="research-task-composer__field">
          <span>{isZh ? "描述" : "Description"}</span>
          <textarea value={draft.description} onChange={(event) => onChange({ ...draft, description: event.target.value })} rows={4} />
        </label>
        <div className="research-task-composer__row">
          <label className="research-task-composer__field">
            <span>{isZh ? "优先级" : "Priority"}</span>
            <select value={draft.priority} onChange={(event) => onChange({ ...draft, priority: event.target.value })}>
              <option value="high">{isZh ? "高" : "High"}</option>
              <option value="medium">{isZh ? "中" : "Medium"}</option>
              <option value="low">{isZh ? "低" : "Low"}</option>
            </select>
          </label>
          <label className="research-task-composer__field">
            <span>{isZh ? "类型" : "Type"}</span>
            <input value={draft.taskType} onChange={(event) => onChange({ ...draft, taskType: event.target.value })} />
          </label>
        </div>
        <label className="research-task-composer__field">
          <span>{isZh ? "下一步提示" : "Next Action Prompt"}</span>
          <textarea value={draft.nextActionPrompt} onChange={(event) => onChange({ ...draft, nextActionPrompt: event.target.value })} rows={3} />
        </label>
        <label className="research-task-composer__field">
          <span>{isZh ? "输入项（逗号或换行分隔）" : "Inputs (comma or newline separated)"}</span>
          <textarea value={draft.inputsNeeded} onChange={(event) => onChange({ ...draft, inputsNeeded: event.target.value })} rows={3} />
        </label>
        <label className="research-task-composer__field">
          <span>{isZh ? "技能（逗号或换行分隔）" : "Skills (comma or newline separated)"}</span>
          <textarea value={draft.suggestedSkills} onChange={(event) => onChange({ ...draft, suggestedSkills: event.target.value })} rows={2} />
        </label>
        {dependencyOptions.length > 0 ? (
          <div className="research-task-composer__field">
            <span>{isZh ? "依赖任务" : "Dependencies"}</span>
            <div className="research-task-composer__deps">
              {dependencyOptions.map((task) => {
                const checked = draft.dependencies.includes(task.id);
                return (
                  <label key={task.id} className="research-task-composer__dep">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => onChange({
                        ...draft,
                        dependencies: event.target.checked
                          ? [...draft.dependencies, task.id]
                          : draft.dependencies.filter((item) => item !== task.id),
                      })}
                    />
                    <span>{task.title}</span>
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}
        <div className="research-task-composer__actions">
          <button type="button" className="research-secondary-btn" onClick={onClose}>{isZh ? "取消" : "Cancel"}</button>
          <button type="button" className="research-primary-btn" onClick={onSubmit} disabled={!draft.title.trim()}>
            {isZh ? "创建任务" : "Create Task"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── AutoExperimentCard (NEW) ─── */

function AutoExperimentCard({ 
  locale, 
  config, 
  autoExperiment 
}: { 
  locale: AppLocale; 
  config: import("../types").ExperimentLoopConfig;
  autoExperiment: ReturnType<typeof import("../hooks/useAutoExperiment").useAutoExperiment>;
}) {
  const isZh = locale === "zh-CN";
  const { runState, startExperiment, pauseExperiment, resumeExperiment, stopExperiment } = autoExperiment;
  const isEnabled = config.enabled;

  const isRunning = runState?.status === "running";
  const isPaused = runState?.status === "paused";

  return (
    <div className="research-inspector__section" style={{ marginTop: 24, padding: 16, border: "1px solid var(--border-color)", borderRadius: 8, background: "var(--bg-secondary)" }}>
      <div className="research-inspector__eyebrow" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>{isZh ? "自动实验编排器" : "Auto Experiment Orchestrator"}</span>
        {runState?.status && (
           <span className={`task-tree__dot ${isRunning ? "is-active is-current" : isPaused ? "is-pending" : "is-done"}`} style={{ display: "inline-block" }} />
        )}
      </div>
      <h3 style={{ marginTop: 8 }}>{isZh ? "远程实验循环" : "Remote Experiment Loop"}</h3>
      
      <div className="research-inspector__meta" style={{ flexWrap: "wrap", gap: "8px 16px", marginBottom: 16 }}>
        <span>{isZh ? "目标指标" : "Metric"}: {config.successMetric} ({config.successDirection === "max" ? ">" : "<"} {config.successThreshold})</span>
        <span>{isZh ? "预算限制" : "Budget"}: {config.maxIterations} {isZh ? "轮" : "Rounds"} / {config.maxDurationMinutes} {isZh ? "分钟" : "Mins"}</span>
        <span>{isZh ? "活动节点" : "Node"}: {config.remoteNode}</span>
      </div>

      <div style={{ padding: "12px", background: "var(--bg-primary)", borderRadius: 6, fontSize: 13, color: "var(--text-secondary)", marginBottom: 16, border: "1px solid var(--border-color)" }}>
        <div style={{ marginBottom: 4 }}><strong>{isZh ? "评估命令" : "Eval Command"}:</strong> <code>{config.evalCommand}</code></div>
        {!isEnabled ? (
          <div style={{ marginTop: 12, borderTop: "1px solid var(--border-color)", paddingTop: 8 }}>
            {isZh
              ? "自动实验配置已存在，但当前处于关闭状态。请在 research_brief.json 中将 experimentLoop.enabled 设为 true，并补全评估命令后再启动。"
              : "Auto experiment is configured but currently disabled. Set experimentLoop.enabled to true in research_brief.json and fill in a valid eval command before starting."}
          </div>
        ) : runState ? (
          <div style={{ marginTop: 12, borderTop: "1px solid var(--border-color)", paddingTop: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span><strong>{isZh ? "当前轮次" : "Current Iteration"}:</strong> {runState.iterations} / {config.maxIterations}</span>
              <span><strong>{isZh ? "状态" : "Status"}:</strong> {runState.status}</span>
            </div>
            {runState.bestMetricValue !== undefined && runState.bestMetricValue !== null && (
               <div style={{ marginBottom: 4 }}><strong>{isZh ? "当前最佳结果" : "Best Result"}:</strong> {runState.bestMetricValue}</div>
            )}
            {runState.currentFailures > 0 && (
               <div style={{ color: "var(--color-orange)" }}><strong>{isZh ? "累计失败" : "Failures"}:</strong> {runState.currentFailures}</div>
            )}
            {runState.status === "failed" && (
               <div style={{ color: "var(--color-red)" }}><strong>{isZh ? "停止原因" : "Stop Reason"}:</strong> Reached max failures</div>
            )}
          </div>
        ) : (
          <div style={{ marginTop: 12, borderTop: "1px solid var(--border-color)", paddingTop: 8, fontStyle: "italic" }}>
            {isZh ? "尚未开始实验循环" : "Experiment loop hasn't started yet"}
          </div>
        )}
      </div>

      <div className="research-inspector__actions" style={{ marginTop: 0 }}>
        {!isEnabled ? (
          <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
            {isZh
              ? "当前项目已具备自动实验模板，但默认关闭。"
              : "This project includes the auto experiment template, but it is disabled by default."}
          </span>
        ) : !runState || ["completed", "failed", "stopped", "interrupted"].includes(runState.status) ? (
          <button type="button" className="research-primary-btn" onClick={() => void startExperiment(config)}>
            {runState?.status === "interrupted"
              ? (isZh ? "重新启动实验" : "Restart Experiment")
              : (isZh ? "开始自动实验" : "Start Auto Experiment")}
          </button>
        ) : isRunning ? (
          <>
            <button type="button" className="research-secondary-btn" onClick={() => void pauseExperiment()} title={isZh ? "当前轮次结束后暂停" : "Pause after current round"}>
              {isZh ? "本轮后暂停" : "Pause After Round"}
            </button>
            <button type="button" className="research-secondary-btn" onClick={() => void stopExperiment()} style={{ color: "var(--color-red)", borderColor: "var(--color-red)" }}>
              {isZh ? "停止" : "Stop"}
            </button>
          </>
        ) : isPaused ? (
          <>
            <button type="button" className="research-primary-btn" onClick={() => void resumeExperiment()}>
              {isZh ? "恢复运行" : "Resume"}
            </button>
            <button type="button" className="research-secondary-btn" onClick={() => void stopExperiment()} style={{ color: "var(--color-red)", borderColor: "var(--color-red)" }}>
              {isZh ? "停止" : "Stop"}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ─── Git Task Tree View (NEW) ─── */

function TaskTreeNodeDot({ status, isActive }: { status: string; isActive: boolean }) {
  const normalized = normalizeTaskStatus(status);
  const colorClass =
    normalized === "done"
      ? "is-done"
      : normalized === "in-progress" || normalized === "review"
        ? "is-active"
        : normalized === "cancelled" || normalized === "deferred"
          ? "is-dimmed"
          : "is-pending";
  return (
    <span className={`task-tree__dot ${colorClass}${isActive ? " is-current" : ""}`} />
  );
}

/* ─── Main Component ─── */

export function ResearchCanvas({
  locale,
  research,
  activeTaskId = null,
  requestedSelectionId = null,
  requestedSelectionNonce = 0,
  isBusy = false,
  onBootstrap,
  onInitializeStage,
  onOpenArtifact,
  onUseTaskInChat,
  onAddTask,
  onOpenWriting,
  autoExperiment,
}: ResearchCanvasProps) {
  const isZh = locale === "zh-CN";
  const localizedResearch = useMemo(
    () => (research ? localizeResearchSnapshot(research, locale) : research),
    [locale, research],
  );
  const needsBootstrap = !localizedResearch || localizedResearch.bootstrap.status !== "ready";
  const taskExecutionState = useMemo(
    () => (localizedResearch ? resolveResearchTaskExecutionState(localizedResearch) : { executableTaskIds: new Set<string>(), blockedTaskIds: new Set<string>() }),
    [localizedResearch],
  );

  const [selectionId, setSelectionId] = useState<string | null>(
    localizedResearch ? defaultResearchSelection(localizedResearch) : null,
  );
  const [collapsedStages, setCollapsedStages] = useState<Set<ResearchStage>>(new Set());
  const [taskComposer, setTaskComposer] = useState<TaskComposerState | null>(null);
  const [showExpLogs, setShowExpLogs] = useState(false);
  const expLogScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll experiment log panel to bottom on new entries
  useEffect(() => {
    if (showExpLogs && expLogScrollRef.current) {
      expLogScrollRef.current.scrollTop = expLogScrollRef.current.scrollHeight;
    }
  }, [showExpLogs, autoExperiment.experimentLogs.length]);

  const handleToggleCollapse = useCallback((stage: ResearchStage) => {
    setCollapsedStages((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) {
        next.delete(stage);
      } else {
        next.add(stage);
      }
      return next;
    });
  }, []);

  /* Sync external selection requests */
  useEffect(() => {
    if (!localizedResearch || requestedSelectionNonce === 0) {
      return;
    }
    const nextSelection = requestedSelectionId || defaultResearchSelection(localizedResearch);
    setSelectionId(nextSelection);
  }, [localizedResearch, requestedSelectionId, requestedSelectionNonce]);

  /* Keep selection stable when data updates */
  useEffect(() => {
    if (!localizedResearch) {
      setSelectionId(null);
      return;
    }
    setSelectionId((current) => {
      if (!current) {
        return defaultResearchSelection(localizedResearch);
      }
      // Verify the selection still exists
      const entity = selectionToEntity(localizedResearch, current);
      if (entity.task || entity.stage) {
        return current;
      }
      return defaultResearchSelection(localizedResearch);
    });
  }, [localizedResearch]);

  if (needsBootstrap) {
    return <ResearchOnboarding locale={locale} research={localizedResearch} isBusy={isBusy} onBootstrap={onBootstrap} />;
  }

  const stageGroups = flattenTasksForTree(localizedResearch);
  const resolved = selectionToEntity(localizedResearch, selectionId);

  const totalTasks = localizedResearch.tasks.length;
  const doneTasks = localizedResearch.tasks.filter((t) => normalizeTaskStatus(t.status) === "done").length;
  const completion = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  const taskComposerDependencyOptions = taskComposer
    ? localizedResearch.tasks.filter((task) =>
      (task.stage === taskComposer.stage || task.status === "done" || taskExecutionState.executableTaskIds.has(task.id)))
    : [];

  return (
    <div className="task-tree-shell">
      {/* Left: Tree */}
      <div className="task-tree__board">
        {/* Pipeline artifacts bar */}
        {localizedResearch.pipelineArtifacts && localizedResearch.pipelineArtifacts.length > 0 && (
          <div className="pipeline-artifacts-bar">
            <div className="pipeline-artifacts-bar__label">{isZh ? "📋 研究产物" : "📋 Pipeline Artifacts"}</div>
            <div className="pipeline-artifacts-bar__grid">
              {localizedResearch.pipelineArtifacts.map((artifact) => (
                <button
                  key={artifact.path}
                  type="button"
                  className="pipeline-artifact-card"
                  onClick={() => onOpenArtifact(artifact.path)}
                  title={artifact.path}
                >
                  <span className="pipeline-artifact-card__icon">
                    {artifact.fileType === "json" ? "📊" : artifact.fileType === "md" ? "📝" : "📄"}
                  </span>
                  <span className="pipeline-artifact-card__label">{artifact.label}</span>
                  <span className="pipeline-artifact-card__badge">{artifact.fileType}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Compact progress header */}
        <div className="task-tree__progress-header">
          <div className="task-tree__progress-info">
            <span className="task-tree__progress-label">{isZh ? "总体进度" : "Progress"}</span>
            <span className="task-tree__progress-pct">{completion}%</span>
            <span className="task-tree__progress-count">{doneTasks}/{totalTasks}</span>
          </div>
          <div className="task-tree__progress-bar">
            <div className="task-tree__progress-fill" style={{ width: `${completion}%` }} />
          </div>
        </div>

        {/* Git tree */}
        <div className="task-tree__scroll">
          <div className="task-tree__trunk">
            {stageGroups.map((group, groupIndex) => {
              const isCollapsed = collapsedStages.has(group.stage);
              const stageCompletion = group.summary.totalTasks > 0
                ? Math.round((group.summary.doneTasks / group.summary.totalTasks) * 100)
                : 0;
              const stageSelected = selectionId === `stage:${group.stage}`;
              const isCurrentStage = localizedResearch.currentStage === group.stage;

              return (
                <div key={group.stage} className="task-tree__stage-group">
                  {/* Stage divider */}
                  <div
                    className={`task-tree__stage-divider${stageSelected ? " is-selected" : ""}${isCurrentStage ? " is-current" : ""}`}
                    onClick={() => setSelectionId(`stage:${group.stage}`)}
                  >
                    <button
                      type="button"
                      className="task-tree__stage-toggle"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleCollapse(group.stage);
                      }}
                    >
                      <svg
                        width="14" height="14" viewBox="0 0 16 16" fill="none"
                        style={{ transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.2s ease" }}
                      >
                        <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    <span className="task-tree__stage-label">{group.summary.label}</span>
                    <span className="task-tree__stage-stats">
                      {group.summary.doneTasks}/{group.summary.totalTasks || 0}
                    </span>
                    {stageCompletion === 100 ? (
                      <span className="task-tree__stage-check">✓</span>
                    ) : null}
                    {group.summary.canInitialize ? (
                      <button
                        type="button"
                        className="task-tree__stage-init-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onInitializeStage(group.stage);
                        }}
                      >
                        {isZh ? "开始" : "Start"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="task-tree__stage-add-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        const dependencyDefaults = localizedResearch.tasks
                          .filter((t) => t.stage === group.stage && taskExecutionState.executableTaskIds.has(t.id))
                          .map((t) => t.id);
                        setTaskComposer(createTaskComposerState(group.stage, dependencyDefaults, group.summary.suggestedSkills ?? []));
                      }}
                    >
                      +
                    </button>
                  </div>

                  {/* Task nodes */}
                  {!isCollapsed && group.tasks.map((task, taskIndex) => {
                    const isActive = normalizeTaskStatus(task.status) !== "done"
                      && (task.id === activeTaskId || task.id === localizedResearch.nextTask?.id);
                    const isSelected = selectionId === `task:${task.id}`;
                    const isLast = taskIndex === group.tasks.length - 1 && groupIndex === stageGroups.length - 1;

                    return (
                      <div
                        key={task.id}
                        className={`task-tree__node${isSelected ? " is-selected" : ""}${isActive ? " is-active" : ""}`}
                        onClick={() => setSelectionId(`task:${task.id}`)}
                      >
                        <div className="task-tree__node-rail">
                          <TaskTreeNodeDot status={task.status} isActive={isActive} />
                          {!isLast ? <div className="task-tree__node-line" /> : null}
                        </div>
                        <div className="task-tree__node-content">
                          <span className="task-tree__node-title">
                            <span className="task-tree__node-seq">{task.id}.</span>
                            {task.title}
                          </span>
                          <span className="task-tree__node-status">{formatTaskStatus(task, isZh)}</span>
                          {isActive && <span className="task-tree__node-next-badge">{isZh ? "▶ 下一步" : "▶ Next"}</span>}
                        </div>
                      </div>
                    );
                  })}

                  {/* Trunk connector between stages */}
                  {groupIndex < stageGroups.length - 1 && !isCollapsed && group.tasks.length === 0 ? (
                    <div className="task-tree__stage-connector" />
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Experiment Quick-Start Bar (always visible when experimentLoop exists) ── */}
        {localizedResearch.experimentLoop && (
          <div className="experiment-quick-bar">
            <div className="experiment-quick-bar__info">
              <span className={`task-tree__dot ${
                autoExperiment.runState?.status === "running" ? "is-active is-current"
                : autoExperiment.runState?.status === "paused" ? "is-pending"
                : autoExperiment.runState?.status === "completed" ? "is-done"
                : ""
              }`} style={{ display: "inline-block" }} />
              <span className="experiment-quick-bar__label">🧪 {isZh ? "自动实验" : "Auto Experiment"}</span>
              {autoExperiment.runState && autoExperiment.runState.status !== "stopped" && (
                <span className="experiment-quick-bar__metric">
                  {autoExperiment.runState.iterations}/{localizedResearch.experimentLoop.maxIterations}
                  {autoExperiment.runState.bestMetricValue != null && (
                    <> · {localizedResearch.experimentLoop.successMetric}: {autoExperiment.runState.bestMetricValue}</>
                  )}
                </span>
              )}
            </div>
            <div className="experiment-quick-bar__actions">
              {autoExperiment.runState?.status === "running" ? (
                <>
                  <button type="button" className="experiment-quick-bar__btn" onClick={() => void autoExperiment.pauseExperiment()} title={isZh ? "暂停" : "Pause"}>⏸</button>
                  <button type="button" className="experiment-quick-bar__btn experiment-quick-bar__btn--stop" onClick={() => void autoExperiment.stopExperiment()} title={isZh ? "停止" : "Stop"}>⏹</button>
                </>
              ) : autoExperiment.runState?.status === "paused" ? (
                <>
                  <button type="button" className="experiment-quick-bar__btn experiment-quick-bar__btn--start" onClick={() => void autoExperiment.resumeExperiment()} title={isZh ? "继续" : "Resume"}>▶</button>
                  <button type="button" className="experiment-quick-bar__btn experiment-quick-bar__btn--stop" onClick={() => void autoExperiment.stopExperiment()} title={isZh ? "停止" : "Stop"}>⏹</button>
                </>
              ) : autoExperiment.runState?.status === "completed" ? (
                <span className="experiment-quick-bar__done">{isZh ? "✅ 达标" : "✅ Goal met"}</span>
              ) : (
                <button
                  type="button"
                  className="experiment-quick-bar__btn experiment-quick-bar__btn--start"
                  disabled={!localizedResearch.experimentLoop.enabled}
                  onClick={() => void autoExperiment.startExperiment(localizedResearch.experimentLoop!)}
                  title={isZh ? "开始自动实验" : "Start Auto Experiment"}
                >
                  {isZh ? "▶ 启动" : "▶ Start"}
                </button>
              )}
              {/* Log toggle */}
              <button
                type="button"
                className={`experiment-quick-bar__btn${showExpLogs ? " experiment-quick-bar__btn--active" : ""}`}
                onClick={() => setShowExpLogs((v) => !v)}
                title={isZh ? "查看日志" : "Toggle Logs"}
              >
                📋{autoExperiment.experimentLogs.length > 0 && (
                  <span className="experiment-quick-bar__log-count">{autoExperiment.experimentLogs.length}</span>
                )}
              </button>
            </div>
          </div>
        )}

        {/* ── Experiment Log Panel (terminal-style, collapsible) ── */}
        {localizedResearch.experimentLoop && showExpLogs && (
          <div className="experiment-log-panel">
            <div className="experiment-log-panel__scroll" ref={expLogScrollRef}>
              {autoExperiment.experimentLogs.length === 0 ? (
                <div className="experiment-log-panel__empty">
                  {isZh ? "等待实验日志…" : "Waiting for experiment logs…"}
                </div>
              ) : (
                autoExperiment.experimentLogs.map((log, i) => (
                  <div key={i} className={`experiment-log-panel__line experiment-log-panel__line--${log.level}`}>
                    <span className="experiment-log-panel__time">
                      {new Date(Number(log.timestamp)).toLocaleTimeString()}
                    </span>
                    <span className="experiment-log-panel__msg">{log.message}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Right: Inspector */}
      <aside className="research-inspector">
        <div className="research-inspector__header">
          <div className="research-inspector__eyebrow">{isZh ? "详情" : "Details"}</div>
          <h3>{resolved.task ? (isZh ? "任务详情" : "Task Detail") : (isZh ? "阶段详情" : "Stage Detail")}</h3>
        </div>
        {resolved.task ? (
          <TaskInspector
            locale={locale}
            task={resolved.task}
            canUseTask={taskExecutionState.executableTaskIds.has(resolved.task.id)}
            onOpenArtifact={onOpenArtifact}
            onUseTaskInChat={onUseTaskInChat}
            onOpenWriting={onOpenWriting}
          />
        ) : resolved.stage ? (
          <>
            <StageInspector
              locale={locale}
              stage={resolved.stage}
              onAddTask={(stage) => {
                const dependencyDefaults = localizedResearch.tasks
                  .filter((task) => task.stage === stage && taskExecutionState.executableTaskIds.has(task.id))
                  .map((task) => task.id);
                const stageSummary = localizedResearch.stageSummaries.find((item) => item.stage === stage);
                setTaskComposer(createTaskComposerState(stage, dependencyDefaults, stageSummary?.suggestedSkills ?? []));
              }}
              onInitializeStage={onInitializeStage}
              onOpenArtifact={onOpenArtifact}
              onOpenWriting={onOpenWriting}
            />
            {resolved.stage.stage === "experiment" && localizedResearch.experimentLoop ? (
              <AutoExperimentCard locale={locale} config={localizedResearch.experimentLoop} autoExperiment={autoExperiment} />
            ) : null}
          </>
        ) : (
          <div className="research-inspector__empty">
            {isZh ? "选择一个阶段或任务节点查看详情。" : "Select a stage or task node to see details."}
          </div>
        )}
      </aside>
      {taskComposer ? (
        <TaskComposerDialog
          locale={locale}
          draft={taskComposer}
          dependencyOptions={taskComposerDependencyOptions}
          onChange={setTaskComposer}
          onClose={() => setTaskComposer(null)}
          onSubmit={() => {
            void onAddTask({
              stage: taskComposer.stage,
              title: taskComposer.title.trim(),
              description: taskComposer.description.trim(),
              priority: taskComposer.priority,
              taskType: taskComposer.taskType.trim() || "custom",
              dependencies: taskComposer.dependencies,
              inputsNeeded: splitComposerList(taskComposer.inputsNeeded),
              suggestedSkills: splitComposerList(taskComposer.suggestedSkills),
              nextActionPrompt: taskComposer.nextActionPrompt.trim() || taskComposer.description.trim() || taskComposer.title.trim(),
            });
            setTaskComposer(null);
          }}
        />
      ) : null}
    </div>
  );
}
