import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import type {
  AppMenuState,
  AgentTaskContext,
  AgentMessage,
  AgentProfile,
  AgentProfileId,
  AgentRunResult,
  AgentSessionSummary,
  ApplyResearchTaskSuggestionRequest,
  AssetResource,
  CompileEnvironmentStatus,
  CompileResult,
  Diagnostic,
  FigureBriefDraft,
  GeneratedAsset,
  LiteratureAttachment,
  LiteratureCandidate,
  LiteratureItem,
  LiteratureSearchResult,
  ProjectConfig,
  ProjectFile,
  ProjectNode,
  ProviderConfig,
  ResearchCanvasSnapshot,
  ResearchStage,
  ResearchStageSummary,
  ResearchTask,
  ResearchTaskUpdateChanges,
  ResearchTaskPlanOperation,
  SkillManifest,
  SyncLocation,
  WorkspaceSnapshot,
} from "../types";
import { buildFigureSnippet, insertAtLine, summarizeDiagnostics } from "./latex";
import {
  detectProjectFileType,
  isPreviewableFileType,
  isTextFileType,
  mimeTypeForPath,
} from "./workspace";

const projectConfig: ProjectConfig = {
  rootPath: "/Users/donkfeng/Documents/papers/viewerleaf-demo",
  mainTex: "main.tex",
  engine: "xelatex",
  bibTool: "biber",
  autoCompile: false,
  forwardSync: true,
};

const profiles: AgentProfile[] = [
  {
    id: "outline",
    label: "Outline",
    summary: "Generate section structure and section-level claims.",
    stage: "planning",
    providerId: "openai-main",
    model: "gpt-4.1",
    skillIds: ["academic-outline"],
    toolAllowlist: ["read_section", "insert_outline_into_section"],
    outputMode: "outline",
  },
  {
    id: "draft",
    label: "Draft",
    summary: "Expand notes into prose while keeping the paper voice stable.",
    stage: "drafting",
    providerId: "anthropic-main",
    model: "claude-sonnet-4",
    skillIds: ["academic-draft"],
    toolAllowlist: ["read_section", "apply_text_patch"],
    outputMode: "rewrite",
  },
  {
    id: "polish",
    label: "Polish",
    summary: "Tighten academic style and compress repeated phrasing.",
    stage: "revision",
    providerId: "openrouter-lab",
    model: "claude-3.7-sonnet",
    skillIds: ["academic-polish"],
    toolAllowlist: ["read_section", "apply_text_patch"],
    outputMode: "rewrite",
  },
  {
    id: "de_ai",
    label: "De-AI",
    summary: "Remove generic AI rhythms and over-explained transitions.",
    stage: "revision",
    providerId: "openai-main",
    model: "gpt-4.1-mini",
    skillIds: ["academic-de-ai"],
    toolAllowlist: ["read_section", "apply_text_patch"],
    outputMode: "rewrite",
  },
  {
    id: "review",
    label: "Review",
    summary: "Review the argument structure like a hard reviewer.",
    stage: "submission",
    providerId: "anthropic-main",
    model: "claude-sonnet-4",
    skillIds: ["academic-review"],
    toolAllowlist: ["read_section", "search_project"],
    outputMode: "review",
  },
];

const skills: SkillManifest[] = [
  {
    id: "academic-outline",
    name: "Academic Outline",
    version: "1.0.0",
    stages: ["planning"],
    promptFiles: ["outline.md"],
    toolAllowlist: ["read_section", "insert_outline_into_section"],
    enabled: true,
    source: "local",
  },
  {
    id: "academic-polish",
    name: "Academic Polish",
    version: "1.0.0",
    stages: ["drafting", "revision"],
    promptFiles: ["polish.md"],
    toolAllowlist: ["read_section", "apply_text_patch"],
    enabled: true,
    source: "local",
  },
  {
    id: "banana-figure-workflow",
    name: "Banana Figure Workflow",
    version: "1.0.0",
    stages: ["figures"],
    promptFiles: ["figure-brief.md", "banana-payload.md"],
    toolAllowlist: ["create_figure_brief", "run_banana_generation"],
    enabled: true,
    source: "local",
  },
  {
    id: "research-pipeline-planner",
    name: "Research Pipeline Planner",
    version: "1.0.0",
    stages: ["survey", "ideation", "experiment", "publication", "promotion"],
    tools: ["read_file", "write_file"],
    enabled: true,
    source: "builtin",
  },
  {
    id: "research-literature-trace",
    name: "Research Literature Trace",
    version: "1.0.0",
    stages: ["survey", "ideation"],
    tools: ["read_file", "write_file"],
    enabled: true,
    source: "builtin",
  },
  {
    id: "research-experiment-driver",
    name: "Research Experiment Driver",
    version: "1.0.0",
    stages: ["experiment"],
    tools: ["read_file", "write_file", "run_terminal"],
    enabled: false,
    source: "builtin",
  },
  {
    id: "research-paper-handoff",
    name: "Research Paper Handoff",
    version: "1.0.0",
    stages: ["publication", "promotion"],
    tools: ["read_file", "write_file"],
    enabled: false,
    source: "builtin",
  },
];

const providers: ProviderConfig[] = [
  {
    id: "openai-main",
    vendor: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    authRef: "keychain://viewerleaf/openai-main",
    defaultModel: "gpt-4.1",
  },
  {
    id: "anthropic-main",
    vendor: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    authRef: "keychain://viewerleaf/anthropic-main",
    defaultModel: "claude-sonnet-4",
  },
  {
    id: "openrouter-lab",
    vendor: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    authRef: "keychain://viewerleaf/openrouter-lab",
    defaultModel: "claude-3.7-sonnet",
  },
];

const RESEARCH_STAGE_ORDER: ResearchStage[] = [
  "survey",
  "ideation",
  "experiment",
  "publication",
  "promotion",
];

