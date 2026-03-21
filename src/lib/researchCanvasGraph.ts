import type { Edge, Node } from "@xyflow/react";

import type { ResearchCanvasSnapshot, ResearchStage, ResearchStageSummary, ResearchTask } from "../types";

export interface ResearchStageNodeData extends Record<string, unknown> {
  kind: "stage";
  stage: ResearchStageSummary;
}

export interface ResearchTaskNodeData extends Record<string, unknown> {
  kind: "task";
  task: ResearchTask;
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

const STAGE_X = 540;
const STAGE_Y = 44;
const STAGE_STEP_Y = 290;
const TASK_BRANCH_Y = 146;
const TASK_ROW_GAP = 148;
const TASK_COLUMN_GAP = 296;
const TASKS_PER_ROW = 3;

function stageNodeId(stage: ResearchStage) {
  return `stage:${stage}`;
}

function taskNodeId(taskId: string) {
  return `task:${taskId}`;
}

function buildTaskOffsets(count: number) {
  const rows = Math.max(1, Math.ceil(count / TASKS_PER_ROW));
  const offsets: Array<{ x: number; y: number }> = [];

  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    const rowCount = Math.min(TASKS_PER_ROW, count - rowIndex * TASKS_PER_ROW);
    const startX = -((rowCount - 1) * TASK_COLUMN_GAP) / 2;
    for (let columnIndex = 0; columnIndex < rowCount; columnIndex += 1) {
      offsets.push({
        x: startX + columnIndex * TASK_COLUMN_GAP,
        y: rowIndex * TASK_ROW_GAP,
      });
    }
  }

  return offsets;
}

export function buildResearchCanvasGraph(research: ResearchCanvasSnapshot): {
  nodes: ResearchCanvasNode[];
  edges: Edge[];
} {
  const nodes: ResearchCanvasNode[] = [];
  const edges: Edge[] = [];

  for (const [stageIndex, stage] of STAGE_ORDER.entries()) {
    const summary = research.stageSummaries.find((item) => item.stage === stage);
    if (!summary) {
      continue;
    }

    const stageId = stageNodeId(stage);
    const stageY = STAGE_Y + stageIndex * STAGE_STEP_Y;

    nodes.push({
      id: stageId,
      type: "researchStage",
      position: { x: STAGE_X, y: stageY },
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
      });
    }

    const tasks = research.tasks.filter((task) => task.stage === stage);
    const taskOffsets = buildTaskOffsets(tasks.length);

    tasks.forEach((task, taskIndex) => {
      const offset = taskOffsets[taskIndex] ?? { x: 0, y: taskIndex * TASK_ROW_GAP };
      const taskId = taskNodeId(task.id);
      nodes.push({
        id: taskId,
        type: "researchTask",
        position: {
          x: STAGE_X + offset.x,
          y: stageY + TASK_BRANCH_Y + offset.y,
        },
        selectable: true,
        data: {
          kind: "task",
          task,
        },
      });

      edges.push({
        id: `stage:${stage}:${task.id}`,
        source: stageId,
        target: taskId,
        type: "smoothstep",
        animated: research.nextTask?.id === task.id,
      });

      task.dependencies.forEach((dependencyId) => {
        edges.push({
          id: `dep:${dependencyId}:${task.id}`,
          source: taskNodeId(dependencyId),
          target: taskId,
          type: "smoothstep",
          animated: research.nextTask?.id === task.id,
        });
      });
    });
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
