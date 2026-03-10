import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import type {
  AgentMessage,
  AgentProfile,
  AgentProfileId,
  AgentRunResult,
  CompileResult,
  Diagnostic,
  FigureBriefDraft,
  GeneratedAsset,
  ProjectConfig,
  ProjectFile,
  ProjectNode,
  ProviderConfig,
  SkillManifest,
  SyncLocation,
  WorkspaceSnapshot,
} from "../types";
import { buildFigureSnippet, insertAtLine, summarizeDiagnostics } from "./latex";

const projectConfig: ProjectConfig = {
  rootPath: "/Users/donkfeng/Documents/papers/viewerleaf-demo",
  mainTex: "main.tex",
  engine: "xelatex",
  bibTool: "biber",
  autoCompile: true,
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

let activeFile = "sections/introduction.tex";
let compileCounter = 0;
const figureBriefs: FigureBriefDraft[] = [];
const assets: GeneratedAsset[] = [];
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

function getFile(path: string) {
  return files.find((item) => item.path === path);
}

function detectLanguage(path: string): ProjectFile["language"] {
  if (path.endsWith(".tex") || path.endsWith(".sty") || path.endsWith(".cls")) {
    return "latex";
  }
  if (path.endsWith(".bib")) {
    return "bib";
  }
  if (path.endsWith(".json")) {
    return "json";
  }
  return "text";
}

function buildTree(paths: string[]) {
  const root: ProjectNode = {
    id: "root",
    name: "viewerleaf-demo",
    path: ".",
    kind: "directory",
    children: [],
  };

  for (const fullPath of paths) {
    const parts = fullPath.split("/");
    let current = root;
    parts.forEach((part, index) => {
      const joined = parts.slice(0, index + 1).join("/");
      const isLeaf = index === parts.length - 1;
      let child = current.children?.find((node) => node.path === joined);
      if (!child) {
        child = {
          id: joined,
          name: part,
          path: joined,
          kind: isLeaf ? (fullPath.startsWith("assets/") ? "asset" : "file") : "directory",
          children: isLeaf ? undefined : [],
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

export const mockRuntime = {
  async openProject(): Promise<WorkspaceSnapshot> {
    const tree = buildTree([...files.map((item) => item.path), ...assets.map((item) => item.filePath)]);
    return {
      projectConfig,
      tree,
      files: structuredClone(files),
      activeFile,
      providers: structuredClone(providers),
      skills: structuredClone(skills),
      profiles: structuredClone(profiles),
      compileResult: structuredClone(lastCompile),
      figureBriefs: structuredClone(figureBriefs),
      assets: structuredClone(assets),
    };
  },

  async saveFile(filePath: string, content: string) {
    const file = getFile(filePath);
    if (file) {
      file.content = content;
    }
    activeFile = filePath;
    return { ok: true };
  },

  async createFile(path: string, content: string) {
    if (getFile(path)) {
      throw new Error(`File already exists: ${path}`);
    }
    files.push({
      path,
      language: detectLanguage(path),
      content,
    });
    files.sort((left, right) => left.path.localeCompare(right.path));
    activeFile = path;
  },

  async deleteFile(path: string) {
    const index = files.findIndex((item) => item.path === path);
    if (index < 0) {
      throw new Error(`File not found: ${path}`);
    }
    files.splice(index, 1);
    if (activeFile === path) {
      activeFile = files[0]?.path ?? "main.tex";
    }
  },

  async renameFile(oldPath: string, newPath: string) {
    const file = getFile(oldPath);
    if (!file) {
      throw new Error(`File not found: ${oldPath}`);
    }
    file.path = newPath;
    file.language = detectLanguage(newPath);
    if (activeFile === oldPath) {
      activeFile = newPath;
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

  async forwardSearch(filePath: string, line: number): Promise<SyncLocation> {
    return {
      filePath,
      line,
      column: 1,
      page: Math.max(1, Math.ceil(line / 20)),
    };
  },

  async reverseSearch(page: number): Promise<SyncLocation> {
    return {
      filePath: projectConfig.mainTex,
      line: (page - 1) * 20 + 1,
      column: 1,
      page,
    };
  },

  async runAgent(profileId: AgentProfileId, filePath: string, selectedText: string): Promise<AgentRunResult> {
    const summary = createRunSummary(profileId, selectedText);
    const message: AgentMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      profileId,
      content: summary,
      timestamp: new Date().toISOString(),
    };

    agentMessages.push(message);

    if (profileId === "review") {
      return { message };
    }

    const file = getFile(filePath) ?? files[0];
    const suggestedContent =
      profileId === "outline"
        ? `${file.content}\n\n${summary}`
        : `${file.content}\n\n% ${profiles.find((item) => item.id === profileId)?.label} patch\n${summary}`;

    return {
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

  async getAgentMessages() {
    return structuredClone(agentMessages);
  },

  async getUsageStats() {
    return [];
  },
};
