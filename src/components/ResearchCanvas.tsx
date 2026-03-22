import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useNodesState,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  buildResearchCanvasGraph,
  defaultResearchSelection,
  selectionToEntity,
  type ResearchStageContainerNode,
  type ResearchTaskNode,
} from "../lib/researchCanvasGraph";
import { desktop } from "../lib/desktop";
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
  isBusy?: boolean;
  onBootstrap: () => Promise<void> | void;
  onInitializeStage: (stage: ResearchStage) => Promise<void> | void;
  onOpenArtifact: (path: string) => void;
  onUseTaskInChat: (task: ResearchTask) => Promise<void> | void;
  onEnterTask: (task: ResearchTask) => Promise<void> | void;
  onAddTask: (draft: ResearchTaskDraft) => Promise<void> | void;
  onOpenLiteratureForTask: (taskId: string) => void;
  onOpenWriting: () => void;
}

function formatTaskStatus(task: ResearchTask, isZh: boolean) {
  if (!isZh) {
    return task.status;
  }
  return ({
    pending: "待开始",
    "in-progress": "进行中",
    done: "已完成",
    review: "待检查",
    deferred: "已延后",
    cancelled: "已取消",
  }[task.status] ?? task.status);
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

function resolveResearchTaskExecutionState(research: ResearchCanvasSnapshot): ResearchTaskExecutionState {
  const doneIds = new Set(
    research.tasks
      .filter((task) => task.status === "done")
      .map((task) => task.id),
  );
  const executableTaskIds = new Set(
    research.tasks
      .filter((task) => task.stage === research.currentStage)
      .filter((task) => ["in-progress", "review"].includes(task.status))
      .map((task) => task.id),
  );

  if (executableTaskIds.size === 0) {
    research.tasks
      .filter((task) => task.stage === research.currentStage)
      .filter((task) => ["pending", "review", ""].includes(task.status))
      .filter((task) => task.dependencies.every((dependencyId) => doneIds.has(dependencyId)))
      .forEach((task) => executableTaskIds.add(task.id));
  }

  const blockedTaskIds = new Set(
    research.tasks
      .filter((task) => task.status !== "done" && !executableTaskIds.has(task.id))
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

/* ── Stage Container Node ── */
function StageContainerNode({ data, selected }: NodeProps<ResearchStageContainerNode>) {
  const stage = data.stage;
  const isCollapsed = data.isCollapsed;
  const completion = stage.totalTasks > 0 ? Math.round((stage.doneTasks / stage.totalTasks) * 100) : 0;
  const isZh = /[\u4e00-\u9fff]/.test(stage.label);

  return (
    <div
      className={`research-stage-container is-${stage.status}${selected ? " is-selected" : ""}${isCollapsed ? " is-collapsed" : ""}`}
      style={{ width: data.containerWidth, height: data.containerHeight }}
    >
      <Handle
        id="stage-flow-in"
        type="target"
        position={Position.Top}
        className="research-node-handle research-node-handle--stage-flow-in"
      />
      <Handle
        id="stage-task-entry"
        type="source"
        position={Position.Top}
        className="research-node-handle research-node-handle--stage-task-entry"
      />

      <div className="research-stage-container__header">
        <div className="research-stage-container__stripe" />
        <div className="research-stage-container__info">
          <div className="research-stage-container__eyebrow">{stage.label}</div>
          <div className="research-stage-container__desc">{stage.description}</div>
        </div>
        <div className="research-stage-container__right">
          <div className="research-stage-container__progress">
            <span className="research-stage-container__pct">{completion}%</span>
            <div className="research-stage-container__progress-bar">
              <div className="research-stage-container__progress-fill" style={{ width: `${completion}%` }} />
            </div>
          </div>
          <div className="research-stage-container__stats">
            <span>{stage.doneTasks}/{stage.totalTasks || 0}</span>
            <span>{stage.taskCounts.inProgress} {isZh ? "进行中" : "active"}</span>
            <span>{stage.artifactCount} {isZh ? "产物" : "assets"}</span>
          </div>
          {stage.canInitialize ? (
            <button
              type="button"
              className="research-task-node__agent-btn"
              onClick={(event) => {
                event.stopPropagation();
                void data.onInitializeStage?.(stage.stage as ResearchStage);
              }}
            >
              {isZh ? "开始本阶段" : "Start Stage"}
            </button>
          ) : null}
          <button
            type="button"
            className="research-stage-container__add"
            onClick={(event) => {
              event.stopPropagation();
              data.onAddTask?.({
                stage: stage.stage as ResearchStage,
                title: "",
                suggestedSkills: stage.suggestedSkills,
              });
            }}
          >
            {isZh ? "添加任务" : "Add Task"}
          </button>
          <button
            type="button"
            className="research-stage-container__toggle"
            onClick={(event) => {
              event.stopPropagation();
              data.onToggleCollapse?.(stage.stage as ResearchStage);
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              style={{ transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.2s ease" }}
            >
              <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {stage.suggestedSkills.length > 0 && !isCollapsed ? (
        <div className="research-stage-container__chips">
          {stage.suggestedSkills.slice(0, 2).map((skill) => (
            <span key={skill} className="research-node-chip">{skill}</span>
          ))}
        </div>
      ) : null}

      <Handle
        id="stage-flow-out"
        type="source"
        position={Position.Bottom}
        className="research-node-handle research-node-handle--stage-flow-out"
      />
    </div>
  );
}

/* ── Task Node (preserved from original) ── */
function TaskNode({ data, selected }: NodeProps<ResearchTaskNode>) {
  const task = data.task;
  const isZh = /[\u4e00-\u9fff]/.test(task.title);
  const isExecutable = Boolean(data.isExecutableTask);
  const isBlocked = Boolean(data.isBlockedTask);
  const statusIcon =
    task.status === "done"
      ? "check"
      : task.status === "in-progress" || task.status === "review"
        ? "pulse"
        : isBlocked
          ? "lock"
          : "pending";
  return (
    <div
      className={
        `research-task-node is-${task.status}${selected ? " is-selected" : ""}${data.isCurrentTask ? " is-current-task" : ""}${isExecutable ? " is-executable" : ""}${isBlocked ? " is-blocked" : ""}`
      }
    >
      <Handle id="task-flow-in" type="target" position={Position.Top} className="research-node-handle" />
      <div className="research-task-node__stripe" />
      <div className="research-task-node__header">
        <span className={`research-task-node__status is-${statusIcon}`}>
          <span className={`research-task-node__status-dot is-${statusIcon}`} />
          {formatTaskStatus(task, isZh)}
        </span>
        <span className="research-task-node__priority">{formatPriority(task, isZh)}</span>
      </div>
      <div className="research-task-node__title">{task.title}</div>
      <div className="research-task-node__body">{task.description}</div>
      <div className="research-task-node__meta">
        <span>{task.inputsNeeded.length} {isZh ? "输入" : "inputs"}</span>
        <span>{task.artifactPaths.length} {isZh ? "产物" : "artifacts"}</span>
        {(data.literatureCount ?? 0) > 0 && (
          <span
            className="research-task-node__lit-count"
            onClick={(event) => {
              event.stopPropagation();
              data.onNavigateToLiterature?.(task.id);
            }}
            title={isZh ? "查看关联文献" : "View linked literature"}
          >
            📚 {data.literatureCount}
          </span>
        )}
        <span>{isExecutable ? (isZh ? "可执行" : "ready") : isBlocked ? (isZh ? "阻塞" : "blocked") : (isZh ? "等待中" : "waiting")}</span>
      </div>
      <div className="research-task-node__actions">
        <button
          type="button"
          className="research-task-node__agent-btn"
          onClick={(event) => {
            event.stopPropagation();
            void data.onEnterTask?.(task);
          }}
          disabled={!isExecutable}
        >
          {isExecutable ? (task.agentEntryLabel || (isZh ? "进入 Agent" : "Enter Agent")) : (isZh ? "等待前置任务" : "Waiting on dependencies")}
        </button>
      </div>
      {task.suggestedSkills.length > 0 ? (
        <div className="research-node-chips">
          {task.suggestedSkills.slice(0, 2).map((skill) => (
            <span key={skill} className="research-node-chip">{skill}</span>
          ))}
        </div>
      ) : null}
      <Handle id="task-flow-out" type="source" position={Position.Bottom} className="research-node-handle" />
    </div>
  );
}

const nodeTypes = {
  stageContainer: StageContainerNode,
  researchTask: TaskNode,
} satisfies NodeTypes;

function buildNodeLayoutSignature(nodes: ReadonlyArray<{
  id: string;
  type?: string;
  parentId?: string;
  position: { x: number; y: number };
  style?: { width?: string | number; height?: string | number };
}>) {
  return nodes.map((node) => [
    node.id,
    node.type,
    node.parentId ?? "",
    node.position.x,
    node.position.y,
    String(node.style?.width ?? ""),
    String(node.style?.height ?? ""),
  ].join(":")).join("|");
}

function resolveFallbackSelection(
  research: ResearchCanvasSnapshot,
  selectionId: string | null,
  visibleNodeIds: Set<string>,
) {
  if (selectionId && visibleNodeIds.has(selectionId)) {
    return selectionId;
  }

  if (selectionId?.startsWith("task:")) {
    const taskId = selectionId.slice("task:".length);
    const task = research.tasks.find((item) => item.id === taskId);
    if (task) {
      const stageId = `stage:${task.stage}`;
      if (visibleNodeIds.has(stageId)) {
        return stageId;
      }
    }
  }

  const defaultSelection = defaultResearchSelection(research);
  return visibleNodeIds.has(defaultSelection) ? defaultSelection : null;
}

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
  const title =
    status === "missing-brief" || status === "missing-tasks" || status === "partial"
      ? (isZh ? "修复研究画布脚手架" : "Repair the research canvas scaffold")
      : (isZh ? "启用研究画布" : "Enable the research canvas");
  const buttonLabel =
    status === "missing-brief" || status === "missing-tasks" || status === "partial"
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
        <button
          type="button"
          className="research-primary-btn"
          onClick={() => void onBootstrap()}
          disabled={isBusy}
        >
          {isBusy ? (isZh ? "处理中..." : "Working...") : buttonLabel}
        </button>
      </div>
    </div>
  );
}

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
  return (
    <div className="research-inspector__section">
      <div className="research-inspector__eyebrow">{task.stage}</div>
      <h3>{task.title}</h3>
      <p>{task.description}</p>
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
        <button type="button" className="research-primary-btn" onClick={() => void onUseTaskInChat(task)} disabled={!canUseTask}>
          {canUseTask ? (isZh ? "发送到聊天" : "Use in Chat") : (isZh ? "等待轮到该任务" : "Wait until this task is ready")}
        </button>
        {task.stage === "publication" ? (
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
              <button key={path} type="button" onClick={() => onOpenArtifact(path)}>
                {path}
              </button>
            ))}
          </div>
        </>
      ) : null}
      <div className="research-inspector__prompt">{task.nextActionPrompt}</div>
    </div>
  );
}

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
              <button key={path} type="button" onClick={() => onOpenArtifact(path)}>
                {path}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

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
          <button type="button" className="research-stage-container__toggle" onClick={onClose}>×</button>
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

function ResearchStageRail({
  locale,
  stages,
  activeSelectionId,
  onSelectStage,
}: {
  locale: AppLocale;
  stages: ResearchStageSummary[];
  activeSelectionId: string | null;
  onSelectStage: (stage: ResearchStageSummary) => void;
}) {
  const isZh = locale === "zh-CN";
  return (
    <div className="research-canvas__rail">
      {stages.map((stage, index) => {
        const completion = stage.totalTasks > 0 ? Math.round((stage.doneTasks / stage.totalTasks) * 100) : 0;
        const isSelected = activeSelectionId === `stage:${stage.stage}`;
        return (
          <button
            key={stage.stage}
            type="button"
            className={`research-canvas__rail-item is-${stage.status}${isSelected ? " is-selected" : ""}`}
            onClick={() => onSelectStage(stage)}
          >
            <span className="research-canvas__rail-index">{index + 1}</span>
            <span className="research-canvas__rail-main">
              <strong>{stage.label}</strong>
              <small>{completion}% · {stage.doneTasks}/{stage.totalTasks || 0} {isZh ? "任务" : "tasks"}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ResearchCanvas({
  locale,
  research,
  activeTaskId = null,
  isBusy = false,
  onBootstrap,
  onInitializeStage,
  onOpenArtifact,
  onUseTaskInChat,
  onEnterTask,
  onAddTask,
  onOpenLiteratureForTask,
  onOpenWriting,
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
  const [literatureCounts, setLiteratureCounts] = useState<Record<string, number>>({});
  const [taskComposer, setTaskComposer] = useState<TaskComposerState | null>(null);

  /* Collapse state: which stages are collapsed */
  const [collapsedStages, setCollapsedStages] = useState<Set<ResearchStage>>(new Set());
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

  const graph = useMemo(
    () => (localizedResearch ? buildResearchCanvasGraph(localizedResearch, collapsedStages) : { nodes: [], edges: [] }),
    [localizedResearch, collapsedStages],
  );

  useEffect(() => {
    if (!localizedResearch) {
      setLiteratureCounts({});
      return;
    }

    let cancelled = false;
    const loadCounts = async () => {
      try {
        const entries = await Promise.all(
          localizedResearch.tasks.map(async (task) => [task.id, await desktop.countLiteratureForTask(task.id)] as const),
        );
        if (!cancelled) {
          setLiteratureCounts(Object.fromEntries(entries));
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to load literature counts:", error);
          setLiteratureCounts({});
        }
      }
    };

    void loadCounts();
    return () => {
      cancelled = true;
    };
  }, [localizedResearch]);

  const enrichedNodes = useMemo(
    () => graph.nodes.map((node) => {
      if (node.type === "researchTask") {
        return {
          ...node,
          data: {
            ...node.data,
            isCurrentTask: node.data.task.id === activeTaskId || node.data.task.id === localizedResearch?.nextTask?.id,
            isExecutableTask: taskExecutionState.executableTaskIds.has(node.data.task.id),
            isBlockedTask: taskExecutionState.blockedTaskIds.has(node.data.task.id),
            literatureCount: literatureCounts[node.data.task.id] ?? 0,
            onEnterTask,
            onNavigateToLiterature: onOpenLiteratureForTask,
          },
        };
      }
      /* stageContainer */
      return {
        ...node,
        data: {
          ...node.data,
          onInitializeStage,
          onAddTask: (draft: ResearchTaskDraft) => {
            const dependencyDefaults = localizedResearch?.tasks
              .filter((task) => task.stage === draft.stage && task.status !== "cancelled")
              .filter((task) => taskExecutionState.executableTaskIds.has(task.id))
              .map((task) => task.id) ?? [];
            setTaskComposer(createTaskComposerState(draft.stage, dependencyDefaults, draft.suggestedSkills ?? []));
          },
          onToggleCollapse: handleToggleCollapse,
        },
      };
    }),
    [activeTaskId, graph.nodes, literatureCounts, localizedResearch?.nextTask?.id, localizedResearch?.tasks, onEnterTask, onInitializeStage, onOpenLiteratureForTask, handleToggleCollapse, taskExecutionState.blockedTaskIds, taskExecutionState.executableTaskIds],
  );
  const layoutSignature = useMemo(() => buildNodeLayoutSignature(enrichedNodes), [enrichedNodes]);
  const visibleNodeIds = useMemo(() => new Set(enrichedNodes.map((node) => node.id)), [enrichedNodes]);

  const [selectionId, setSelectionId] = useState<string | null>(
    localizedResearch ? defaultResearchSelection(localizedResearch) : null,
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(enrichedNodes);
  const didInitializeRef = useRef(false);
  const previousLayoutSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!localizedResearch) {
      didInitializeRef.current = false;
      previousLayoutSignatureRef.current = null;
      const frame = window.requestAnimationFrame(() => {
        setSelectionId(null);
        setNodes([]);
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    const frame = window.requestAnimationFrame(() => {
      setSelectionId((currentSelectionId) => resolveFallbackSelection(localizedResearch, currentSelectionId, visibleNodeIds));
      setNodes((currentNodes) => {
        if (!didInitializeRef.current) {
          didInitializeRef.current = true;
          previousLayoutSignatureRef.current = layoutSignature;
          return enrichedNodes;
        }

        const shouldResetLayout = previousLayoutSignatureRef.current !== layoutSignature;
        previousLayoutSignatureRef.current = layoutSignature;
        if (shouldResetLayout) {
          return enrichedNodes;
        }

        const currentPositionById = new Map(currentNodes.map((node) => [node.id, node.position]));
        return enrichedNodes.map((node) => ({
          ...node,
          position: currentPositionById.get(node.id) ?? node.position,
        }));
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [enrichedNodes, layoutSignature, localizedResearch, setNodes, visibleNodeIds]);

  if (needsBootstrap) {
    return <ResearchOnboarding locale={locale} research={localizedResearch} isBusy={isBusy} onBootstrap={onBootstrap} />;
  }

  const resolved = selectionToEntity(localizedResearch, selectionId);
  const totalTasks = localizedResearch.tasks.length;
  const doneTasks = localizedResearch.tasks.filter((task) => task.status === "done").length;
  const reviewTasks = localizedResearch.tasks.filter((task) => task.status === "review").length;
  const inProgressTasks = localizedResearch.tasks.filter((task) => task.status === "in-progress").length;
  const completion = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const currentStageLabel =
    localizedResearch.stageSummaries.find((item) => item.stage === localizedResearch.currentStage)?.label ??
    localizedResearch.currentStage;
  const taskComposerDependencyOptions = taskComposer
    ? localizedResearch.tasks.filter((task) =>
      (task.stage === taskComposer.stage || task.status === "done" || taskExecutionState.executableTaskIds.has(task.id)))
    : [];

  return (
    <div className="research-canvas-shell">
      <div className="research-canvas__board">
        <div className="research-canvas__header">
          <div>
            <div className="research-canvas__eyebrow">{isZh ? "研究工作流" : "Research Workflow"}</div>
            <h2>{localizedResearch.briefTopic}</h2>
            <p>{localizedResearch.briefGoal}</p>
          </div>
          <div className="research-canvas__header-meta">
            <span>{isZh ? "当前阶段" : "Current stage"}: {currentStageLabel}</span>
            {localizedResearch.nextTask ? <span>{isZh ? "下一任务" : "Next task"}: {localizedResearch.nextTask.title}</span> : null}
          </div>
        </div>

        <div className="research-canvas__overview">
          <div className="research-canvas__metric">
            <strong>{completion}%</strong>
            <span>{isZh ? "总体完成度" : "Overall completion"}</span>
          </div>
          <div className="research-canvas__metric">
            <strong>{inProgressTasks}</strong>
            <span>{isZh ? "进行中任务" : "Tasks in progress"}</span>
          </div>
          <div className="research-canvas__metric">
            <strong>{reviewTasks}</strong>
            <span>{isZh ? "待检查任务" : "Tasks in review"}</span>
          </div>
          <div className="research-canvas__metric">
            <strong>{localizedResearch.artifactPaths.publication.length}</strong>
            <span>{isZh ? "写作产物" : "Publication artifacts"}</span>
          </div>
        </div>

        <ResearchStageRail
          locale={locale}
          stages={localizedResearch.stageSummaries}
          activeSelectionId={selectionId}
          onSelectStage={(stage) => setSelectionId(`stage:${stage.stage}`)}
        />

        <div className="research-canvas__flow">
          <ReactFlow
            nodes={nodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={(_event, node) => setSelectionId(node.id)}
            onPaneClick={() => setSelectionId(null)}
            nodesDraggable
            nodesConnectable={false}
            fitView
            fitViewOptions={{ padding: 0.16, maxZoom: 1.08 }}
            minZoom={0.45}
            maxZoom={1.45}
            panOnScroll
            proOptions={{ hideAttribution: true }}
          >
            <Background color="rgba(15, 23, 42, 0.14)" gap={22} size={1.3} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>

      <aside className="research-inspector">
        <div className="research-inspector__header">
          <div className="research-inspector__eyebrow">{isZh ? "检查面板" : "Inspector"}</div>
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
        ) : (
          <div className="research-inspector__empty">
            {isZh ? "选择一个阶段或任务节点，查看下一步操作。" : "Select a stage or task node to inspect its next action."}
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
