export type LatexEngine = "pdflatex" | "xelatex" | "lualatex";
export type BibTool = "bibtex" | "biber" | "auto";
export type CompileStatus = "idle" | "running" | "success" | "failed" | "canceled";
export type AgentProfileId = "outline" | "draft" | "polish" | "de_ai" | "review";
export type FigureBriefStatus = "draft" | "ready" | "generated";
export type AssetKind = "figure" | "table" | "diagram";
export type DrawerTab = "ai" | "logs" | "figures" | "skills" | "providers" | "usage";
export type WorkspacePaneMode = "files" | "outline";
export type ProjectFileType =
  | "latex"
  | "bib"
  | "json"
  | "markdown"
  | "text"
  | "yaml"
  | "xml"
  | "csv"
  | "pdf"
  | "image"
  | "unsupported";

export interface ProjectConfig {
  rootPath: string;
  mainTex: string;
  engine: LatexEngine;
  bibTool: BibTool;
  autoCompile: boolean;
  forwardSync: boolean;
}

export interface ProjectFile {
  path: string;
  language: "latex" | "bib" | "text" | "json" | string;
  content: string;
}

export interface ProjectNode {
  id: string;
  name: string;
  path: string;
  kind: "directory" | "file" | "asset";
  fileType?: ProjectFileType;
  isText?: boolean;
  isPreviewable?: boolean;
  size?: number;
  children?: ProjectNode[];
}

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
}

export interface Diagnostic {
  filePath: string;
  line: number;
  level: "error" | "warning" | "info" | string;
  message: string;
  file?: string;
}

export interface CompileResult {
  status: CompileStatus | string;
  pdfPath?: string;
  pdfData?: Uint8Array;
  synctexPath?: string;
  diagnostics: Diagnostic[];
  logPath: string;
  logOutput: string;
  timestamp: string;
}

export interface SyncLocation {
  filePath: string;
  line: number;
  column: number;
  page: number;
}

export interface AssetResource {
  path: string;
  absolutePath: string;
  resourceUrl?: string;
  data?: Uint8Array | number[];
  mimeType: string;
  size?: number;
}

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  stages: string[];
  tools?: string[];
  source: "builtin" | "local" | "project" | "git" | "zip";
  dirPath?: string;
  isEnabled?: boolean;
  promptFiles?: string[];
  toolAllowlist?: string[];
  enabled?: boolean;
}

export interface ProviderConfig {
  id: string;
  vendor: "openai" | "anthropic" | "openrouter" | "deepseek" | "google" | "banana" | "custom" | string;
  baseUrl: string;
  defaultModel: string;
  name?: string;
  apiKey?: string;
  isEnabled?: boolean;
  sortOrder?: number;
  metaJson?: string;
  authRef?: string;
}

export interface ProviderPreset {
  vendor: string;
  name: string;
  baseUrl: string;
  models: string[];
}

export interface ProfileConfig {
  id: AgentProfileId | string;
  label: string;
  summary: string;
  stage: "planning" | "drafting" | "revision" | "submission" | "figures" | string;
  providerId: string;
  model: string;
  skillIds: string[];
  toolAllowlist: string[];
  outputMode: "rewrite" | "outline" | "review" | string;
  sortOrder?: number;
  isBuiltin?: boolean;
}

export type AgentProfile = ProfileConfig;

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  profileId: AgentProfileId | string;
  content: string;
  sessionId?: string;
  toolId?: string;
  toolArgs?: string;
  createdAt?: string;
  timestamp?: string;
}

export interface AgentRunResult {
  sessionId?: string;
  message?: AgentMessage;
  suggestedPatch?: {
    filePath: string;
    content: string;
    summary: string;
  };
}

export type StreamChunk =
  | { type: "text_delta"; content: string }
  | { type: "tool_call_start"; toolId: string; args: Record<string, unknown> }
  | { type: "tool_call_result"; toolId: string; output: string }
  | { type: "patch"; filePath: string; startLine: number; endLine: number; newContent: string }
  | { type: "error"; message: string }
  | { type: "done"; usage: { inputTokens: number; outputTokens: number; model: string } };

export interface FigureBriefDraft {
  id: string;
  sourceSectionRef: string;
  briefMarkdown: string;
  promptPayload: string;
  status: FigureBriefStatus | string;
}

export interface GeneratedAsset {
  id: string;
  kind: AssetKind;
  filePath: string;
  sourceBriefId: string;
  metadata: Record<string, unknown>;
  previewUri: string;
}

export interface UsageRecord {
  id: string;
  sessionId: string;
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
}

export interface TestResult {
  success: boolean;
  latencyMs: number;
  error?: string;
}

export interface WorkspaceSnapshot {
  projectConfig: ProjectConfig;
  tree: ProjectNode[];
  files: ProjectFile[];
  activeFile: string;
  providers: ProviderConfig[];
  skills: SkillManifest[];
  profiles: ProfileConfig[];
  compileResult: CompileResult;
  figureBriefs: FigureBriefDraft[];
  assets: GeneratedAsset[];
}
