import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
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
  isBusy?: boolean;
  onBootstrap: () => Promise<void> | void;
  onOpenArtifact: (path: string) => void;
  onUseTaskInChat: (task: ResearchTask) => Promise<void> | void;
  onOpenWriting: () => void;
}

function StageNode({ data }: NodeProps<ResearchStageNode>) {
  const stage = data.stage;
  const isZh = stage.label !== "Survey" && stage.label !== "Ideation" && stage.label !== "Experiment" && stage.label !== "Publication" && stage.label !== "Promotion";
  return (
    <div className={`research-stage-node is-${stage.status}`}>
      <Handle type="target" position={Position.Top} className="research-node-handle" />
      <div className="research-stage-node__eyebrow">{stage.label}</div>
      <div className="research-stage-node__title">{stage.description}</div>
      <div className="research-stage-node__stats">
        <span>{stage.doneTasks}/{stage.totalTasks || 0} {isZh ? "任务" : "tasks"}</span>
        <span>{stage.artifactCount} {isZh ? "产物" : "artifacts"}</span>
      </div>
      {stage.suggestedSkills.length > 0 ? (
        <div className="research-node-chips">
          {stage.suggestedSkills.slice(0, 2).map((skill: string) => (
            <span key={skill} className="research-node-chip">{skill}</span>
          ))}
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="research-node-handle" />
    </div>
  );
}

function TaskNode({ data }: NodeProps<ResearchTaskNode>) {
  const task = data.task;
  const isZh = /[\u4e00-\u9fff]/.test(task.title);
  return (
    <div className={`research-task-node is-${task.status}`}>
      <Handle type="target" position={Position.Top} className="research-node-handle" />
      <div className="research-task-node__header">
        <span className="research-task-node__status">{isZh
          ? ({ pending: "待开始", "in-progress": "进行中", done: "已完成", review: "待检查", deferred: "已延后", cancelled: "已取消" }[task.status] ?? task.status)
          : task.status}</span>
        <span className="research-task-node__priority">{isZh
          ? ({ high: "高优先级", medium: "中优先级", low: "低优先级" }[task.priority] ?? task.priority)
          : task.priority}</span>
      </div>
      <div className="research-task-node__title">{task.title}</div>
      <div className="research-task-node__body">{task.description}</div>
      {task.suggestedSkills.length > 0 ? (
        <div className="research-node-chips">
          {task.suggestedSkills.slice(0, 2).map((skill: string) => (
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
        <span>{isZh ? "状态" : "Status"}: {task.status}</span>
        <span>{isZh ? "优先级" : "Priority"}: {task.priority}</span>
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
  return (
    <div className="research-inspector__section">
      <div className="research-inspector__eyebrow">{stage.label}</div>
      <h3>{stage.description}</h3>
      <div className="research-inspector__meta">
        <span>{isZh ? "状态" : "Status"}: {stage.status}</span>
        <span>{isZh ? "已完成任务" : "Tasks done"}: {stage.doneTasks}/{stage.totalTasks || 0}</span>
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

export function ResearchCanvas({
  locale,
  research,
  isBusy = false,
  onBootstrap,
  onOpenArtifact,
  onUseTaskInChat,
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
  const [selectionId, setSelectionId] = useState<string | null>(
    localizedResearch ? defaultResearchSelection(localizedResearch) : null,
  );

  useEffect(() => {
    setSelectionId(localizedResearch ? defaultResearchSelection(localizedResearch) : null);
  }, [localizedResearch]);

  if (needsBootstrap) {
    return <ResearchOnboarding locale={locale} research={localizedResearch} isBusy={isBusy} onBootstrap={onBootstrap} />;
  }

  const resolved = selectionToEntity(localizedResearch, selectionId);

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
            <span>{isZh ? "当前阶段" : "Current stage"}: {resolved.stage?.label ?? localizedResearch.stageSummaries.find((item) => item.stage === localizedResearch.currentStage)?.label ?? localizedResearch.currentStage}</span>
            {localizedResearch.nextTask ? <span>{isZh ? "下一任务" : "Next task"}: {localizedResearch.nextTask.title}</span> : null}
          </div>
        </div>
        <div className="research-canvas__flow">
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            fitView
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_event, node) => setSelectionId(node.id)}
          >
            <Background color="#d7dee8" gap={20} size={1.5} />
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
