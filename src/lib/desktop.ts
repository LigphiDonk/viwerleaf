import { getVersion } from "@tauri-apps/api/app";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type {
  AppMenuAction,
  AppMenuState,
  AgentMessage,
  AgentProfileId,
  AgentRunResult,
  AgentSessionSummary,
  AssetResource,
  CompileEnvironmentStatus,
  CliAgentStatus,
  FigureBriefDraft,
  GeneratedAsset,
  ProjectConfig,
  ProjectFile,
  ProfileConfig,
  ProviderConfig,
  SkillManifest,
  StreamChunk,
  SyncLocation,
  TestResult,
  TerminalEvent,
  TerminalSessionInfo,
  UsageRecord,
  WorkspaceSnapshot,
} from "../types";
import { normalizeBinary } from "./binary";
import { mockRuntime } from "./mockRuntime";

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeTerminalEvent(payload: unknown): TerminalEvent | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const event = payload as Record<string, unknown>;
  const type = readString(event.type);
  const sessionId = readString(event.sessionId) ?? readString(event.session_id);
  if (!type || !sessionId) {
    return null;
  }

  if (type === "output") {
    return {
      type: "output",
      sessionId,
      data: readString(event.data) ?? "",
    };
  }

  if (type === "exit") {
    return {
      type: "exit",
      sessionId,
      exitCode: readNumber(event.exitCode ?? event.exit_code),
      signal: readString(event.signal),
    };
  }

  if (type === "error") {
    return {
      type: "error",
      sessionId,
      message: readString(event.message) ?? "terminal error",
    };
  }

  return null;
}

async function runOrMock<T>(command: string, args: Record<string, unknown>, fallback: () => Promise<T>) {
  if (isTauriRuntime()) {
    return invoke<T>(command, args);
  }
  return fallback();
}

function resolveAssetResource(asset: AssetResource): AssetResource {
  const data = normalizeBinary(asset.data);
  const resourceUrl =
    asset.resourceUrl ||
    (asset.absolutePath
      ? isTauriRuntime()
        ? asset.mimeType.startsWith("image/")
          ? convertFileSrc(asset.absolutePath)
          : toAssetUrl(asset.absolutePath)
        : asset.absolutePath
      : undefined);

  return {
    ...asset,
    data,
    resourceUrl,
  };
}

function toAssetUrl(absolutePath: string): string {
  // Build the asset:// URL manually:
  // - Keep slashes literal (encodeURIComponent turns them into %2F which
  //   PDF.js normalises back to /, producing double-slash URLs Tauri rejects).
  // - Keep Unicode characters (CJK, etc.) as raw UTF-8 so Tauri's asset
  //   protocol can resolve the filesystem path directly.
  // - Only encode the few characters that are meaningful in URL syntax.
  const normalized = absolutePath.startsWith("/") ? absolutePath.slice(1) : absolutePath;
  const safe = normalized
    .replaceAll("%", "%25")
    .replaceAll(" ", "%20")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F");
  return `asset://localhost/${safe}`;
}