const STAGE_TASK_TEMPLATES: Record<ResearchStage, ResearchTask[]> = {
  survey: [
    {
      id: "survey-1",
      title: "Define the research boundary",
      description: "Clarify topic scope, target venue, and screening criteria.",
      status: "pending",
      stage: "survey",
      priority: "high",
      dependencies: [],
      taskType: "exploration",
      inputsNeeded: ["topic boundary", "target venue"],
      suggestedSkills: ["research-pipeline-planner", "research-literature-trace"],
      nextActionPrompt:
        "Use the research-literature-trace skill to collect traceable literature and map the field boundary.",
      artifactPaths: [".pipeline/docs/domain_map.md", ".pipeline/docs/paper_bank.json"],
      taskPrompt:
        "Define the research boundary, keywords, venue target, and the first traceable literature collection plan.",
      contextNotes: "",
      lastUpdatedAt: "",
      agentEntryLabel: "进入 Agent",
    },
    {
      id: "survey-2",
      title: "Build a traceable literature shortlist",
      description: "Collect real papers, canonical links, and screening notes.",
      status: "pending",
      stage: "survey",
      priority: "high",
      dependencies: ["survey-1"],
      taskType: "analysis",
      inputsNeeded: ["seed query list"],
      suggestedSkills: ["research-literature-trace"],
      nextActionPrompt:
        "Search and screen real literature, then update paper_bank.json with traceable links and concise notes.",
      artifactPaths: [".pipeline/docs/paper_bank.json", ".viewerleaf/research/Survey/reports/screening-notes.md"],
      taskPrompt:
        "Build a traceable shortlist of core papers with links, tags, and screening decisions.",
      contextNotes: "",
      lastUpdatedAt: "",
      agentEntryLabel: "进入 Agent",
    },
  ],
  ideation: [
    {
      id: "ideation-1",
      title: "Generate candidate ideas",
      description: "Turn the survey and gap map into several candidate directions.",
      status: "pending",
      stage: "ideation",
      priority: "high",
      dependencies: ["survey-2"],
      taskType: "analysis",
      inputsNeeded: ["gap summary"],
      suggestedSkills: ["research-pipeline-planner"],
      nextActionPrompt:
        "Generate several candidate ideas from the survey findings and record them in idea_board.json.",
      artifactPaths: [".pipeline/docs/idea_board.json"],
      taskPrompt:
        "Generate candidate ideas from the validated literature gap and make the options concrete.",
      contextNotes: "",
      lastUpdatedAt: "",
      agentEntryLabel: "进入 Agent",
    },
  ],
  experiment: [
    {
      id: "experiment-1",
      title: "Design the experiment plan",
      description: "Define datasets, metrics, ablations, and analysis checkpoints.",
      status: "pending",
      stage: "experiment",
      priority: "high",
      dependencies: ["ideation-1"],
      taskType: "implementation",
      inputsNeeded: ["selected idea"],
      suggestedSkills: ["research-experiment-driver"],
      nextActionPrompt:
        "Use the research-experiment-driver skill to write the implementation and analysis plan.",
      artifactPaths: [".pipeline/docs/experiment_plan.md"],
      taskPrompt:
        "Design the experiment plan with datasets, metrics, baselines, and analysis checkpoints.",
      contextNotes: "",
      lastUpdatedAt: "",
      agentEntryLabel: "进入 Agent",
    },
  ],
  publication: [
    {
      id: "publication-1",
      title: "Draft the paper outline",
      description: "Turn the validated research state into a section plan.",
      status: "pending",
      stage: "publication",
      priority: "high",
      dependencies: ["experiment-1"],
      taskType: "writing",
      inputsNeeded: ["validated claims"],
      suggestedSkills: ["research-paper-handoff"],
      nextActionPrompt:
        "Use the research-paper-handoff skill to map claims and figures into the LaTeX manuscript.",
      artifactPaths: ["main.tex", "sections/introduction.tex", "refs/references.bib"],
      taskPrompt:
        "Draft the paper outline and convert validated claims into a writing checklist.",
      contextNotes: "",
      lastUpdatedAt: "",
      agentEntryLabel: "进入 Agent",
    },
  ],
  promotion: [
    {
      id: "promotion-1",
      title: "Prepare downstream deliverables",
      description: "Create slides or a short summary after the draft is stable.",
      status: "pending",
      stage: "promotion",
      priority: "medium",
      dependencies: ["publication-1"],
      taskType: "delivery",
      inputsNeeded: ["paper draft"],
      suggestedSkills: ["research-paper-handoff"],
      nextActionPrompt:
        "Use the research-paper-handoff skill to prepare slides and summary tasks from the manuscript state.",
      artifactPaths: [".pipeline/docs/promo_plan.md"],
      taskPrompt:
        "Prepare slides, summaries, and release material from the stable manuscript state.",
      contextNotes: "",
      lastUpdatedAt: "",
      agentEntryLabel: "进入 Agent",
    },
  ],
};

const researchTasks: ResearchTask[] = [];
const initializedResearchStages: ResearchStage[] = [];

const researchBrief = {
  topic: "ViewerLeaf Research Canvas",
  goal: "Unify research planning and LaTeX writing.",
  pipeline: {
    startStage: "survey",
    currentStage: "survey",
    initializedStages: initializedResearchStages,
  },
  systemPrompt:
    "You are the shared research agent for ViewerLeaf. Keep the project coherent across survey, ideation, experiment, publication, and promotion.",
  workingMemory:
    "Survey scope is stable. The current bottleneck is sharpening the publishable angle and locking the novelty statement.",
  interactionRules: [
    "Prefer evidence and traceability over speed.",
    "Do not fabricate citations or results.",
    "When a task is active, optimize for that task without losing project context.",
  ],
};

function buildMockResearch(): ResearchCanvasSnapshot {
  const artifactPaths: Record<ResearchStage, string[]> = {
    survey: [".pipeline/docs/domain_map.md", ".pipeline/docs/paper_bank.json"],
    ideation: [".pipeline/docs/idea_board.json"],
    experiment: [],
    publication: ["main.tex", "sections/introduction.tex", "refs/references.bib"],
    promotion: [],
  };

  const nextTask = researchTasks.find((task) => task.status === "in-progress")
    ?? researchTasks.find((task) => task.status === "pending")
    ?? null;
  const currentStage = (nextTask?.stage
    ?? RESEARCH_STAGE_ORDER.find((stage) => !initializedResearchStages.includes(stage))
    ?? researchBrief.pipeline.currentStage) as ResearchStage;

  const stageSummaries: ResearchStageSummary[] = RESEARCH_STAGE_ORDER.map((stage) => {
    const stageTasks = researchTasks.filter((task) => task.stage === stage);
    const doneTasks = stageTasks.filter((task) => task.status === "done").length;
    const inProgressTasks = stageTasks.filter((task) => task.status === "in-progress").length;
    const reviewTasks = stageTasks.filter((task) => task.status === "review").length;
    const pendingTasks = stageTasks.length - doneTasks - inProgressTasks - reviewTasks;
    const bundleSkillIds = Array.from(new Set([
      ...STAGE_TASK_TEMPLATES[stage].flatMap((task) => task.suggestedSkills),
      ...stageTasks.flatMap((task) => task.suggestedSkills),
    ]));
    const isInitialized = initializedResearchStages.includes(stage) || stageTasks.length > 0;
    return {
      stage,
      label: stage[0].toUpperCase() + stage.slice(1),
      description: `Mock ${stage} stage for the browser runtime.`,
      bundleId: stage,
      bundleLabel:
        stage === "survey" ? "领域调研与文献整理" :
          stage === "ideation" ? "Idea 生成" :
            stage === "experiment" ? "实验推进" :
              stage === "publication" ? "论文写作" : "成果传播",
      bundleDescription: `This bundle drives the ${stage} stage and groups the matching research skills.`,
      bundleSkillIds,
      isInitialized,
      canInitialize: !isInitialized && stage === currentStage,
      status:
        doneTasks === stageTasks.length && stageTasks.length > 0
          ? "complete"
          : stage === currentStage
            ? "active"
            : isInitialized
              ? "queued"
              : "idle",
      totalTasks: stageTasks.length,
      doneTasks,
      artifactCount: artifactPaths[stage].length,
      artifactPaths: artifactPaths[stage],
      missingInputs: stageTasks.flatMap((task) => task.inputsNeeded),
      suggestedSkills: bundleSkillIds,
      nextTaskId: stageTasks.find((task) => task.status !== "done")?.id ?? null,
      taskCounts: {
        total: stageTasks.length,
        pending: pendingTasks,
        inProgress: inProgressTasks,
        done: doneTasks,
        review: reviewTasks,
      },
    };
  });

  return {
    bootstrap: {
      status: "ready",
      message: "Mock research workflow is ready.",
      hasInstance: true,
      hasTemplates: true,
      hasSkillViews: true,
      hasBrief: true,
      hasTasks: true,
    },
    brief: {
      ...researchBrief,
      pipeline: {
        ...researchBrief.pipeline,
        currentStage,
      },
    },
    tasks: structuredClone(researchTasks),
    currentStage,
    initializedStages: structuredClone(initializedResearchStages),
    nextTask,
    stageSummaries,
    artifactPaths,
    handoffToWriting: currentStage === "publication",
    pipelineRoot: ".pipeline",
    instancePath: "instance.json",
    briefTopic: "ViewerLeaf Research Canvas",
    briefGoal: "Unify research planning and LaTeX writing.",
    systemPrompt: researchBrief.systemPrompt,
    workingMemory: researchBrief.workingMemory,
  };
}

