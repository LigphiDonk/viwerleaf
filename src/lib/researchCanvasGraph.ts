import type { Edge, Node } from "@xyflow/react";

import type { ResearchCanvasSnapshot, ResearchStage, ResearchStageSummary, ResearchTask, ResearchTaskDraft } from "../types";

export interface ResearchStageNodeData extends Record<string, unknown> {
  kind: "stage";
  stage: ResearchStageSummary;
  onInitializeStage?: (stage: ResearchStage) => void;
}

export interface ResearchStageContainerData extends Record<string, unknown> {
  kind: "stageContainer";
  stage: ResearchStageSummary;
  containerWidth: number;
  containerHeight: number;
  isCollapsed: boolean;
  isCurrentStage?: boolean;
  onToggleCollapse?: (stage: ResearchStage) => void;
  onInitializeStage?: (stage: ResearchStage) => void;
  onAddTask?: (draft: ResearchTaskDraft) => void;
}

export interface ResearchTaskNodeData extends Record<string, unknown> {
  kind: "task";
  task: ResearchTask;
  isCurrentTask?: boolean;
  isExecutableTask?: boolean;
  isBlockedTask?: boolean;
  onEnterTask?: (task: ResearchTask) => void;
}

export type ResearchStageNode = Node<ResearchStageNodeData, "researchStage">;
export type ResearchStageContainerNode = Node<ResearchStageContainerData, "stageContainer">;
export type ResearchTaskNode = Node<ResearchTaskNodeData, "researchTask">;
export type ResearchCanvasNode = ResearchStageNode | ResearchStageContainerNode | ResearchTaskNode;

const STAGE_ORDER: ResearchStage[] = [
  "survey",
  "ideation",
  "experiment",
  "publication",
  "promotion",
];

const STAGE_CENTER_X = 760;
const TASK_NODE_WIDTH = 292;
const TASK_NODE_HEIGHT = 278;
const TASK_COLUMN_GAP = 92;
const TASK_ROW_GAP = 136;
const STAGE_FLOW_IN_HANDLE = "stage-flow-in";
const STAGE_TASK_ENTRY_HANDLE = "stage-task-entry";
const STAGE_FLOW_OUT_HANDLE = "stage-flow-out";
const TASK_FLOW_IN_HANDLE = "task-flow-in";
const TASK_FLOW_OUT_HANDLE = "task-flow-out";

/* Container layout constants */
const CONTAINER_HEADER_H = 88;
const CONTAINER_CHIPS_H = 48;
const CONTAINER_PAD_X = 52;
const CONTAINER_PAD_BOTTOM = 42;
const CONTAINER_MIN_WIDTH = 960;
const COLLAPSED_HEIGHT = 88;
const CONTAINER_GAP = 92;
const CONTAINER_TOP = 44;

function stageNodeId(stage: ResearchStage) {
  return `stage:${stage}`;
}

function taskNodeId(taskId: string) {
  return `task:${taskId}`;
}

function groupTasksByDepth(tasks: ResearchTask[]) {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const depthCache = new Map<string, number>();

  const resolveDepth = (task: ResearchTask, visited = new Set<string>()): number => {
    if (depthCache.has(task.id)) {
      return depthCache.get(task.id) ?? 0;
    }
    if (visited.has(task.id)) {
      return 0;
    }

    visited.add(task.id);
    const sameStageDependencies = task.dependencies
      .map((dependencyId) => taskMap.get(dependencyId))
      .filter((candidate): candidate is ResearchTask => Boolean(candidate));
    const depth = sameStageDependencies.length > 0
      ? Math.max(...sameStageDependencies.map((dependency) => resolveDepth(dependency, visited) + 1))
      : 0;
    visited.delete(task.id);
    depthCache.set(task.id, depth);
    return depth;
  };

  const layers = new Map<number, ResearchTask[]>();
  tasks.forEach((task) => {
    const depth = resolveDepth(task);
    const current = layers.get(depth) ?? [];
    current.push(task);
    layers.set(depth, current);
  });

  return Array.from(layers.entries())
    .sort(([left], [right]) => left - right)
    .map(([, layerTasks]) =>
      layerTasks.sort((left, right) => left.title.localeCompare(right.title, "zh-CN")),
    );
}

function rowWidth(count: number) {
  if (count <= 0) {
    return 0;
  }
  return count * TASK_NODE_WIDTH + Math.max(0, count - 1) * TASK_COLUMN_GAP;
}

