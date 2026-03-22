export type LatexEngine = "pdflatex" | "xelatex" | "lualatex";
export type BibTool = "bibtex" | "biber" | "auto";
export type CompileStatus = "idle" | "running" | "success" | "failed" | "canceled";
export type AgentProfileId = string;
export type FigureBriefStatus = "draft" | "ready" | "generated";
export type AssetKind = "figure" | "table" | "diagram";
export type DrawerTab =
  | "project"
  | "sync"
  | "latex"
  | "ai"
  | "logs"
  | "figures"
  | "skills"
  | "usage"
  | "collab";
export type AppLocale = "zh-CN" | "en-US";
export type WorkspacePaneMode = "files" | "outline";
export type WorkspaceSurface = "research" | "writing" | "literature";
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

export interface CompileEnvironmentStatus {
  ready: boolean;
  latexmkAvailable: boolean;
  synctexAvailable: boolean;
  availableEngines: LatexEngine[];
  missingTools: string[];
}

export interface SyncHighlight {
  page: number;
  h: number;
  v: number;
  width: number;
  height: number;
}

export interface SyncLocation {
  filePath: string;
  line: number;
  column: number;
  page: number;
  highlights: SyncHighlight[];
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
  description?: string;
  summary?: string;
  primaryIntent?: string;
  intents?: string[];
  capabilities?: string[];
  domains?: string[];
  keywords?: string[];
  source: "builtin" | "local" | "project" | "git" | "zip";
  status?: string;
  upstream?: {
    repo?: string;
    path?: string;
    revision?: string;
  } | null;
  resourceFlags?: {
    hasReferences?: boolean;
    hasScripts?: boolean;
    hasTemplates?: boolean;
    hasAssets?: boolean;
    referenceCount?: number;
    scriptCount?: number;
    templateCount?: number;
    assetCount?: number;
    optionalScripts?: boolean;
  };
  dirPath?: string;
  isEnabled?: boolean;
  promptFiles?: string[];
  toolAllowlist?: string[];
  enabled?: boolean;
}

export interface ProviderConfig {
  id: string;
  vendor: "claude-code" | "codex" | string;
  baseUrl: string;
  defaultModel: string;
  name?: string;
  apiKey?: string;
  isEnabled?: boolean;
  sortOrder?: number;
  metaJson?: string;
  authRef?: string;
}