const files: ProjectFile[] = [
  {
    path: "main.tex",
    language: "latex",
    content: `\\documentclass[11pt]{article}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{hyperref}
\\usepackage{xeCJK}
\\usepackage{biblatex}
\\addbibresource{refs/references.bib}
\\title{ViewerLeaf Demo Paper}
\\author{Donk Feng}
\\begin{document}
\\maketitle
\\input{sections/abstract}
\\input{sections/introduction}
\\input{sections/method}
\\input{sections/experiments}
\\printbibliography
\\end{document}`,
  },
  {
    path: "sections/abstract.tex",
    language: "latex",
    content: `\\begin{abstract}
We present ViewerLeaf, a local-first academic writing workbench that unifies LaTeX editing, synchronized preview, and agent-guided revision into a single macOS desktop environment.
\\end{abstract}`,
  },
  {
    path: "sections/introduction.tex",
    language: "latex",
    content: `\\section{Introduction}
Academic writing often fragments across editors, model clients, prompt notebooks, and image tools. This fragmentation increases latency between intent and revision.

\\subsection{Problem Statement}
Researchers need a single space where drafting, compiling, reviewing, and figure ideation stay attached to the same project context.

\\subsection{Contribution}
ViewerLeaf consolidates source editing, synchronized PDF feedback, provider-aware agents, and on-demand figure generation for paper workflows.`,
  },
  {
    path: "sections/method.tex",
    language: "latex",
    content: `\\section{Method}
Our system is organized into four layers: workspace shell, compile and SyncTeX services, agent runtime, and figure workspace.

\\subsection{Workspace Shell}
The shell keeps source, preview, and logs visible at once.

\\subsection{Agent Runtime}
Profiles select different skills and provider defaults depending on the current writing phase.`,
  },
  {
    path: "sections/experiments.tex",
    language: "latex",
    content: `\\section{Experiments}
We evaluate three scenarios: single-file papers, multi-file projects, and Chinese templates compiled with xelatex.

\\subsection{Main Result}
The integrated workflow reduces context switching and preserves revision locality across all three scenarios.`,
  },
  {
    path: "refs/references.bib",
    language: "bib",
    content: `@article{knuth1984texbook,
  title={The TeXbook},
  author={Knuth, Donald E},
  journal={Computers \\\\& Typesetting},
  year={1984}
}`,
  },
  {
    path: ".viewerleaf/project.json",
    language: "json",
    content: JSON.stringify(projectConfig, null, 2),
  },
];

const fixtureAssets: Array<{ path: string; resourceUrl: string; mimeType: string }> = [
  {
    path: "assets/figures/workflow-overview.svg",
    resourceUrl: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720">
        <rect width="1200" height="720" fill="#f5efe4"/>
        <rect x="64" y="74" width="1072" height="572" rx="30" fill="#fffaf2" stroke="#c7b08a" stroke-width="4"/>
        <text x="110" y="150" font-size="36" font-family="Georgia, serif" fill="#33281f">ViewerLeaf Workflow</text>
        <g font-family="Menlo, monospace" font-size="22">
          <rect x="112" y="240" width="220" height="112" rx="20" fill="#efe2ce"/>
          <text x="145" y="305" fill="#5c4934">LaTeX Editing</text>
          <rect x="390" y="240" width="220" height="112" rx="20" fill="#dfece1"/>
          <text x="440" y="305" fill="#345241">Compile</text>
          <rect x="668" y="240" width="220" height="112" rx="20" fill="#e8dfcf"/>
          <text x="718" y="305" fill="#4b4032">Agent Review</text>
          <rect x="946" y="240" width="140" height="112" rx="20" fill="#efe7da"/>
          <text x="980" y="305" fill="#5f4f40">Figures</text>
        </g>
        <g stroke="#b38b53" stroke-width="8" fill="none" stroke-linecap="round">
          <path d="M332 296 H390"/>
          <path d="M610 296 H668"/>
          <path d="M888 296 H946"/>
        </g>
      </svg>`,
    )}`,
    mimeType: "image/svg+xml",
  },
];

let activeFile = "sections/introduction.tex";
let compileCounter = 0;
const figureBriefs: FigureBriefDraft[] = [];
const assets: GeneratedAsset[] = [];
const literatureItems: LiteratureItem[] = [];
const literatureInbox: LiteratureCandidate[] = [];
const literatureAttachments: LiteratureAttachment[] = [];
const literatureChunks: Array<{ literatureId: string; chunkIndex: number; content: string }> = [];
const agentSessions: AgentSessionSummary[] = [];
const agentMessages: AgentMessage[] = [
  {
    id: "msg-system",
    role: "system",
    profileId: "outline",
    content: "ViewerLeaf academic runtime is ready. Choose a profile and run a scoped action.",
    timestamp: new Date().toISOString(),
  },
];
let lastCompile: CompileResult = {
  status: "idle",
  diagnostics: [],
  logPath: ".viewerleaf/logs/latest.log",
  logOutput: "Compile service is idle.",
  timestamp: new Date().toISOString(),
};

function syncProjectConfigFile() {
  const configFile = getFile(".viewerleaf/project.json");
  if (configFile) {
    configFile.content = JSON.stringify(projectConfig, null, 2);
  }
}

function computeLiteratureDedupHash(title: string, year: number) {
  const normalized = title
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "");
  return `${normalized}:${year}`;
}

function buildLiteratureItem(item: LiteratureItem): LiteratureItem {
  return {
    ...item,
    dedupHash: item.dedupHash || computeLiteratureDedupHash(item.title, item.year),
    addedAt: item.addedAt || new Date().toISOString(),
    updatedAt: item.updatedAt || new Date().toISOString(),
  };
}

function checkMockLiteratureDedup(candidate: Pick<LiteratureCandidate, "doi" | "title" | "year">) {
  if (candidate.doi.trim()) {
    const byDoi = literatureItems.find((item) => item.doi === candidate.doi);
    if (byDoi) return byDoi.id;
  }

  const hash = computeLiteratureDedupHash(candidate.title, candidate.year);
  return literatureItems.find((item) => item.dedupHash === hash)?.id ?? "";
}

function buildMockSearchResults(query: string): LiteratureSearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const results: LiteratureSearchResult[] = [];
  for (const item of literatureItems) {
    const authors = item.authors.join(", ");
    let matchField: LiteratureSearchResult["matchField"] | null = null;
    let snippet = "";
    let chunkIndex: number | undefined;

    if (item.title.toLowerCase().includes(needle)) {
      matchField = "title";
      snippet = item.title;
    } else if (authors.toLowerCase().includes(needle)) {
      matchField = "authors";
      snippet = authors;
    } else if (item.abstract.toLowerCase().includes(needle)) {
      matchField = "abstract";
      snippet = item.abstract.slice(0, 160);
    } else if (item.notes.toLowerCase().includes(needle)) {
      matchField = "notes";
      snippet = item.notes.slice(0, 160);
    } else {
      const chunk = literatureChunks.find(
        (entry) =>
          entry.literatureId === item.id && entry.content.toLowerCase().includes(needle),
      );
      if (chunk) {
        matchField = "chunk";
        snippet = chunk.content.slice(0, 160);
        chunkIndex = chunk.chunkIndex;
      }
    }

    if (!matchField) continue;
    results.push({
      item: structuredClone(item),
      matchField,
      snippet,
      chunkIndex,
      rank: results.length,
    });
  }

  return results;
}