export function buildResearchCanvasGraph(
  research: ResearchCanvasSnapshot,
  collapsedStages: Set<ResearchStage> = new Set(),
): {
  nodes: ResearchCanvasNode[];
  edges: Edge[];
} {
  const nodes: ResearchCanvasNode[] = [];
  const edges: Edge[] = [];
  let currentTop = CONTAINER_TOP;
  const visibleTaskIds = new Set(
    research.tasks
      .filter((task) => !collapsedStages.has(task.stage))
      .map((task) => task.id),
  );

  for (const [stageIndex, stage] of STAGE_ORDER.entries()) {
    const summary = research.stageSummaries.find((item) => item.stage === stage);
    if (!summary) {
      continue;
    }

    const stageId = stageNodeId(stage);
    const stageTasks = research.tasks.filter((task) => task.stage === stage);
    const stageTaskIdSet = new Set(stageTasks.map((task) => task.id));
    const isCollapsed = collapsedStages.has(stage);
    const taskRows = isCollapsed ? [] : groupTasksByDepth(stageTasks);
    const chipsHeight = !isCollapsed && summary.suggestedSkills.length > 0 ? CONTAINER_CHIPS_H : 0;

    /* Calculate container dimensions */
    const maxRowWidth = taskRows.length > 0
      ? Math.max(...taskRows.map((row) => rowWidth(row.length)))
      : 0;
    const contentWidth = maxRowWidth + CONTAINER_PAD_X * 2;
    const containerWidth = Math.max(CONTAINER_MIN_WIDTH, contentWidth);

    const taskAreaHeight = taskRows.length > 0
      ? taskRows.length * TASK_NODE_HEIGHT + Math.max(0, taskRows.length - 1) * TASK_ROW_GAP
      : 0;
    const containerHeight = isCollapsed
      ? COLLAPSED_HEIGHT
      : CONTAINER_HEADER_H + chipsHeight + taskAreaHeight + (taskRows.length > 0 ? CONTAINER_PAD_BOTTOM : 16);

    const containerX = STAGE_CENTER_X - containerWidth / 2;
    const containerY = currentTop;

    /* Create container node */
    nodes.push({
      id: stageId,
      type: "stageContainer",
      position: { x: containerX, y: containerY },
      selectable: true,
      draggable: true,
      style: { width: containerWidth, height: containerHeight },
      data: {
        kind: "stageContainer",
        stage: summary,
        containerWidth,
        containerHeight,
        isCollapsed,
        isCurrentStage: research.currentStage === stage,
      },
    } as ResearchStageContainerNode);

    /* Stage-to-stage edge */
    if (stageIndex > 0) {
      edges.push({
        id: `flow:${STAGE_ORDER[stageIndex - 1]}:${stage}`,
        source: stageNodeId(STAGE_ORDER[stageIndex - 1]),
        sourceHandle: STAGE_FLOW_OUT_HANDLE,
        target: stageId,
        targetHandle: STAGE_FLOW_IN_HANDLE,
        type: "default",
        animated: research.currentStage === stage,
        style: {
          stroke: stage === research.currentStage ? "rgba(109, 40, 217, 0.98)" : "rgba(124, 58, 237, 0.38)",
          strokeWidth: stage === research.currentStage ? 3.4 : 2.4,
        },
      });
    }

    /* Task nodes inside the container */
    if (!isCollapsed) {
      taskRows.forEach((row, rowIndex) => {
        const totalWidth = rowWidth(row.length);
        const rowStartX = (containerWidth - totalWidth) / 2;
        const rowY = CONTAINER_HEADER_H + chipsHeight + rowIndex * (TASK_NODE_HEIGHT + TASK_ROW_GAP);

        row.forEach((task, columnIndex) => {
          const taskId = taskNodeId(task.id);
          nodes.push({
            id: taskId,
            type: "researchTask",
            position: {
              x: rowStartX + columnIndex * (TASK_NODE_WIDTH + TASK_COLUMN_GAP),
              y: rowY,
            },
            parentId: stageId,
            extent: "parent" as const,
            selectable: true,
            data: {
              kind: "task",
              task,
            },
          } as ResearchTaskNode);

          /* Stage → first-row task edges */
          if (!task.dependencies.some((dependencyId) => stageTaskIdSet.has(dependencyId))) {
            edges.push({
              id: `stage:${stage}:${task.id}`,
              source: stageId,
              sourceHandle: STAGE_TASK_ENTRY_HANDLE,
              target: taskId,
              targetHandle: TASK_FLOW_IN_HANDLE,
              type: "default",
              animated: research.nextTask?.id === task.id,
              style: {
                stroke: research.nextTask?.id === task.id ? "rgba(109, 40, 217, 0.98)" : "rgba(124, 58, 237, 0.3)",
                strokeWidth: research.nextTask?.id === task.id ? 3 : 2,
              },
            });
          }

          /* Task dependency edges */
          task.dependencies.forEach((dependencyId) => {
            if (!visibleTaskIds.has(dependencyId)) {
              return;
            }
            edges.push({
              id: `dep:${dependencyId}:${task.id}`,
              source: taskNodeId(dependencyId),
              sourceHandle: TASK_FLOW_OUT_HANDLE,
              target: taskId,
              targetHandle: TASK_FLOW_IN_HANDLE,
              type: "default",
              animated: research.nextTask?.id === task.id,
              style: {
                stroke: research.nextTask?.id === task.id ? "rgba(109, 40, 217, 0.96)" : "rgba(124, 58, 237, 0.32)",
                strokeWidth: research.nextTask?.id === task.id ? 2.7 : 1.9,
              },
            });
          });
        });
      });
    }

    currentTop += containerHeight + CONTAINER_GAP;
  }

  return { nodes, edges };
}

export function defaultResearchSelection(research: ResearchCanvasSnapshot): string {
  if (research.nextTask?.id) {
    return taskNodeId(research.nextTask.id);
  }
  return stageNodeId(research.currentStage);
}

export function selectionToEntity(
  research: ResearchCanvasSnapshot,
  selectionId: string | null,
): { stage?: ResearchStageSummary; task?: ResearchTask } {
  if (!selectionId) {
    return {};
  }

  if (selectionId.startsWith("task:")) {
    const taskId = selectionId.slice("task:".length);
    const task = research.tasks.find((item) => item.id === taskId);
    return task ? { task } : {};
  }

  if (selectionId.startsWith("stage:")) {
    const stage = selectionId.slice("stage:".length) as ResearchStage;
    const stageSummary = research.stageSummaries.find((item) => item.stage === stage);
    return stageSummary ? { stage: stageSummary } : {};
  }

  return {};
}