export interface ProviderMcpServerConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface CliAgentStatus {
  name: string;
  available: boolean;
  path?: string;
  version?: string;
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

export interface AgentSessionSummary {
  id: string;
  profileId: AgentProfileId | string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string;
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

export interface StreamToolCall {
  id: string;
  toolId: string;
  args?: Record<string, unknown>;
  output?: string;
  status: "running" | "completed" | "error";
}

export interface DiffLine {
  type: "add" | "remove" | "equal";
  content: string;
  oldLine?: number;
  newLine?: number;
}

export type StreamChunk =
  | { type: "thinking_delta"; content: string }
  | { type: "thinking_clear" }
  | { type: "thinking_commit" }
  | { type: "text_delta"; content: string }
  | { type: "tool_call_start"; toolId: string; args: Record<string, unknown> }
  | { type: "tool_call_result"; toolId: string; output: string; status?: "completed" | "error" }
  | { type: "patch"; filePath: string; startLine: number; endLine: number; newContent: string; diff?: DiffLine[] }
  | { type: "error"; message: string }
  | { type: "done"; usage: { inputTokens: number; outputTokens: number; model: string }; remoteSessionId?: string };

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

export type CloudProjectRole = "owner" | "editor" | "commenter" | "viewer";

export interface CloudProjectSummary {
  id: string;
  name: string;
  rootMainFile: string;
  role: CloudProjectRole;
  createdAt: string;
  updatedAt: string;
}

export interface CloudDocumentSummary {
  id: string;
  projectId: string;
  path: string;
  kind: "tex" | "bib" | "text";
  latestVersion: number;
  updatedAt: string;
}

export interface CloudBlobSummary {
  id: string;
  projectId: string;
  path: string;
  mime: string;
  size: number;
  latestVersion: number;
  updatedAt: string;
}

export interface CollabMember {
  clientId: number;
  userId: string;
  name: string;
  color: string;
  openFile?: string;
}

export interface WorkspaceCollabMetadata {
  mode: "local" | "cloud";
  cloudProjectId: string | null;
  checkoutRoot: string;
  linkedAt: string;
}

export type CollabFileSyncState = "synced" | "pending-push" | "pending-pull" | "conflict" | "ignored";

export interface CollabStatus {
  enabled: boolean;
  mode: "manual" | "realtime";
  role: CloudProjectRole | null;
  connected: boolean;
  synced: boolean;
  syncInProgress: boolean;
  pendingLocalChanges: boolean;
  pendingRemoteChanges: boolean;
  hasConflict: boolean;
  canEditText: boolean;
  canComment: boolean;
  canShare: boolean;
  lastSyncAt: string;
  connectionError: string;
  members: CollabMember[];
}

export interface ReviewComment {
  id: string;
  userId: string;
  userName: string;
  userColor: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  text: string;
  timestamp: string;
  resolved: boolean;
  replies: ReviewReply[];
}

export interface ReviewReply {
  id: string;
  userId: string;
  userName: string;
  userColor: string;
  text: string;
  timestamp: string;
}

export interface WorkspaceEntry {
  rootPath: string;
  label: string;
}

export interface AppMenuState {
  autoSave: boolean;
  compileOnSave: boolean;
  activeWorkspaceRoot: string;
  recentWorkspaces: WorkspaceEntry[];
}

export interface AppMenuAction {
  action:
    | "open-project"
    | "open-project-new-window"
    | "new-project"
    | "open-recent-workspace"
    | "clear-recent-workspaces"
    | "save-current"
    | "save-all"
    | "toggle-auto-save"
    | "toggle-compile-on-save";
  checked?: boolean;
  rootPath?: string;
}

export interface TerminalSessionInfo {
  sessionId: string;
  cwd: string;
  shell: string;
}

export type TerminalEvent =
  | { type: "output"; sessionId: string; data: string }
  | { type: "exit"; sessionId: string; exitCode?: number; signal?: string }
  | { type: "error"; sessionId: string; message: string };

export interface TestResult {
  success: boolean;
  latencyMs: number;
  error?: string;
}

export type ResearchStage = "survey" | "ideation" | "experiment" | "publication" | "promotion";

export interface ResearchBootstrapState {
  status: "ready" | "needs-bootstrap" | "missing-brief" | "missing-tasks" | "partial" | string;
  message: string;
  hasInstance: boolean;
  hasTemplates: boolean;
  hasSkillViews: boolean;
  hasBrief: boolean;
  hasTasks: boolean;
}

export interface ResearchTask {
  id: string;
  title: string;
  description: string;
  status: "pending" | "in-progress" | "done" | "review" | "deferred" | "cancelled" | string;
  stage: ResearchStage;
  priority: "high" | "medium" | "low" | string;
  dependencies: string[];
  taskType: string;
  inputsNeeded: string[];
  suggestedSkills: string[];
  nextActionPrompt: string;
  artifactPaths: string[];
  taskPrompt?: string;
  contextNotes?: string;
  lastUpdatedAt?: string;
  agentEntryLabel?: string;
}

export interface ResearchTaskCounts {
  total: number;
  pending: number;
  inProgress: number;
  done: number;
  review: number;
}

export interface ResearchStageSummary {
  stage: ResearchStage;
  label: string;
  description: string;
  status: "active" | "complete" | "queued" | "idle" | string;
  bundleId?: string;
  bundleLabel?: string;
  bundleDescription?: string;
  bundleSkillIds?: string[];
  isInitialized?: boolean;
  canInitialize?: boolean;
  totalTasks: number;
  doneTasks: number;
  artifactCount: number;
  artifactPaths: string[];
  missingInputs: string[];
  suggestedSkills: string[];
  nextTaskId?: string | null;
  taskCounts: ResearchTaskCounts;
}

export interface ResearchCanvasSnapshot {
  bootstrap: ResearchBootstrapState;
  brief?: Record<string, unknown> | null;
  tasks: ResearchTask[];
  currentStage: ResearchStage;
  initializedStages?: ResearchStage[];
  nextTask?: ResearchTask | null;
  stageSummaries: ResearchStageSummary[];
  artifactPaths: Record<ResearchStage, string[]>;
  handoffToWriting: boolean;
  pipelineRoot: string;
  instancePath?: string | null;
  briefTopic: string;
  briefGoal: string;
  systemPrompt?: string;
  workingMemory?: string;
}

export interface ResearchTaskUpdateChanges {
  title?: string;
  status?: string;
  stage?: ResearchStage;
  priority?: string;
  dependencies?: string[];
  taskType?: string;
  description?: string;
  inputsNeeded?: string[];
  artifactPaths?: string[];
  suggestedSkills?: string[];
  nextActionPrompt?: string;
  contextNotes?: string;
  taskPrompt?: string;
  agentEntryLabel?: string;
}

export interface ResearchTaskDraft {
  id?: string;
  title: string;
  description?: string;
  status?: string;
  stage: ResearchStage;
  priority?: string;
  dependencies?: string[];
  taskType?: string;
  inputsNeeded?: string[];
  artifactPaths?: string[];
  suggestedSkills?: string[];
  nextActionPrompt?: string;
  contextNotes?: string;
  taskPrompt?: string;
  agentEntryLabel?: string;
}

export type ResearchTaskPlanOperation =
  | {
    type: "update";
    taskId: string;
    changes: ResearchTaskUpdateChanges;
  }
  | {
    type: "add";
    task: ResearchTaskDraft;
    afterTaskId?: string;
  }
  | {
    type: "remove";
    taskId: string;
  };

export interface ApplyResearchTaskSuggestionRequest {
  taskId?: string | null;
  changes?: ResearchTaskUpdateChanges | null;
  operations?: ResearchTaskPlanOperation[] | null;
  workingMemory?: string | null;
}

export interface TaskUpdateSuggestion {
  reason: string;
  confidence?: number;
  taskId?: string;
  changes?: ResearchTaskUpdateChanges;
  operations?: ResearchTaskPlanOperation[];
  workingMemory?: string;
}

export interface AgentTaskContext {
  taskId: string;
  title: string;
  stage: ResearchStage;
  description: string;
  nextActionPrompt?: string;
  taskPrompt?: string;
  contextNotes?: string;
  suggestedSkills?: string[];
  inputsNeeded?: string[];
  artifactPaths?: string[];
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
  research?: ResearchCanvasSnapshot | null;
  collab?: WorkspaceCollabMetadata | null;
}

export type WeaponType = "blade" | "bow" | "hammer" | "shield" | "spear";
export type SkillActionType = "snippet" | "checklist" | "command" | "agent";

export interface SkillAction {
  type: SkillActionType;
  snippet?: string;
  checklist?: string;
  command?: string;
  prompt?: string;
}

export interface AcademicSkill {
  id: string;
  name: string;
  weaponType: WeaponType;
  description: string;
  actionLabel: string;
  themeColors: { primary: string; secondary: string; accent: string };
  enabled: boolean;
  action?: SkillAction;
  isCustom?: boolean;
}

/* ── Literature Management ── */

export type LiteratureOcrStatus = "none" | "pending" | "done" | "failed";
export type LiteratureSyncDirection = "pull" | "push" | "synced";
export type LiteratureDedupStatus = "pending" | "duplicate" | "unique";

export interface LiteratureItem {
  id: string;
  title: string;
  authors: string[];
  year: number;
  journal: string;
  doi: string;
  abstract: string;
  tags: string[];
  notes: string;
  dedupHash: string;
  linkedTaskIds: string[];
  addedAt: string;
  updatedAt: string;
}

export interface LiteratureAttachment {
  id: string;
  literatureId: string;
  kind: "pdf" | "markdown" | "fulltext";
  filePath: string;
  ocrStatus: LiteratureOcrStatus;
  source: "manual" | "zotero" | "ocr";
  createdAt: string;
}

export interface LiteratureSyncState {
  literatureId: string;
  zoteroLibrary: string;
  zoteroKey: string;
  zoteroVersion: number;
  syncDirection: LiteratureSyncDirection;
  lastSyncedAt: string;
}

export interface LiteratureCandidate {
  id: string;
  title: string;
  authors: string[];
  year: number;
  doi: string;
  abstract: string;
  sourceContext: string;
  pdfPath: string;
  dedupStatus: LiteratureDedupStatus;
  matchedItemId: string;
  createdAt: string;
}

export interface LiteratureSearchResult {
  item: LiteratureItem;
  matchField: "title" | "authors" | "abstract" | "chunk" | "notes";
  snippet: string;
  chunkIndex?: number;
  rank: number;
}

export interface ZoteroSearchResult {
  itemKey: string;
  title: string;
  authors: string[];
  year: number;
  journal: string;
  doi: string;
  abstract: string;
  tags: string[];
  itemType: string;
  libraryId: string;
  zoteroVersion: number;
  snippet: string;
}