function getFile(path: string) {
  return files.find((item) => item.path === path);
}

function detectLanguage(path: string): ProjectFile["language"] {
  const fileType = detectProjectFileType(path);
  switch (fileType) {
    case "latex":
      return "latex";
    case "bib":
      return "bib";
    case "json":
      return "json";
    default:
      return "text";
  }
}

function buildNodeMeta(path: string) {
  const fileType = detectProjectFileType(path);
  return {
    fileType,
    isText: isTextFileType(fileType),
    isPreviewable: isPreviewableFileType(fileType),
  };
}

function listAncestorDirectories(path: string) {
  const parts = path.split("/");
  const directories: string[] = [];

  for (let index = 1; index < parts.length; index += 1) {
    directories.push(parts.slice(0, index).join("/"));
  }

  return directories;
}

type TreeEntry = { path: string; kind: ProjectNode["kind"] };

function buildTree(entries: TreeEntry[]) {
  const root: ProjectNode = {
    id: "root",
    name: "viewerleaf-demo",
    path: ".",
    kind: "directory",
    children: [],
  };

  for (const entry of entries) {
    const parts = entry.path.split("/");
    let current = root;
    parts.forEach((part, index) => {
      const joined = parts.slice(0, index + 1).join("/");
      const isLeaf = index === parts.length - 1;
      let child = current.children?.find((node) => node.path === joined);
      if (!child) {
        const nodeMeta = isLeaf && entry.kind !== "directory" ? buildNodeMeta(entry.path) : undefined;
        const kind = isLeaf ? entry.kind : "directory";
        child = {
          id: joined,
          name: part,
          path: joined,
          kind,
          fileType: nodeMeta?.fileType,
          isText: nodeMeta?.isText,
          isPreviewable: nodeMeta?.isPreviewable,
          children: kind === "directory" ? [] : undefined,
        };
        current.children?.push(child);
      }
      current = child;
    });
  }

  const sortNodes = (nodes?: ProjectNode[]) => {
    nodes?.sort((left, right) => {
      if (left.kind === right.kind) {
        return left.name.localeCompare(right.name);
      }
      return left.kind === "directory" ? -1 : 1;
    });
    nodes?.forEach((node) => sortNodes(node.children));
  };

  sortNodes(root.children);
  return root.children ?? [];
}

const virtualDirectories = new Set<string>();

function listTreeEntries(): TreeEntry[] {
  const entries = new Map<string, TreeEntry>();

  for (const path of virtualDirectories) {
    entries.set(path, { path, kind: "directory" });
  }

  for (const file of files) {
    entries.set(file.path, { path: file.path, kind: buildNodeMeta(file.path).isText ? "file" : "asset" });
  }

  for (const asset of fixtureAssets) {
    entries.set(asset.path, { path: asset.path, kind: "asset" });
  }

  for (const asset of assets) {
    entries.set(asset.filePath, { path: asset.filePath, kind: "asset" });
  }

  return Array.from(entries.values());
}

function hasPath(path: string) {
  return (
    virtualDirectories.has(path) ||
    files.some((item) => item.path === path) ||
    fixtureAssets.some((item) => item.path === path) ||
    assets.some((item) => item.filePath === path)
  );
}

function replacePathPrefix(path: string, from: string, to: string) {
  if (path === from) {
    return to;
  }
  const prefix = `${from}/`;
  return path.startsWith(prefix) ? `${to}/${path.slice(prefix.length)}` : path;
}

async function generatePreviewPdf(snapshotName: string, diagnostics: Diagnostic[]) {
  const pdf = await PDFDocument.create();
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const mono = await pdf.embedFont(StandardFonts.Courier);

  const page1 = pdf.addPage([595, 842]);
  page1.drawRectangle({ x: 48, y: 68, width: 499, height: 706, borderColor: rgb(0.68, 0.56, 0.37), borderWidth: 1 });
  page1.drawText("ViewerLeaf Build Preview", {
    x: 72,
    y: 760,
    size: 22,
    font: serif,
    color: rgb(0.2, 0.18, 0.16),
  });
  page1.drawText(snapshotName, {
    x: 72,
    y: 728,
    size: 13,
    font: mono,
    color: rgb(0.43, 0.34, 0.24),
  });
  page1.drawText("Synchronized preview mirrors the current compile snapshot.", {
    x: 72,
    y: 688,
    size: 14,
    font: serif,
    color: rgb(0.25, 0.24, 0.2),
  });
  page1.drawText("Page 1: build overview", {
    x: 72,
    y: 640,
    size: 12,
    font: mono,
    color: rgb(0.5, 0.38, 0.24),
  });

  const page2 = pdf.addPage([595, 842]);
  page2.drawText("Diagnostics", {
    x: 72,
    y: 760,
    size: 22,
    font: serif,
    color: rgb(0.2, 0.18, 0.16),
  });

  const lines = diagnostics.length
    ? diagnostics.map((item) => `${item.filePath}:${item.line} [${item.level}] ${item.message}`)
    : ["No diagnostics. The project compiled cleanly."];

  lines.forEach((line, index) => {
    page2.drawText(line, {
      x: 72,
      y: 716 - index * 22,
      size: 11,
      font: mono,
      color: rgb(0.28, 0.26, 0.23),
    });
  });

  return pdf.save();
}

function buildDiagnostics(file: ProjectFile) {
  const diagnostics: Diagnostic[] = [];
  if (file.content.includes("TODO")) {
    diagnostics.push({
      filePath: file.path,
      line: file.content.split("\n").findIndex((line) => line.includes("TODO")) + 1,
      level: "warning",
      message: "Draft placeholder still present.",
    });
  }
  if (file.content.includes("\\cite{missing-ref}")) {
    diagnostics.push({
      filePath: file.path,
      line: file.content.split("\n").findIndex((line) => line.includes("\\cite{missing-ref}")) + 1,
      level: "error",
      message: "Missing bibliography entry for missing-ref.",
    });
  }
  return diagnostics;
}

function createRunSummary(profileId: AgentProfileId, selection: string) {
  switch (profileId) {
    case "outline":
      return [
        "\\subsection{Research Questions}",
        "We decompose the paper into research questions, constraints, and evaluation claims.",
        "",
        "\\subsection{Threats to Validity}",
        "We analyze limits introduced by local-only compile and evaluation coverage.",
      ].join("\n");
    case "draft":
      return `The current note is expanded into a tighter paragraph that moves from motivation to mechanism. Source anchor: ${selection.slice(0, 80) || "current section"}.`;
    case "polish":
      return "This revision shortens repeated transitions, removes marketing-style adjectives, and sharpens claims into observable statements.";
    case "de_ai":
      return "The rewrite removes generic framing, hedged filler, and repetitive sentence cadence to sound closer to human academic prose.";
    case "review":
      return [
        "1. The contribution statement is still broader than the evaluation section proves.",
        "2. The method section should define the figure workflow boundary more clearly.",
        "3. Add at least one failure case for compile-time diagnostics.",
      ].join("\n");
  }
}

