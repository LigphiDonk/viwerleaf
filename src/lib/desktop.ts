import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import type {
  AgentMessage,
  AgentProfileId,
  AgentRunResult,
  AssetResource,
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
  UsageRecord,
  WorkspaceSnapshot,
} from "../types";
import { mockRuntime } from "./mockRuntime";

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function normalizeBinary(data?: Uint8Array | number[] | null) {
  if (!data) {
    return undefined;
  }
  return data instanceof Uint8Array ? data : Uint8Array.from(data);
}

async function runOrMock<T>(command: string, args: Record<string, unknown>, fallback: () => Promise<T>) {
  if (isTauriRuntime()) {
    return invoke<T>(command, args);
  }
  return fallback();
}

function resolveAssetResource(asset: AssetResource): AssetResource {
  const data = normalizeBinary(asset.data);

  if (asset.resourceUrl) {
    return {
      ...asset,
      data,
    };
  }

  if (data) {
    return {
      ...asset,
      data,
    };
  }

  return {
    ...asset,
    data,
    resourceUrl: isTauriRuntime() ? convertFileSrc(asset.absolutePath) : asset.absolutePath,
  };
}

export const desktop = {
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
  forwardSearch(filePath: string, line: number) {
    return runOrMock<SyncLocation>("forward_search", { filePath, line }, () =>
      mockRuntime.forwardSearch(filePath, line),
    );
  },
  reverseSearch(page: number) {
    return runOrMock<SyncLocation>("reverse_search", { page }, () => mockRuntime.reverseSearch(page));
  },
  runAgent(profileId: AgentProfileId, filePath: string, selectedText: string) {
    return runOrMock<AgentRunResult>("run_agent", { profileId, filePath, selectedText }, () =>
      mockRuntime.runAgent(profileId, filePath, selectedText),
    );
  },
  applyAgentPatch(filePath: string, content: string) {
    return runOrMock("apply_agent_patch", { filePath, content }, () => mockRuntime.applyAgentPatch(filePath, content));
  },
  getAgentMessages(sessionId?: string) {
    return runOrMock<AgentMessage[]>("get_agent_messages", { sessionId }, () => mockRuntime.getAgentMessages());
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
  onAgentStream(callback: (chunk: StreamChunk) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) {
      return Promise.resolve(() => {});
    }
    return listen<StreamChunk>("agent:stream", (event) => {
      callback(event.payload);
    });
  },
  resolveResourceUrl(path?: string) {
    if (!path) {
      return "";
    }
    return isTauriRuntime() ? convertFileSrc(path) : path;
  },
};

export type { WorkspaceSnapshot };
