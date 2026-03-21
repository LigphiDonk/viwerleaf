import { useEffect, useMemo, useRef, useState } from "react";
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
  type ResearchStageNode,
  type ResearchTaskNode,
} from "../lib/researchCanvasGraph";
import { localizeResearchSnapshot } from "../lib/researchLocale";
import type {
  AppLocale,
  ResearchCanvasSnapshot,
  ResearchStageSummary,
  ResearchTask,
} from "../types";

interface ResearchCanvasProps {
  locale: AppLocale;
  research: ResearchCanvasSnapshot | null | undefined;
  activeTaskId?: string | null;
  isBusy?: boolean;
  onBootstrap: () => Promise<void> | void;
  onOpenArtifact: (path: string) => void;
  onUseTaskInChat: (task: ResearchTask) => Promise<void> | void;
  onEnterTask: (task: ResearchTask) => Promise<void> | void;
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

function StageNode({ data, selected }: NodeProps<ResearchStageNode>) {
  const stage = data.stage;
  const completion = stage.totalTasks > 0 ? Math.round((stage.doneTasks / stage.totalTasks) * 100) : 0;
  return (
    <div className={`research-stage-node is-${stage.status}${selected ? " is-selected" : ""}`}>
      <Handle type="target" position={Position.Top} className="research-node-handle" />
      <div className="research-stage-node__stripe" />
      <div className="research-stage-node__eyebrow">{stage.label}</div>
      <div className="research-stage-node__title">{stage.description}</div>
      <div className="research-stage-node__progress">
        <span>{completion}%</span>
        <div className="research-stage-node__progress-bar">
          <div className="research-stage-node__progress-fill" style={{ width: `${completion}%` }} />
        </div>
      </div>
      <div className="research-stage-node__stats">
        <span>{stage.doneTasks}/{stage.totalTasks || 0}</span>
        <span>{stage.taskCounts.inProgress} active</span>
        <span>{stage.artifactCount} assets</span>
      </div>
      {stage.suggestedSkills.length > 0 ? (
        <div className="research-node-chips">
          {stage.suggestedSkills.slice(0, 2).map((skill) => (
            <span key={skill} className="research-node-chip">{skill}</span>
          ))}
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="research-node-handle" />
    </div>
  );
}

function TaskNode({ data, selected }: NodeProps<ResearchTaskNode>) {
  const task = data.task;
  const isZh = /[\u4e00-\u9fff]/.test(task.title);
  return (
    <div className={`research-task-node is-${task.status}${selected ? " is-selected" : ""}${data.isCurrentTask ? " is-current-task" : ""}`}>
      <Handle type="target" position={Position.Top} className="research-node-handle" />
      <div className="research-task-node__stripe" />
      <div className="research-task-node__header">
        <span className="research-task-node__status">{formatTaskStatus(task, isZh)}</span>
        <span className="research-task-node__priority">{formatPriority(task, isZh)}</span>
      </div>
      <div className="research-task-node__title">{task.title}</div>
      <div className="research-task-node__body">{task.description}</div>
      <div className="research-task-node__meta">
        <span>{task.inputsNeeded.length} {isZh ? "输入" : "inputs"}</span>
        <span>{task.artifactPaths.length} {isZh ? "产物" : "artifacts"}</span>
      </div>
      <div className="research-task-node__actions">
        <button
          type="button"
          className="research-task-node__agent-btn"
          onClick={(event) => {
            event.stopPropagation();
            void data.onEnterTask?.(task);
          }}
        >
          {task.agentEntryLabel || (isZh ? "进入 Agent" : "Enter Agent")}
        </button>
      </div>
      {task.suggestedSkills.length > 0 ? (
        <div className="research-node-chips">
          {task.suggestedSkills.slice(0, 2).map((skill) => (
            <span key={skill} className="research-node-chip">{skill}</span>
          ))}
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="research-node-handle" />
    </div>
  );
}

const nodeTypes = {
  researchStage: StageNode,
  researchTask: TaskNode,
} satisfies NodeTypes;

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
  onOpenArtifact,
  onUseTaskInChat,
  onOpenWriting,
}: {
  locale: AppLocale;
  task: ResearchTask;
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
        <button type="button" className="research-primary-btn" onClick={() => void onUseTaskInChat(task)}>
          {isZh ? "发送到聊天" : "Use in Chat"}
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
  onOpenArtifact,
  onOpenWriting,
}: {
  locale: AppLocale;
  stage: ResearchStageSummary;
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
          <div className="research-inspector__label">{isZh ? "推荐技能" : "Suggested skills"}</div>
          <div className="research-inspector__list">
            {stage.suggestedSkills.map((item) => <span key={item}>{item}</span>)}
          </div>
        </>
      ) : null}
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
  onOpenArtifact,
  onUseTaskInChat,
  onEnterTask,
  onOpenWriting,
}: ResearchCanvasProps) {
  const isZh = locale === "zh-CN";
  const localizedResearch = useMemo(
    () => (research ? localizeResearchSnapshot(research, locale) : research),
    [locale, research],
  );
  const needsBootstrap = !localizedResearch || localizedResearch.bootstrap.status !== "ready";
  const graph = useMemo(
    () => (localizedResearch ? buildResearchCanvasGraph(localizedResearch) : { nodes: [], edges: [] }),
    [localizedResearch],
  );
  const enrichedNodes = useMemo(
    () => graph.nodes.map((node) => (
      node.type === "researchTask"
        ? {
          ...node,
          data: {
            ...node.data,
            isCurrentTask: node.data.task.id === activeTaskId,
            onEnterTask,
          },
        }
        : node
    )),
    [activeTaskId, graph.nodes, onEnterTask],
  );
  const [selectionId, setSelectionId] = useState<string | null>(
    localizedResearch ? defaultResearchSelection(localizedResearch) : null,
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(enrichedNodes);
  const didInitializeRef = useRef(false);

  useEffect(() => {
    if (!localizedResearch) {
      didInitializeRef.current = false;
      setSelectionId(null);
      setNodes([]);
      return;
    }

    setSelectionId(defaultResearchSelection(localizedResearch));
    setNodes((currentNodes) => {
      const currentPositionById = new Map(currentNodes.map((node) => [node.id, node.position]));
      if (!didInitializeRef.current) {
        didInitializeRef.current = true;
        return enrichedNodes;
      }
      return enrichedNodes.map((node) => ({
        ...node,
        position: currentPositionById.get(node.id) ?? node.position,
      }));
    });
  }, [enrichedNodes, localizedResearch, setNodes]);

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
            onOpenArtifact={onOpenArtifact}
            onUseTaskInChat={onUseTaskInChat}
            onOpenWriting={onOpenWriting}
          />
        ) : resolved.stage ? (
          <StageInspector
            locale={locale}
            stage={resolved.stage}
            onOpenArtifact={onOpenArtifact}
            onOpenWriting={onOpenWriting}
          />
        ) : (
          <div className="research-inspector__empty">
            {isZh ? "选择一个阶段或任务节点，查看下一步操作。" : "Select a stage or task node to inspect its next action."}
          </div>
        )}
      </aside>
    </div>
  );
}