export const desktop = {
  isTauriRuntime,
  getAppVersion() {
    if (isTauriRuntime()) {
      return getVersion();
    }
    return mockRuntime.getAppVersion?.() ?? Promise.resolve("0.1.0");
  },
  openProject() {
    return runOrMock<WorkspaceSnapshot>("open_project", {}, () => mockRuntime.openProject());
  },
  readFile(path: string) {
    return runOrMock<ProjectFile>("read_file", { path }, () => mockRuntime.readFile(path));
  },
  async readAsset(path: string) {
    const asset = await runOrMock<AssetResource>("read_asset", { path }, () => mockRuntime.readAsset(path));
    return resolveAssetResource(asset);
  },
  switchProject(rootPath: string) {
    return runOrMock<WorkspaceSnapshot>("switch_project", { rootPath }, () =>
      mockRuntime.switchProject?.(rootPath) ?? mockRuntime.openProject(),
    );
  },
  createProject(parentDir: string, projectName: string) {
    return runOrMock<WorkspaceSnapshot>("create_project", { parentDir, projectName }, () =>
      mockRuntime.createProject?.(parentDir, projectName) ?? mockRuntime.openProject(),
    );
  },
  launchWorkspaceWindow(rootPath?: string) {
    return runOrMock("launch_workspace_window", { rootPath }, () =>
      mockRuntime.launchWorkspaceWindow?.(rootPath) ?? Promise.resolve(true),
    );
  },
  syncAppMenu(state: AppMenuState) {
    return runOrMock("sync_app_menu", { ...state }, () =>
      mockRuntime.syncAppMenu?.(state) ?? Promise.resolve(true),
    );
  },
  async setWindowTitle(title: string) {
    if (isTauriRuntime()) {
      try {
        await getCurrentWindow().setTitle(title);
      } catch (error) {
        console.warn("[desktop.setWindowTitle] failed to set title", error);
      }
      return;
    }
    await (mockRuntime.setWindowTitle?.(title) ?? Promise.resolve());
  },
  async minimizeWindow() {
    if (isTauriRuntime()) {
      try { await getCurrentWindow().minimize(); } catch { /* ignore */ }
    }
  },
  async toggleMaximizeWindow() {
    if (isTauriRuntime()) {
      try { await getCurrentWindow().toggleMaximize(); } catch { /* ignore */ }
    }
  },
  async closeWindow() {
    if (isTauriRuntime()) {
      try { await getCurrentWindow().close(); } catch { /* ignore */ }
    }
  },
  saveFile(filePath: string, content: string) {
    return runOrMock("save_file", { filePath, content }, () => mockRuntime.saveFile(filePath, content));
  },
  updateProjectConfig(config: ProjectConfig) {
    return runOrMock<ProjectConfig>("update_project_config", { config }, () =>
      mockRuntime.updateProjectConfig?.(config) ?? Promise.resolve(config),
    );
  },
  compileProject(filePath: string) {
    return runOrMock("compile_project", { filePath }, () => mockRuntime.compileProject(filePath));
  },
  getCompileEnvironment() {
    return runOrMock<CompileEnvironmentStatus>("get_compile_environment", {}, () =>
      mockRuntime.getCompileEnvironment(),
    );
  },
  forwardSearch(filePath: string, line: number, column?: number) {
    return runOrMock<SyncLocation>("forward_search", { filePath, line, column }, () =>
      mockRuntime.forwardSearch(filePath, line, column),
    );
  },
  reverseSearch(page: number, h?: number, v?: number) {
    return runOrMock<SyncLocation>("reverse_search", { page, h, v }, () => mockRuntime.reverseSearch(page, h, v));
  },
  runAgent(
    profileId: AgentProfileId,
    filePath: string,
    selectedText: string,
    userMessage?: string,
    sessionId?: string,
  ) {
    return runOrMock<AgentRunResult>("run_agent", { profileId, filePath, selectedText, userMessage, sessionId }, () =>
      mockRuntime.runAgent(profileId, filePath, selectedText, userMessage, sessionId),
    );
  },
  applyAgentPatch(filePath: string, content: string) {
    return runOrMock("apply_agent_patch", { filePath, content }, () => mockRuntime.applyAgentPatch(filePath, content));
  },
  cancelAgent() {
    return runOrMock("cancel_agent", {}, () => Promise.resolve(true));
  },
  getAgentMessages(sessionId?: string) {
    return runOrMock<AgentMessage[]>("get_agent_messages", { sessionId }, () => mockRuntime.getAgentMessages(sessionId));
  },
  listAgentSessions() {
    return runOrMock<AgentSessionSummary[]>("list_agent_sessions", {}, () =>
      mockRuntime.listAgentSessions?.() ?? Promise.resolve([]),
    );
  },
  listSkills() {
    return runOrMock<SkillManifest[]>("list_skills", {}, () => mockRuntime.listSkills());
  },
  installSkill(skill: SkillManifest) {
    return runOrMock("install_skill", { skill }, () => mockRuntime.installSkill(skill));
  },
  enableSkill(skillId: string, enabled: boolean) {
    return runOrMock("enable_skill", { skillId, enabled }, () => mockRuntime.enableSkill(skillId, enabled));
  },
  importSkillFromGit(url: string) {
    return runOrMock<SkillManifest>("import_skill_from_git", { url }, () =>
      Promise.reject(new Error("Git skill import only available in desktop")),
    );
  },
  removeSkill(skillId: string, deleteFiles = true) {
    return runOrMock("remove_skill", { skillId, deleteFiles }, () =>
      Promise.reject(new Error("Skill removal only available in desktop")),
    );
  },
  createWorkspaceDir(path: string) {
    return runOrMock("create_workspace_dir", { path }, () => Promise.resolve());
  },
  detectCliAgents() {
    return runOrMock<CliAgentStatus[]>("detect_cli_agents", {}, () =>
      Promise.resolve([
        { name: "claude-code", available: true, version: "mock" },
        { name: "codex", available: true, version: "mock" },
      ]),
    );
  },
  listProviders() {
    return runOrMock<ProviderConfig[]>("list_providers", {}, () => mockRuntime.listProviders());
  },
  addProvider(provider: ProviderConfig) {
    return runOrMock("add_provider", { provider }, () => mockRuntime.addProvider(provider));
  },
  updateProvider(providerId: string, patch: Partial<ProviderConfig>) {
    return runOrMock("update_provider", { providerId, patch }, () => mockRuntime.updateProvider(providerId, patch));
  },
  deleteProvider(id: string) {
    return runOrMock("delete_provider", { id }, () => mockRuntime.deleteProvider?.(id) ?? Promise.resolve());
  },
  testProvider(id: string) {
    return runOrMock<TestResult>("test_provider", { id }, () =>
      mockRuntime.testProvider?.(id) ?? Promise.resolve({ success: true, latencyMs: 0 }),
    );
  },
  listProfiles() {
    return runOrMock<ProfileConfig[]>("list_profiles", {}, () =>
      mockRuntime.listProfiles?.() ?? Promise.resolve([]),
    );
  },
  updateProfile(config: ProfileConfig) {
    return runOrMock("update_profile", { config }, () =>
      mockRuntime.updateProfile?.(config) ?? Promise.resolve(),
    );
  },
  createFigureBrief(sectionRef: string, selectedText: string) {
    return runOrMock<FigureBriefDraft>("create_figure_brief", { sectionRef, selectedText }, () =>
      mockRuntime.createFigureBrief(sectionRef, selectedText),
    );
  },
  runFigureSkill(briefId: string) {
    return runOrMock<FigureBriefDraft>("run_figure_skill", { briefId }, () => mockRuntime.runFigureSkill(briefId));
  },
  runBananaGeneration(briefId: string) {
    return runOrMock<GeneratedAsset>("run_banana_generation", { briefId }, () =>
      mockRuntime.runBananaGeneration(briefId),
    );
  },
  registerGeneratedAsset(asset: GeneratedAsset) {
    return runOrMock("register_generated_asset", { asset }, () => mockRuntime.registerGeneratedAsset(asset));
  },
  insertFigureSnippet(filePath: string, assetId: string, caption: string, line: number) {
    return runOrMock("insert_figure_snippet", { filePath, assetId, caption, line }, () =>
      mockRuntime.insertFigureSnippet(filePath, assetId, caption, line),
    );
  },
  getUsageStats() {
    return runOrMock<UsageRecord[]>("get_usage_stats", {}, () =>
      mockRuntime.getUsageStats?.() ?? Promise.resolve([]),
    );
  },
  createFile(path: string, content = "") {
    return runOrMock("create_file", { path, content }, () =>
      mockRuntime.createFile?.(path, content) ?? Promise.resolve(),
    );
  },
  createFolder(path: string) {
    return runOrMock("create_folder", { path }, () =>
      mockRuntime.createFolder?.(path) ?? Promise.resolve(),
    );
  },
  deleteFile(path: string) {
    return runOrMock("delete_file", { path }, () =>
      mockRuntime.deleteFile?.(path) ?? Promise.resolve(),
    );
  },
  renameFile(oldPath: string, newPath: string) {
    return runOrMock("rename_file", { oldPath, newPath }, () =>
      mockRuntime.renameFile?.(oldPath, newPath) ?? Promise.resolve(),
    );
  },
  readPdfBinary(absolutePath: string): Promise<Uint8Array | null> {
    if (!isTauriRuntime() || !absolutePath) {
      return Promise.resolve(null);
    }
    return invoke<number[] | Uint8Array>("read_pdf_binary", { path: absolutePath })
      .then((raw) => {
        const result = normalizeBinary(raw);
        return result instanceof Uint8Array && result.length > 0 ? result : null;
      })
      .catch((error) => {
        console.error("[readPdfBinary] failed to load PDF:", absolutePath, error);
        return null;
      });
  },
  readFileBinary(path: string): Promise<Uint8Array | null> {
    if (!isTauriRuntime()) return Promise.resolve(null);
    return invoke<number[]>("read_file_binary", { path })
      .then((raw) => (raw?.length ? new Uint8Array(raw) : null))
      .catch(() => null);
  },
  saveFileBinary(filePath: string, data: Uint8Array): Promise<void> {
    if (!isTauriRuntime()) return Promise.resolve();
    return invoke("save_file_binary", { filePath, data: Array.from(data) });
  },
  onAgentStream(callback: (chunk: StreamChunk) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) {
      return Promise.resolve(() => { });
    }
    return listen<StreamChunk>("agent:stream", (event) => {
      callback(event.payload);
    });
  },
  startTerminal(cwd: string, cols: number, rows: number) {
    return runOrMock<TerminalSessionInfo>("start_terminal", { cwd, cols, rows }, () =>
      Promise.reject(new Error("内置终端仅支持桌面版")),
    );
  },
  prepareWorkerDeployDir() {
    return runOrMock<string>("prepare_worker_deploy_dir", {}, () =>
      Promise.reject(new Error("Worker 一键部署仅支持桌面版")),
    );
  },
  terminalWrite(sessionId: string, data: string) {
    return runOrMock("terminal_write", { sessionId, data }, () => Promise.resolve(true));
  },
  resizeTerminal(sessionId: string, cols: number, rows: number) {
    return runOrMock("resize_terminal", { sessionId, cols, rows }, () => Promise.resolve(true));
  },
  closeTerminal(sessionId: string) {
    return runOrMock("close_terminal", { sessionId }, () => Promise.resolve(true));
  },
  onTerminalEvent(callback: (event: TerminalEvent) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) {
      return Promise.resolve(() => { });
    }
    return listen<TerminalEvent>("terminal:event", (event) => {
      const normalized = normalizeTerminalEvent(event.payload);
      if (normalized) {
        callback(normalized);
      }
    });
  },
  onAppMenuAction(callback: (action: AppMenuAction) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) {
      return Promise.resolve(() => { });
    }
    return listen<AppMenuAction>("app:menu-action", (event) => {
      callback(event.payload);
    });
  },
  resolveResourceUrl(path?: string) {
    if (!path) {
      return "";
    }
    return isTauriRuntime() ? toAssetUrl(path) : path;
  },
};

export type { WorkspaceSnapshot };