function applyTaskChanges(task: ResearchTask, changes: ResearchTaskUpdateChanges) {
  if (changes.title) task.title = changes.title;
  if (changes.status) task.status = changes.status;
  if (changes.stage) task.stage = changes.stage;
  if (changes.priority) task.priority = changes.priority;
  if (changes.dependencies) task.dependencies = Array.from(new Set(changes.dependencies));
  if (changes.taskType) task.taskType = changes.taskType;
  if (changes.description) task.description = changes.description;
  if (changes.inputsNeeded) task.inputsNeeded = Array.from(new Set(changes.inputsNeeded));
  if (changes.artifactPaths) task.artifactPaths = Array.from(new Set(changes.artifactPaths));
  if (changes.suggestedSkills) task.suggestedSkills = Array.from(new Set(changes.suggestedSkills));
  if (changes.nextActionPrompt) task.nextActionPrompt = changes.nextActionPrompt;
  if (changes.contextNotes) task.contextNotes = changes.contextNotes;
  if (changes.taskPrompt) task.taskPrompt = changes.taskPrompt;
  if (changes.agentEntryLabel) task.agentEntryLabel = changes.agentEntryLabel;
  task.lastUpdatedAt = new Date().toISOString();
}

function nextMockTaskId(stage: ResearchStage) {
  let suffix = 1;
  while (researchTasks.some((task) => task.id === `${stage}-custom-${suffix}`)) {
    suffix += 1;
  }
  return `${stage}-custom-${suffix}`;
}

function normalizeSuggestionOperations(request: ApplyResearchTaskSuggestionRequest): ResearchTaskPlanOperation[] {
  if (request.operations?.length) {
    return request.operations;
  }
  if (request.taskId && request.changes) {
    return [{ type: "update", taskId: request.taskId, changes: request.changes }];
  }
  return [];
}

function sortMockResearchTasks() {
  researchTasks.sort((left, right) =>
    RESEARCH_STAGE_ORDER.indexOf(left.stage) - RESEARCH_STAGE_ORDER.indexOf(right.stage)
      || left.title.localeCompare(right.title, "zh-CN"),
  );
}

