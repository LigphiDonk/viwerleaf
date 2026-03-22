import { describe, expect, it } from "vitest";

import type { ResearchCanvasSnapshot } from "../types";
import {
  buildResearchCanvasGraph,
  defaultResearchSelection,
  selectionToEntity,
  type ResearchStageContainerNode,
  type ResearchTaskNode,
} from "./researchCanvasGraph";

const sampleResearch: ResearchCanvasSnapshot = {
  bootstrap: {
    status: "ready",
    message: "ready",
    hasInstance: true,
    hasTemplates: true,
    hasSkillViews: true,
    hasBrief: true,
    hasTasks: true,
  },
  brief: { topic: "Test" },
  tasks: [
    {
      id: "survey-1",
      title: "Survey",
      description: "Survey",
      status: "done",
      stage: "survey",
      priority: "high",
      dependencies: [],
      taskType: "planning",
      inputsNeeded: [],
      suggestedSkills: ["research-pipeline-planner"],
      nextActionPrompt: "Survey prompt",
      artifactPaths: [],
    },
    {
      id: "publication-1",
      title: "Write",
      description: "Write",
      status: "pending",
      stage: "publication",
      priority: "high",
      dependencies: ["survey-1"],
      taskType: "handoff",
      inputsNeeded: ["claims"],
      suggestedSkills: ["research-paper-handoff"],
      nextActionPrompt: "Write prompt",
      artifactPaths: ["main.tex"],
    },
  ],
  currentStage: "publication",
  nextTask: {
    id: "publication-1",
    title: "Write",
    description: "Write",
    status: "pending",
    stage: "publication",
    priority: "high",
    dependencies: ["survey-1"],
    taskType: "handoff",
    inputsNeeded: ["claims"],
    suggestedSkills: ["research-paper-handoff"],
    nextActionPrompt: "Write prompt",
    artifactPaths: ["main.tex"],
  },
  stageSummaries: [
    {
      stage: "survey",
      label: "Survey",
      description: "Survey",
      status: "complete",
      totalTasks: 1,
      doneTasks: 1,
      artifactCount: 0,
      artifactPaths: [],
      missingInputs: [],
      suggestedSkills: ["research-pipeline-planner"],
      nextTaskId: null,
      taskCounts: { total: 1, pending: 0, inProgress: 0, done: 1, review: 0 },
    },
    {
      stage: "ideation",
      label: "Ideation",
      description: "Ideation",
      status: "queued",
      totalTasks: 0,
      doneTasks: 0,
      artifactCount: 0,
      artifactPaths: [],
      missingInputs: [],
      suggestedSkills: [],
      nextTaskId: null,
      taskCounts: { total: 0, pending: 0, inProgress: 0, done: 0, review: 0 },
    },
    {
      stage: "experiment",
      label: "Experiment",
      description: "Experiment",
      status: "queued",
      totalTasks: 0,
      doneTasks: 0,
      artifactCount: 0,
      artifactPaths: [],
      missingInputs: [],
      suggestedSkills: [],
      nextTaskId: null,
      taskCounts: { total: 0, pending: 0, inProgress: 0, done: 0, review: 0 },
    },
    {
      stage: "publication",
      label: "Publication",
      description: "Publication",
      status: "active",
      totalTasks: 1,
      doneTasks: 0,
      artifactCount: 1,
      artifactPaths: ["main.tex"],
      missingInputs: ["claims"],
      suggestedSkills: ["research-paper-handoff"],
      nextTaskId: "publication-1",
      taskCounts: { total: 1, pending: 1, inProgress: 0, done: 0, review: 0 },
    },
    {
      stage: "promotion",
      label: "Promotion",
      description: "Promotion",
      status: "queued",
      totalTasks: 0,
      doneTasks: 0,
      artifactCount: 0,
      artifactPaths: [],
      missingInputs: [],
      suggestedSkills: [],
      nextTaskId: null,
      taskCounts: { total: 0, pending: 0, inProgress: 0, done: 0, review: 0 },
    },
  ],
  artifactPaths: {
    survey: [],
    ideation: [],
    experiment: [],
    publication: ["main.tex"],
    promotion: [],
  },
  handoffToWriting: true,
  pipelineRoot: ".pipeline",
  instancePath: "instance.json",
  briefTopic: "Test",
  briefGoal: "Goal",
};

