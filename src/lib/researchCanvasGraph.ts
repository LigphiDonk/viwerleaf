import type { Edge, Node } from "@xyflow/react";

import type { ResearchCanvasSnapshot, ResearchStage, ResearchStageSummary, ResearchTask } from "../types";

export interface ResearchStageNodeData extends Record<string, unknown> {
  kind: "stage";
  stage: ResearchStageSummary;
}

export interface ResearchTaskNodeData extends Record<string, unknown> {
  kind: "task";
  task: ResearchTask;
  isCurrentTask?: boolean;
  onEnterTask?: (task: ResearchTask) => void;
}

export type ResearchStageNode = Node<ResearchStageNodeData, "researchStage">;
export type ResearchTaskNode = Node<ResearchTaskNodeData, "researchTask">;
export type ResearchCanvasNode = ResearchStageNode | ResearchTaskNode;

const STAGE_ORDER: ResearchStage[] = [
  "survey",
  "ideation",
  "experiment",
  "publication",
  "promotion",
];

const STAGE_CENTER_X = 760;
const STAGE_NODE_WIDTH = 300;
const STAGE_NODE_HEIGHT = 182;
const TASK_NODE_WIDTH = 250;
const TASK_NODE_HEIGHT = 228;
const TASK_COLUMN_GAP = 56;
const TASK_ROW_GAP = 104;
const STAGE_TO_TASK_GAP = 118;
const STAGE_BLOCK_GAP = 172;
const STAGE_TOP = 40;

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

export function buildResearchCanvasGraph(research: ResearchCanvasSnapshot): {
  nodes: ResearchCanvasNode[];
  edges: Edge[];
} {
  const nodes: ResearchCanvasNode[] = [];
  const edges: Edge[] = [];
  let currentTop = STAGE_TOP;

  for (const [stageIndex, stage] of STAGE_ORDER.entries()) {
    const summary = research.stageSummaries.find((item) => item.stage === stage);
    if (!summary) {
      continue;
    }

    const stageId = stageNodeId(stage);
    const stageTasks = research.tasks.filter((task) => task.stage === stage);
    const stageTaskIdSet = new Set(stageTasks.map((task) => task.id));
    const taskRows = groupTasksByDepth(stageTasks);
    const stageX = STAGE_CENTER_X - STAGE_NODE_WIDTH / 2;
    const stageY = currentTop;

    nodes.push({
      id: stageId,
      type: "researchStage",
      position: { x: stageX, y: stageY },
      selectable: true,
      data: {
        kind: "stage",
        stage: summary,
      },
    });

    if (stageIndex > 0) {
      edges.push({
        id: `flow:${STAGE_ORDER[stageIndex - 1]}:${stage}`,
        source: stageNodeId(STAGE_ORDER[stageIndex - 1]),
        target: stageId,
        type: "smoothstep",
        animated: research.currentStage === stage,
        style: {
          stroke: stage === research.currentStage ? "#2563eb" : "rgba(148, 163, 184, 0.72)",
          strokeWidth: stage === research.currentStage ? 2.1 : 1.35,
        },
      });
    }

    taskRows.forEach((row, rowIndex) => {
      const totalWidth = rowWidth(row.length);
      const rowStartX = STAGE_CENTER_X - totalWidth / 2;
      const rowY = stageY + STAGE_NODE_HEIGHT + STAGE_TO_TASK_GAP + rowIndex * (TASK_NODE_HEIGHT + TASK_ROW_GAP);

      row.forEach((task, columnIndex) => {
        const taskId = taskNodeId(task.id);
        nodes.push({
          id: taskId,
          type: "researchTask",
          position: {
            x: rowStartX + columnIndex * (TASK_NODE_WIDTH + TASK_COLUMN_GAP),
            y: rowY,
          },
          selectable: true,
          data: {
            kind: "task",
            task,
          },
        });

        if (!task.dependencies.some((dependencyId) => stageTaskIdSet.has(dependencyId))) {
          edges.push({
            id: `stage:${stage}:${task.id}`,
            source: stageId,
            target: taskId,
            type: "smoothstep",
            animated: research.nextTask?.id === task.id,
            style: {
              stroke: research.nextTask?.id === task.id ? "#2563eb" : "rgba(148, 163, 184, 0.56)",
              strokeWidth: research.nextTask?.id === task.id ? 2 : 1.2,
            },
          });
        }

        task.dependencies.forEach((dependencyId) => {
          edges.push({
            id: `dep:${dependencyId}:${task.id}`,
            source: taskNodeId(dependencyId),
            target: taskId,
            type: "smoothstep",
            animated: research.nextTask?.id === task.id,
            style: {
              stroke: research.nextTask?.id === task.id ? "rgba(37, 99, 235, 0.8)" : "rgba(148, 163, 184, 0.44)",
              strokeDasharray: "4 5",
              strokeWidth: research.nextTask?.id === task.id ? 1.8 : 1.1,
            },
          });
        });
      });
    });

    const blockHeight = STAGE_NODE_HEIGHT + (
      taskRows.length > 0
        ? STAGE_TO_TASK_GAP + taskRows.length * TASK_NODE_HEIGHT + Math.max(0, taskRows.length - 1) * TASK_ROW_GAP
        : 0
    );
    currentTop += blockHeight + STAGE_BLOCK_GAP;

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