export const mockRuntime = {
  async getAppVersion() {
    return "0.1.0";
  },

  async openProject(): Promise<WorkspaceSnapshot> {
    const tree = buildTree(listTreeEntries());
    return {
      projectConfig,
      tree,
      files: [],
      activeFile,
      providers: structuredClone(providers),
      skills: structuredClone(skills),
      profiles: structuredClone(profiles),
      compileResult: structuredClone(lastCompile),
      figureBriefs: structuredClone(figureBriefs),
      assets: structuredClone(assets),
      research: buildMockResearch(),
    };
  },

  async switchProject(rootPath: string): Promise<WorkspaceSnapshot> {
    projectConfig.rootPath = rootPath;
    syncProjectConfigFile();
    return this.openProject();
  },

  async createProject(parentDir: string, projectName: string): Promise<WorkspaceSnapshot> {
    projectConfig.rootPath = `${parentDir}/${projectName}`;
    syncProjectConfigFile();
    return this.openProject();
  },

  async ensureResearchScaffold(_startStage?: string): Promise<WorkspaceSnapshot> {
    researchTasks.splice(0, researchTasks.length);
    initializedResearchStages.splice(0, initializedResearchStages.length);
    researchBrief.pipeline.currentStage = "survey";
    return this.openProject();
  },

  async initializeResearchStage(stage: ResearchStage): Promise<WorkspaceSnapshot> {
    if (!initializedResearchStages.includes(stage)) {
      initializedResearchStages.push(stage);
    }
    if (!researchTasks.some((task) => task.stage === stage)) {
      researchTasks.push(...structuredClone(STAGE_TASK_TEMPLATES[stage]));
    }
    researchBrief.pipeline.currentStage = stage;
    return this.openProject();
  },

  async launchWorkspaceWindow(_rootPath?: string) {
    return { ok: true };
  },

  async syncAppMenu(_state: AppMenuState) {
    return { ok: true };
  },

  async setWindowTitle(_title: string) {
    return { ok: true };
  },

  async readFile(path: string) {
    const file = getFile(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    return structuredClone(file);
  },

  async readAsset(path: string): Promise<AssetResource> {
    const generatedAsset = assets.find((item) => item.filePath === path);
    if (generatedAsset) {
      return {
        path,
        absolutePath: `${projectConfig.rootPath}/${path}`,
        resourceUrl: generatedAsset.previewUri,
        mimeType: mimeTypeForPath(path),
      };
    }

    const fixtureAsset = fixtureAssets.find((item) => item.path === path);
    if (fixtureAsset) {
      return {
        path,
        absolutePath: `${projectConfig.rootPath}/${path}`,
        resourceUrl: fixtureAsset.resourceUrl,
        mimeType: fixtureAsset.mimeType,
      };
    }

    if (path.endsWith(".pdf")) {
      const pdfData = lastCompile.pdfData ?? (await generatePreviewPdf(path, []));
      const blob = new Blob([Uint8Array.from(pdfData)], {
        type: "application/pdf",
      });
      return {
        path,
        absolutePath: `${projectConfig.rootPath}/${path}`,
        resourceUrl: URL.createObjectURL(blob),
        mimeType: "application/pdf",
      };
    }

    throw new Error(`Asset not found: ${path}`);
  },

  async saveFile(filePath: string, content: string) {
    const file = getFile(filePath);
    if (file) {
      file.content = content;
      file.language = detectLanguage(filePath);
    } else {
      if (hasPath(filePath)) {
        throw new Error(`Path is not a writable file: ${filePath}`);
      }
      for (const dir of listAncestorDirectories(filePath)) {
        virtualDirectories.delete(dir);
      }
      files.push({
        path: filePath,
        language: detectLanguage(filePath),
        content,
      });
      files.sort((left, right) => left.path.localeCompare(right.path));
    }
    activeFile = filePath;
    return { ok: true };
  },

  async updateProjectConfig(config: ProjectConfig) {
    Object.assign(projectConfig, config);
    syncProjectConfigFile();
    return structuredClone(projectConfig);
  },

  async listLiterature() {
    return structuredClone(literatureItems);
  },

  async listLiteratureInbox() {
    return structuredClone(literatureInbox);
  },

  async listLiteratureAttachments(literatureId: string) {
    return structuredClone(
      literatureAttachments.filter((attachment) => attachment.literatureId === literatureId),
    );
  },

  async addLiterature(item: LiteratureItem) {
    literatureItems.unshift(buildLiteratureItem(item));
  },

  async addLiteratureWithPdf(item: LiteratureItem, sourcePath: string) {
    const nextItem = buildLiteratureItem(item);
    literatureItems.unshift(nextItem);
    literatureAttachments.push({
      id: crypto.randomUUID(),
      literatureId: nextItem.id,
      kind: "pdf",
      filePath: sourcePath || `.viewerleaf/literature/pdfs/${nextItem.id}.pdf`,
      ocrStatus: "none",
      source: "manual",
      createdAt: new Date().toISOString(),
    });
    return structuredClone(nextItem);
  },

  async addLiteratureCandidate(candidate: LiteratureCandidate) {
    const matchedItemId = checkMockLiteratureDedup(candidate);
    literatureInbox.unshift({
      ...candidate,
      dedupStatus: matchedItemId ? "duplicate" : "unique",
      matchedItemId,
      createdAt: candidate.createdAt || new Date().toISOString(),
    });
  },

  async deleteLiterature(id: string) {
    const itemIndex = literatureItems.findIndex((item) => item.id === id);
    if (itemIndex >= 0) {
      literatureItems.splice(itemIndex, 1);
    }

    for (let index = literatureAttachments.length - 1; index >= 0; index -= 1) {
      if (literatureAttachments[index].literatureId === id) {
        literatureAttachments.splice(index, 1);
      }
    }
  },

  async approveLiteratureCandidate(inboxId: string) {
    const inboxIndex = literatureInbox.findIndex((item) => item.id === inboxId);
    if (inboxIndex < 0) {
      throw new Error(`Inbox item not found: ${inboxId}`);
    }

    const candidate = literatureInbox[inboxIndex];
    literatureInbox.splice(inboxIndex, 1);

    if (candidate.dedupStatus === "duplicate" && candidate.matchedItemId) {
      const existing = literatureItems.find((item) => item.id === candidate.matchedItemId);
      if (existing) {
        if (!existing.doi && candidate.doi) existing.doi = candidate.doi;
        if (!existing.abstract && candidate.abstract) existing.abstract = candidate.abstract;
        if (existing.authors.length === 0 && candidate.authors.length > 0) {
          existing.authors = [...candidate.authors];
        }
        existing.updatedAt = new Date().toISOString();
        return structuredClone(existing);
      }
    }

    const nextItem = buildLiteratureItem({
      id: crypto.randomUUID(),
      title: candidate.title,
      authors: [...candidate.authors],
      year: candidate.year,
      journal: "",
      doi: candidate.doi,
      abstract: candidate.abstract,
      tags: [],
      notes: "",
      dedupHash: "",
      linkedTaskIds: [],
      addedAt: "",
      updatedAt: "",
    });
    literatureItems.unshift(nextItem);
    if (candidate.pdfPath) {
      literatureAttachments.push({
        id: crypto.randomUUID(),
        literatureId: nextItem.id,
        kind: "pdf",
        filePath: candidate.pdfPath,
        ocrStatus: "none",
        source: "manual",
        createdAt: new Date().toISOString(),
      });
    }
    return structuredClone(nextItem);
  },

  async updateLiteratureNotes(id: string, notes: string) {
    const item = literatureItems.find((entry) => entry.id === id);
    if (item) {
      item.notes = notes;
      item.updatedAt = new Date().toISOString();
    }
  },

  async searchLiterature(query: string) {
    return buildMockSearchResults(query);
  },

  async linkLiteratureToTask(literatureId: string, taskId: string) {
    const item = literatureItems.find((entry) => entry.id === literatureId);
    if (item && !item.linkedTaskIds.includes(taskId)) {
      item.linkedTaskIds.push(taskId);
      item.updatedAt = new Date().toISOString();
    }
  },

  async ingestLiterature(literatureId: string, pdfPath: string, title: string) {
    const markdownPath = `.viewerleaf/literature/markdown/${literatureId}.md`;
    const chunkContent = `# ${title || "Untitled"}\n\nIndexed from ${pdfPath}`;

    const existingChunkIndex = literatureChunks.findIndex((chunk) => chunk.literatureId === literatureId);
    if (existingChunkIndex >= 0) {
      literatureChunks.splice(existingChunkIndex, 1, {
        literatureId,
        chunkIndex: 0,
        content: chunkContent,
      });
    } else {
      literatureChunks.push({
        literatureId,
        chunkIndex: 0,
        content: chunkContent,
      });
    }

    const pdfAttachment = literatureAttachments.find(
      (attachment) => attachment.literatureId === literatureId && attachment.kind === "pdf",
    );
    if (pdfAttachment) {
      pdfAttachment.ocrStatus = "none";
    }

    const markdownAttachment = literatureAttachments.find(
      (attachment) => attachment.literatureId === literatureId && attachment.kind === "markdown",
    );
    if (markdownAttachment) {
      markdownAttachment.filePath = markdownPath;
      markdownAttachment.ocrStatus = "none";
      markdownAttachment.source = "manual";
    } else {
      literatureAttachments.push({
        id: crypto.randomUUID(),
        literatureId,
        kind: "markdown",
        filePath: markdownPath,
        ocrStatus: "none",
        source: "manual",
        createdAt: new Date().toISOString(),
      });
    }

    return {
      literatureId,
      markdownPath,
      chunks: [{ chunkIndex: 0, content: chunkContent }],
      ocrUsed: false,
      ocrStatus: "none",
    };
  },

  async exportPaperBank() {
    return {
      papers: literatureItems.map((item) => ({
        id: item.id,
        title: item.title,
        authors: item.authors,
        year: item.year,
        journal: item.journal,
        doi: item.doi,
        abstract: item.abstract,
        tags: item.tags,
        linkedTaskIds: item.linkedTaskIds,
      })),
    };
  },

  async countLiteratureForTask(taskId: string) {
    return literatureItems.filter((item) => item.linkedTaskIds.includes(taskId)).length;
  },

  async createFile(path: string, content: string) {
    if (hasPath(path)) {
      throw new Error(`File already exists: ${path}`);
    }
    for (const dir of listAncestorDirectories(path)) {
      virtualDirectories.delete(dir);
    }
    files.push({
      path,
      language: detectLanguage(path),
      content,
    });
    files.sort((left, right) => left.path.localeCompare(right.path));
    activeFile = path;
  },

  async createFolder(path: string) {
    if (hasPath(path)) {
      throw new Error(`Path already exists: ${path}`);
    }
    virtualDirectories.add(path);
  },

  async deleteFile(path: string) {
    const prefix = `${path}/`;
    const nextFiles = files.filter((item) => item.path !== path && !item.path.startsWith(prefix));
    const nextGeneratedAssets = assets.filter(
      (item) => item.filePath !== path && !item.filePath.startsWith(prefix),
    );
    const nextFixtureAssets = fixtureAssets.filter(
      (item) => item.path !== path && !item.path.startsWith(prefix),
    );

    if (
      nextFiles.length === files.length &&
      nextGeneratedAssets.length === assets.length &&
      nextFixtureAssets.length === fixtureAssets.length &&
      !virtualDirectories.has(path)
    ) {
      throw new Error(`Path not found: ${path}`);
    }

    files.splice(0, files.length, ...nextFiles);
    assets.splice(0, assets.length, ...nextGeneratedAssets);
    fixtureAssets.splice(0, fixtureAssets.length, ...nextFixtureAssets);

    for (const dir of Array.from(virtualDirectories)) {
      if (dir === path || dir.startsWith(prefix)) {
        virtualDirectories.delete(dir);
      }
    }

    if (activeFile === path || activeFile.startsWith(prefix)) {
      activeFile = files[0]?.path ?? "main.tex";
    }
  },

  async renameFile(oldPath: string, newPath: string) {
    if (!hasPath(oldPath)) {
      throw new Error(`Path not found: ${oldPath}`);
    }

    for (const file of files) {
      if (file.path === oldPath || file.path.startsWith(`${oldPath}/`)) {
        file.path = replacePathPrefix(file.path, oldPath, newPath);
        file.language = detectLanguage(file.path);
      }
    }

    for (const asset of fixtureAssets) {
      if (asset.path === oldPath || asset.path.startsWith(`${oldPath}/`)) {
        asset.path = replacePathPrefix(asset.path, oldPath, newPath);
      }
    }

    for (const asset of assets) {
      if (asset.filePath === oldPath || asset.filePath.startsWith(`${oldPath}/`)) {
        asset.filePath = replacePathPrefix(asset.filePath, oldPath, newPath);
      }
    }

    const nextDirectories = new Set<string>();
    for (const dir of virtualDirectories) {
      if (dir === oldPath || dir.startsWith(`${oldPath}/`)) {
        nextDirectories.add(replacePathPrefix(dir, oldPath, newPath));
      } else {
        nextDirectories.add(dir);
      }
    }
    virtualDirectories.clear();
    for (const dir of nextDirectories) {
      virtualDirectories.add(dir);
    }

    if (activeFile === oldPath || activeFile.startsWith(`${oldPath}/`)) {
      activeFile = replacePathPrefix(activeFile, oldPath, newPath);
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
  },

  async compileProject(filePath: string): Promise<CompileResult> {
    compileCounter += 1;
    const file = getFile(filePath) ?? files[0];
    const diagnostics = buildDiagnostics(file);
    const pdfData = await generatePreviewPdf(
      `Compile #${compileCounter} - ${projectConfig.mainTex}`,
      diagnostics,
    );
    const status = diagnostics.some((item) => item.level === "error") ? "failed" : "success";
    const logOutput = [
      `latexmk -${projectConfig.engine} -synctex=1 -interaction=nonstopmode -file-line-error ${projectConfig.mainTex}`,
      status === "success" ? "Output written on main.pdf (2 pages)." : "Compilation finished with recoverable errors.",
      summarizeDiagnostics(diagnostics),
    ].join("\n");

    lastCompile = {
      status,
      pdfData,
      pdfPath: `${projectConfig.rootPath}/main.pdf`,
      synctexPath: `${projectConfig.rootPath}/main.synctex.gz`,
      diagnostics,
      logPath: `${projectConfig.rootPath}/.viewerleaf/logs/compile-${compileCounter}.log`,
      logOutput,
      timestamp: new Date().toISOString(),
    };

    return structuredClone(lastCompile);
  },

  async getCompileEnvironment(): Promise<CompileEnvironmentStatus> {
    return {
      ready: true,
      latexmkAvailable: true,
      synctexAvailable: true,
      availableEngines: ["pdflatex", "xelatex", "lualatex"],
      missingTools: [],
    };
  },

  async forwardSearch(filePath: string, line: number, column = 1): Promise<SyncLocation> {
    const page = Math.max(1, Math.ceil(line / 20));
    return {
      filePath,
      line,
      column,
      page,
      highlights: [
        {
          page,
          h: 72 + Math.max(0, column - 1) * 3.6,
          v: 720 - ((line - 1) % 20) * 24,
          width: 280,
          height: 14,
        },
      ],
    };
  },

  async reverseSearch(page: number, _h?: number, _v?: number): Promise<SyncLocation> {
    return {
      filePath: projectConfig.mainTex,
      line: (page - 1) * 20 + 1,
      column: 1,
      page,
      highlights: [],
    };
  },

  async runAgent(
    profileId: AgentProfileId,
    filePath: string,
    selectedText: string,
    userMessage?: string,
    sessionId?: string,
    taskMode?: boolean,
    taskContext?: AgentTaskContext | null,
  ): Promise<AgentRunResult> {
    const resolvedSessionId = ensureSession(profileId, sessionId, userMessage || selectedText || `Run agent on ${filePath}`);
    const userContent = userMessage?.trim() || selectedText.trim() || `Run agent on ${filePath}`;
    agentMessages.push({
      id: crypto.randomUUID(),
      role: "user",
      profileId,
      sessionId: resolvedSessionId,
      content: userContent,
      timestamp: new Date().toISOString(),
    });

    const taskUpdateBlock = taskMode && taskContext
      ? `\n\n\`\`\`viewerleaf_task_update\n${JSON.stringify({
        taskId: taskContext.taskId,
        reason: `Advance the ${taskContext.title} task based on the latest discussion.`,
        confidence: 0.82,
        changes: {
          status: "in-progress",
          contextNotes: `Mock update for ${taskContext.title}.`,
          nextActionPrompt: taskContext.nextActionPrompt || taskContext.taskPrompt || taskContext.description,
        },
        workingMemory: `Working on ${taskContext.title} in the ${taskContext.stage} stage.`,
      }, null, 2)}\n\`\`\``
      : "";
    const summary = `${createRunSummary(profileId, selectedText)}${taskUpdateBlock}`;
    const message: AgentMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      profileId,
      sessionId: resolvedSessionId,
      content: summary ?? "",
      timestamp: new Date().toISOString(),
    };

    agentMessages.push(message);
    touchSession(resolvedSessionId, summary ?? "");

    if (profileId === "review") {
      return { message, sessionId: resolvedSessionId };
    }

    const file = getFile(filePath) ?? files[0];
    const suggestedContent =
      profileId === "outline"
        ? `${file.content}\n\n${summary}`
        : `${file.content}\n\n% ${profiles.find((item) => item.id === profileId)?.label} patch\n${summary}`;

    return {
      sessionId: resolvedSessionId,
      message,
      suggestedPatch: {
        filePath,
        content: suggestedContent,
        summary: `${profiles.find((item) => item.id === profileId)?.label} patch is ready to apply.`,
      },
    };
  },

  async applyAgentPatch(filePath: string, content: string) {
    const file = getFile(filePath);
    if (file) {
      file.content = content;
    }
    return { ok: true };
  },

  async applyResearchTaskSuggestion(request: ApplyResearchTaskSuggestionRequest) {
    for (const operation of normalizeSuggestionOperations(request)) {
      if (operation.type === "update") {
        const task = researchTasks.find((item) => item.id === operation.taskId);
        if (task) {
          applyTaskChanges(task, operation.changes);
        }
        continue;
      }

      if (operation.type === "add") {
        const nextTask: ResearchTask = {
          id: operation.task.id?.trim() || nextMockTaskId(operation.task.stage),
          title: operation.task.title.trim(),
          description: operation.task.description?.trim() ?? "",
          status: operation.task.status?.trim() || "pending",
          stage: operation.task.stage,
          priority: operation.task.priority?.trim() || "medium",
          dependencies: Array.from(new Set(operation.task.dependencies ?? [])),
          taskType: operation.task.taskType?.trim() || "custom",
          inputsNeeded: Array.from(new Set(operation.task.inputsNeeded ?? [])),
          suggestedSkills: Array.from(new Set(operation.task.suggestedSkills ?? [])),
          nextActionPrompt: operation.task.nextActionPrompt?.trim() || operation.task.description?.trim() || operation.task.title.trim(),
          artifactPaths: Array.from(new Set(operation.task.artifactPaths ?? [])),
          taskPrompt: operation.task.taskPrompt?.trim(),
          contextNotes: operation.task.contextNotes?.trim(),
          agentEntryLabel: operation.task.agentEntryLabel?.trim(),
          lastUpdatedAt: new Date().toISOString(),
        };
        researchTasks.push(nextTask);
        continue;
      }

      const taskIndex = researchTasks.findIndex((item) => item.id === operation.taskId);
      if (taskIndex >= 0) {
        const task = researchTasks[taskIndex];
        if (task.status === "done" || task.status === "in-progress") {
          task.status = "cancelled";
          task.lastUpdatedAt = new Date().toISOString();
        } else {
          researchTasks.splice(taskIndex, 1);
          researchTasks.forEach((candidate) => {
            candidate.dependencies = candidate.dependencies.filter((dependencyId) => dependencyId !== operation.taskId);
          });
        }
      }
    }
    sortMockResearchTasks();
    if (request.workingMemory) {
      researchBrief.workingMemory = request.workingMemory;
    }
    return this.openProject();
  },

  async listSkills() {
    return structuredClone(skills);
  },

  async installSkill(skill: SkillManifest) {
    skills.push(skill);
    return structuredClone(skill);
  },

  async enableSkill(skillId: string, enabled: boolean) {
    const skill = skills.find((item) => item.id === skillId);
    if (skill) {
      skill.enabled = enabled;
    }
    return structuredClone(skill);
  },

  async listProviders() {
    return structuredClone(providers);
  },

  async addProvider(provider: ProviderConfig) {
    providers.push(provider);
    return structuredClone(provider);
  },

  async updateProvider(providerId: string, patch: Partial<ProviderConfig>) {
    const provider = providers.find((item) => item.id === providerId);
    if (provider) {
      Object.assign(provider, patch);
    }
    return structuredClone(provider);
  },

  async deleteProvider(id: string) {
    const index = providers.findIndex((item) => item.id === id);
    if (index >= 0) {
      providers.splice(index, 1);
    }
  },

  async testProvider(_id: string) {
    return { success: true, latencyMs: 42 };
  },

  async listProfiles() {
    return structuredClone(profiles);
  },

  async updateProfile(config: AgentProfile) {
    const index = profiles.findIndex((item) => item.id === config.id);
    if (index >= 0) {
      profiles[index] = structuredClone(config);
    }
  },

  async createFigureBrief(sectionRef: string, selectedText: string): Promise<FigureBriefDraft> {
    const brief: FigureBriefDraft = {
      id: crypto.randomUUID(),
      sourceSectionRef: sectionRef,
      briefMarkdown: [
        `# Figure brief for ${sectionRef}`,
        "",
        "## Narrative goal",
        "Visualize the workflow from local editing to synchronized preview and controlled AI assistance.",
        "",
        "## Source excerpt",
        selectedText || "Use the active section context as the narrative seed.",
      ].join("\n"),
      promptPayload: `Create a clean research workflow diagram for ${sectionRef}. Highlight source editing, compile preview, agent tools, and figure workspace.`,
      status: "draft",
    };
    figureBriefs.unshift(brief);
    return structuredClone(brief);
  },

  async runFigureSkill(briefId: string) {
    const brief = figureBriefs.find((item) => item.id === briefId);
    if (!brief) {
      throw new Error("Figure brief not found");
    }
    brief.briefMarkdown = `${brief.briefMarkdown}\n\n## Style direction\nUse restrained journal-style geometry with warm neutral accents.`;
    brief.promptPayload = `${brief.promptPayload} Output a wide vector-like figure with numbered stages and no decorative clutter.`;
    brief.status = "ready";
    return structuredClone(brief);
  },

  async runBananaGeneration(briefId: string) {
    const brief = figureBriefs.find((item) => item.id === briefId);
    if (!brief) {
      throw new Error("Figure brief not found");
    }

    const assetId = crypto.randomUUID();
    const filePath = `assets/figures/figure-${assets.length + 1}.svg`;
    const svg = encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720">
        <rect width="1200" height="720" fill="#f3eee4" />
        <rect x="70" y="90" width="1060" height="540" rx="34" fill="#fbf8f1" stroke="#b6996e" stroke-width="4" />
        <text x="110" y="160" font-size="34" font-family="Georgia, serif" fill="#33281f">ViewerLeaf Writing Loop</text>
        <g font-family="Menlo, monospace" font-size="22" fill="#4c3f30">
          <rect x="110" y="220" width="210" height="110" rx="20" fill="#e7ddcc" />
          <text x="150" y="284">Source Editing</text>
          <rect x="380" y="220" width="210" height="110" rx="20" fill="#d8e7dd" />
          <text x="430" y="284">Compile + Sync</text>
          <rect x="650" y="220" width="210" height="110" rx="20" fill="#eadfcf" />
          <text x="704" y="284">Agent Draft</text>
          <rect x="920" y="220" width="160" height="110" rx="20" fill="#e2d6c3" />
          <text x="950" y="284">Figures</text>
        </g>
        <g stroke="#9f7d4f" stroke-width="8" fill="none" stroke-linecap="round">
          <path d="M320 275 H380" />
          <path d="M590 275 H650" />
          <path d="M860 275 H920" />
        </g>
        <text x="110" y="408" font-size="24" font-family="Georgia, serif" fill="#5a4a38">Generated from brief:</text>
        <foreignObject x="110" y="428" width="970" height="160">
          <div xmlns="http://www.w3.org/1999/xhtml" style="font-family: Menlo, monospace; font-size: 18px; color: #4f4335; line-height: 1.45;">
            ${brief.promptPayload}
          </div>
        </foreignObject>
      </svg>`,
    );

    const asset: GeneratedAsset = {
      id: assetId,
      kind: "figure",
      filePath,
      sourceBriefId: briefId,
      metadata: {
        generator: "banana",
        format: "svg",
        createdAt: new Date().toISOString(),
      },
      previewUri: `data:image/svg+xml;charset=UTF-8,${svg}`,
    };

    assets.unshift(asset);
    brief.status = "generated";
    return structuredClone(asset);
  },

  async registerGeneratedAsset(asset: GeneratedAsset) {
    const exists = assets.some((item) => item.id === asset.id);
    if (!exists) {
      assets.unshift(asset);
    }
    return structuredClone(asset);
  },

  async insertFigureSnippet(filePath: string, assetId: string, caption: string, line: number) {
    const file = getFile(filePath);
    const asset = assets.find((item) => item.id === assetId);
    if (!file || !asset) {
      throw new Error("Unable to insert figure snippet");
    }

    const snippet = buildFigureSnippet(asset, caption);
    file.content = insertAtLine(file.content, snippet, line);
    return { filePath, content: file.content };
  },

  async getAgentMessages(sessionId?: string) {
    if (!sessionId) {
      return structuredClone(agentMessages);
    }
    return structuredClone(agentMessages.filter((item) => item.sessionId === sessionId));
  },

  async listAgentSessions() {
    return structuredClone(
      [...agentSessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    );
  },

  async getUsageStats() {
    return [];
  },
};

function ensureSession(profileId: AgentProfileId, sessionId: string | undefined, titleSeed: string) {
  const resolvedId = sessionId && sessionId.trim() ? sessionId : crypto.randomUUID();
  const existing = agentSessions.find((item) => item.id === resolvedId);
  if (existing) {
    return resolvedId;
  }
  const now = new Date().toISOString();
  agentSessions.unshift({
    id: resolvedId,
    profileId,
    title: truncateTitle(titleSeed),
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    lastMessagePreview: "",
  });
  return resolvedId;
}

function touchSession(sessionId: string, lastMessage: string) {
  const session = agentSessions.find((item) => item.id === sessionId);
  if (!session) {
    return;
  }
  session.updatedAt = new Date().toISOString();
  session.messageCount = agentMessages.filter((item) => item.sessionId === sessionId).length;
  session.lastMessagePreview = truncateTitle(lastMessage, 80);
}

function truncateTitle(text: string, max = 36) {
  const compact = text.replaceAll("\n", " ").trim();
  if (!compact) {
    return "新对话";
  }
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}