describe("research canvas graph", () => {
  it("builds stage container and task nodes for the workflow", () => {
    const graph = buildResearchCanvasGraph(sampleResearch);
    const stageContainer = graph.nodes.find((node): node is ResearchStageContainerNode => node.id === "stage:publication");
    expect(stageContainer).toBeDefined();
    expect(stageContainer?.type).toBe("stageContainer");

    const taskNode = graph.nodes.find((node): node is ResearchTaskNode => node.id === "task:publication-1");
    expect(taskNode).toBeDefined();
    expect(taskNode?.parentId).toBe("stage:publication");

    expect(graph.edges.some((edge) => edge.id === "dep:survey-1:publication-1")).toBe(true);
  });

  it("routes stage entry edges from the stage top handle into the first task top handle", () => {
    const graph = buildResearchCanvasGraph(sampleResearch);
    const stageEntryEdge = graph.edges.find((edge) => edge.id === "stage:publication:publication-1");

    expect(stageEntryEdge).toBeDefined();
    expect(stageEntryEdge?.sourceHandle).toBe("stage-task-entry");
    expect(stageEntryEdge?.targetHandle).toBe("task-flow-in");
  });

  it("defaults selection to the next task", () => {
    expect(defaultResearchSelection(sampleResearch)).toBe("task:publication-1");
  });

  it("resolves task selections back to entities", () => {
    const resolved = selectionToEntity(sampleResearch, "task:publication-1");
    expect(resolved.task?.title).toBe("Write");
  });

  it("spreads sibling tasks into aligned rows without overlap", () => {
    const graph = buildResearchCanvasGraph({
      ...sampleResearch,
      tasks: [
        ...sampleResearch.tasks,
        {
          ...sampleResearch.tasks[0],
          id: "publication-2",
          title: "C",
          stage: "publication",
          dependencies: [],
        },
        {
          ...sampleResearch.tasks[0],
          id: "publication-3",
          title: "A",
          stage: "publication",
          dependencies: [],
        },
        {
          ...sampleResearch.tasks[0],
          id: "publication-4",
          title: "B",
          stage: "publication",
          dependencies: ["publication-3"],
        },
      ],
    });

    const publicationTasks = graph.nodes.filter((node) => node.id.startsWith("task:publication-"));
    const positions = publicationTasks.map((node) => `${node.position.x}:${node.position.y}`);
    expect(new Set(positions).size).toBe(publicationTasks.length);
    expect(Math.max(...publicationTasks.map((node) => node.position.y))).toBeGreaterThan(
      Math.min(...publicationTasks.map((node) => node.position.y)),
    );
  });

  it("collapses stages without generating child task nodes", () => {
    const collapsed = new Set<"survey" | "ideation" | "experiment" | "publication" | "promotion">(["publication"]);
    const graph = buildResearchCanvasGraph(sampleResearch, collapsed);

    /* Container should still exist */
    const container = graph.nodes.find((node): node is ResearchStageContainerNode => node.id === "stage:publication");
    expect(container).toBeDefined();
    expect(container?.data.isCollapsed).toBe(true);

    /* Task node should NOT exist */
    expect(graph.nodes.find((node) => node.id === "task:publication-1")).toBeUndefined();
  });

  it("removes dependency edges that point to collapsed upstream tasks", () => {
    const collapsed = new Set<"survey" | "ideation" | "experiment" | "publication" | "promotion">(["survey"]);
    const graph = buildResearchCanvasGraph(sampleResearch, collapsed);

    expect(graph.nodes.find((node) => node.id === "task:survey-1")).toBeUndefined();
    expect(graph.edges.find((edge) => edge.id === "dep:survey-1:publication-1")).toBeUndefined();
  });

  it("container width is at least CONTAINER_MIN_WIDTH", () => {
    const graph = buildResearchCanvasGraph(sampleResearch);
    const container = graph.nodes.find((node): node is ResearchStageContainerNode => node.id === "stage:survey");
    expect(container).toBeDefined();
    expect(container?.data.containerWidth).toBeGreaterThanOrEqual(960);
  });
});
