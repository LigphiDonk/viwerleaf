import {
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Y from "yjs";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { EditorPane } from "./components/EditorPane";
import { VisualEditor } from "./components/VisualEditor";
import { OutlineTree } from "./components/OutlineTree";
import { PdfPane, type PreviewPaneState } from "./components/PdfPane";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { Sidebar } from "./components/Sidebar";
import { SyncSidebar } from "./components/SyncSidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { WelcomeWorkspace } from "./components/WelcomeWorkspace";
import { WorkspaceMenuBar } from "./components/WorkspaceMenuBar";
import { CollabLoginModal } from "./components/CollabLoginModal";
import { CollabProjectModal } from "./components/CollabProjectModal";
import { CreateEntryModal } from "./components/CreateEntryModal";
import { ReleaseNotesModal } from "./components/ReleaseNotesModal";
import { ResearchCanvas } from "./components/ResearchCanvas";
import { ShareLinkModal } from "./components/ShareLinkModal";
import { createLocalAdapter } from "./lib/adapters";
import {
  createCloudProject,
  downloadCloudBlob,
  ensureCloudDocument,
  fetchDocumentSnapshot,
  getCloudProject,
  joinCloudProject,
  listCloudBlobs,
  listCloudDocuments,
  listCloudProjects,
  uploadCloudBlob,
} from "./lib/collaboration/cloud-api";
import {
  readCollabAuthSession,
  writeCollabAuthSession,
  resolveCollabBaseUrls,
  type CollabAuthSession,
} from "./lib/collaboration/auth";
import {
  readCollabConfig,
  writeCollabConfig,
  type CollabConfig,
} from "./lib/collaboration/collab-config";
import { CommentStore } from "./lib/collaboration/comment-store";
import { generateShareLink, parseProjectReference } from "./lib/collaboration/share";
import {
  CollabDocManager,
  readBlobSyncBaseline,
  seedBlobBaseline,
  seedCollabSyncBaseline,
  type CollabWorkspaceSyncSummary,
  writeBlobSyncBaseline,
} from "./lib/collaboration/doc-manager";
import {
  clearWorkspaceCollabMetadata,
  readWorkspaceCollabMetadata,
  writeWorkspaceCollabMetadata,
} from "./lib/collaboration/workspace-metadata";
import { desktop, isTauriRuntime } from "./lib/desktop";
import { AGENT_BRANDS, getAgentBrand, isAgentVendor, type AgentVendor } from "./lib/agentCatalog";
import { resolvePdfSource } from "./lib/pdf-source";
import { findActiveHeading } from "./lib/outline";
import { localizeResearchSnapshot } from "./lib/researchLocale";
import {
  closePathTab,
  closeTextTab,
  detectProjectFileType,
  getNodeByPath,
  isPreviewableFileType,
  isTextFileType,
} from "./lib/workspace";
import { useAgentChat } from "./hooks/useAgentChat";
import { useCollaborativeDoc } from "./hooks/useCollaborativeDoc";
import { useCompilePipeline } from "./hooks/useCompilePipeline";
import { useProjectOutline } from "./hooks/useProjectOutline";
import { useStableCallback as useEffectEvent } from "./hooks/useStableCallback";
import { useWorkspaceFiles } from "./hooks/useWorkspaceFiles";
import type {
  AppLocale,
  AppMenuAction,
  AppMenuState,
  CloudProjectRole,
  CloudProjectSummary,
  DrawerTab,
  FigureBriefDraft,
  GeneratedAsset,
  LatexEngine,
  ProjectNode,
  ProviderConfig,
  ResearchTask,
  ReviewComment,
  SkillManifest,
  WorkspaceCollabMetadata,
  WorkspaceEntry,
  WorkspacePaneMode,
  WorkspaceSurface,
  WorkspaceSnapshot,
} from "./types";

type PreviewSelection =
  | { kind: "compile" }
  | { kind: "asset"; path: string }
  | { kind: "unsupported"; path: string; title: string; description: string };

type EditorJumpTarget = { path: string; line: number; nonce: number };
type CollabBusyAction =
  | "save-config"
  | "create-project"
  | "link-project"
  | "unlink-project"
  | "sync-project"
  | "pull-project";
type CollabNotice = {
  tone: "success" | "error";
  text: string;
};
type CreateEntryModalState = {
  kind: "file" | "folder";
  parentDir: string;
};
type CollabProjectModalState =
  | { mode: "create"; defaultValue: string }
  | { mode: "link"; defaultValue: string };
type CollabLoginMode = "edit" | "bootstrap";
type ReleaseNotesModalState = {
  version: string;
  body: string;
  publishedAt?: string;
  htmlUrl?: string;
};

function normalizeProjectPath(path: string) {
  return path.replaceAll("\\", "/");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function normalizeCloudRole(role: string | null | undefined): CloudProjectRole | null {
  if (role === "owner" || role === "editor" || role === "commenter" || role === "viewer") {
    return role;
  }
  return null;
}

function isSamePathOrChild(path: string, target: string) {
  return path === target || path.startsWith(`${target}/`);
}

function toProjectRelativePath(rootPath: string, filePath?: string) {
  if (!rootPath || !filePath) {
    return "";
  }

  const normalizedRoot = normalizeProjectPath(rootPath).replace(/\/$/, "");
  const normalizedFile = normalizeProjectPath(filePath);
  const prefix = `${normalizedRoot}/`;

  return normalizedFile.startsWith(prefix) ? normalizedFile.slice(prefix.length) : "";
}

const RECENT_WORKSPACE_STORAGE_KEY = "viewerleaf:recent-workspaces:v1";
const WINDOW_WORKSPACE_TABS_STORAGE_KEY = "viewerleaf:window-workspaces:v1";
const AUTO_SAVE_STORAGE_KEY = "viewerleaf:auto-save:v1";
const APP_LOCALE_STORAGE_KEY = "viewerleaf:locale:v1";
const RELEASE_NOTES_VERSION_STORAGE_KEY = "viewerleaf:release-notes:last-seen-version:v1";
const GITHUB_RELEASE_TAG_ENDPOINT = "https://api.github.com/repos/LigphiDonk/viwerleaf/releases/tags";
const MAX_RECENT_WORKSPACES = 10;
const MAX_OPEN_WORKSPACES = 6;
const TERMINAL_PANEL_MIN_HEIGHT = 170;
const TERMINAL_PANEL_MAX_HEIGHT = 440;
const TERMINAL_PANEL_DEFAULT_HEIGHT = 230;

function workspaceLabelFromRoot(rootPath: string) {
  const normalized = normalizeProjectPath(rootPath).replace(/\/$/, "");
  return normalized.split("/").at(-1) || rootPath || "Untitled";
}

function sanitizeProjectFolderName(name: string) {
  return name
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "");
}

function decodeCollabTextSnapshot(update: Uint8Array) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return doc.getText("content").toString();
  } finally {
    doc.destroy();
  }
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "tif", "eps"]);

function imageMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    tiff: "image/tiff",
    tif: "image/tiff",
    eps: "application/postscript",
  };
  return map[ext] ?? "application/octet-stream";
}

function collectImagePaths(nodes: WorkspaceSnapshot["tree"]): string[] {
  const result: string[] = [];
  function visit(currentNodes: WorkspaceSnapshot["tree"]) {
    for (const node of currentNodes) {
      if (node.kind === "directory") {
        visit(node.children ?? []);
        continue;
      }
      const ext = node.name.split(".").pop()?.toLowerCase() ?? "";
      if (IMAGE_EXTENSIONS.has(ext)) {
        result.push(normalizeProjectPath(node.path));
      }
    }
  }
  visit(nodes);
  return result;
}

async function computeHash(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function collectTextPathsFromTree(nodes: WorkspaceSnapshot["tree"]) {
  const result: string[] = [];

  function visit(currentNodes: WorkspaceSnapshot["tree"]) {
    for (const node of currentNodes) {
      if (node.kind === "directory") {
        visit(node.children ?? []);
        continue;
      }
      if (node.isText) {
        result.push(node.path);
      }
    }
  }

  visit(nodes);
  return result;
}

function isResearchTaskClosed(task: ResearchTask) {
  return task.status === "done" || task.status === "cancelled" || task.status === "deferred";
}

function formatDebugTimestamp(date: Date) {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function toWorkspaceEntry(rootPath: string): WorkspaceEntry {
  return {
    rootPath,
    label: workspaceLabelFromRoot(rootPath),
  };
}

function readStoredWorkspaceEntries(key: string): WorkspaceEntry[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item): item is WorkspaceEntry => Boolean(item && typeof item.rootPath === "string" && item.rootPath))
      .map((item) => ({
        rootPath: item.rootPath,
        label: typeof item.label === "string" && item.label.trim()
          ? item.label
          : workspaceLabelFromRoot(item.rootPath),
      }));
  } catch {
    return [];
  }
}

function writeStoredWorkspaceEntries(key: string, entries: WorkspaceEntry[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(key, JSON.stringify(entries));
}

function readWindowSessionWorkspaceEntries(key: string): WorkspaceEntry[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item): item is WorkspaceEntry => Boolean(item && typeof item.rootPath === "string" && item.rootPath))
      .map((item) => ({
        rootPath: item.rootPath,
        label: typeof item.label === "string" && item.label.trim()
          ? item.label
          : workspaceLabelFromRoot(item.rootPath),
      }));
  } catch {
    return [];
  }
}

function writeWindowSessionWorkspaceEntries(key: string, entries: WorkspaceEntry[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(key, JSON.stringify(entries));
}

function readStoredBoolean(key: string, fallback = false) {
  if (typeof window === "undefined") {
    return fallback;
  }

  const raw = window.localStorage.getItem(key);
  return raw === null ? fallback : raw === "true";
}

function writeStoredBoolean(key: string, value: boolean) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(key, value ? "true" : "false");
}

function safelyDisposeListener(listener?: (() => void | Promise<void>) | null) {
  if (!listener) {
    return;
  }

  try {
    const result = listener();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      void (result as Promise<unknown>).catch((error) => {
        console.warn("failed to dispose listener", error);
      });
    }
  } catch (error) {
    console.warn("failed to dispose listener", error);
  }
}

async function fetchReleaseNotesForVersion(version: string): Promise<ReleaseNotesModalState> {
  const htmlUrl = `https://github.com/LigphiDonk/viwerleaf/releases/tag/v${version}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`${GITHUB_RELEASE_TAG_ENDPOINT}/v${encodeURIComponent(version)}`, {
      headers: {
        Accept: "application/vnd.github+json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status}`);
    }

    const payload = await response.json() as {
      body?: string;
      html_url?: string;
      published_at?: string;
    };

    return {
      version,
      body: payload.body?.trim() || `ViewerLeaf 已更新到 v${version}。`,
      publishedAt: payload.published_at,
      htmlUrl: payload.html_url || htmlUrl,
    };
  } catch (error) {
    console.warn("failed to fetch release notes", error);
    return {
      version,
      body: `ViewerLeaf 已更新到 v${version}。\n\n当前未能加载本次 GitHub Release 更新日志，你仍可稍后在 GitHub 查看完整说明。`,
      htmlUrl,
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function upsertWorkspaceEntry(entries: WorkspaceEntry[], rootPath: string, max: number) {
  const nextEntry = toWorkspaceEntry(rootPath);
  return [nextEntry, ...entries.filter((entry) => entry.rootPath !== rootPath)].slice(0, max);
}

function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [bootstrapError, setBootstrapError] = useState("");
  const [locale, setLocale] = useState<AppLocale>(() => {
    if (typeof window === "undefined") {
      return "zh-CN";
    }
    const stored = window.localStorage.getItem(APP_LOCALE_STORAGE_KEY);
    return stored === "en-US" ? "en-US" : "zh-CN";
  });
  const [recentWorkspaces, setRecentWorkspaces] = useState<WorkspaceEntry[]>(() =>
    readStoredWorkspaceEntries(RECENT_WORKSPACE_STORAGE_KEY),
  );
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspaceEntry[]>(() =>
    readWindowSessionWorkspaceEntries(WINDOW_WORKSPACE_TABS_STORAGE_KEY),
  );
  const [isAutoSaveEnabled, setIsAutoSaveEnabled] = useState(() =>
    readStoredBoolean(AUTO_SAVE_STORAGE_KEY, false),
  );
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("project");
  const [isDrawerVisible, setIsDrawerVisible] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isTerminalVisible, setIsTerminalVisible] = useState(false);
  const [terminalPanelHeight, setTerminalPanelHeight] = useState(TERMINAL_PANEL_DEFAULT_HEIGHT);
  const [terminalCommandRequest, setTerminalCommandRequest] = useState<{ id: number; command: string } | null>(null);
  const terminalCommandCounterRef = useRef(0);
  const [workspacePaneMode, setWorkspacePaneMode] = useState<WorkspacePaneMode>("files");
  const [previewPaneWidth, setPreviewPaneWidth] = useState(42);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorColumn, setCursorColumn] = useState(1);
  const [selectedText, setSelectedText] = useState("");
  const [selectedBrief, setSelectedBrief] = useState<FigureBriefDraft | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<GeneratedAsset | null>(null);
  const [previewSelection, setPreviewSelection] = useState<PreviewSelection>({ kind: "compile" });
  const [workspaceSurface, setWorkspaceSurface] = useState<WorkspaceSurface>("research");
  const [isResearchBootstrapBusy, setIsResearchBootstrapBusy] = useState(false);
  const [lastAutoWritingHandoffKey, setLastAutoWritingHandoffKey] = useState("");
  const [editorJumpTarget, setEditorJumpTarget] = useState<EditorJumpTarget | null>(null);
  const [collabRevision, setCollabRevision] = useState(0);
  const [runtimeDebugLogLines, setRuntimeDebugLogLines] = useState<string[]>([]);
  const [collabDebugLogLines, setCollabDebugLogLines] = useState<string[]>([]);
  const [editorMode, setEditorMode] = useState<"code" | "visual">("code");
  const workspaceBodyRef = useRef<HTMLDivElement | null>(null);
  const editorPreviewSplitRef = useRef<HTMLDivElement | null>(null);
  const activityBarShellRef = useRef<HTMLDivElement | null>(null);

  const { file: fileAdapter, project: projectAdapter, compile: compileAdapter } = useMemo(
    () => createLocalAdapter(),
    [],
  );

  const workspaceFiles = useWorkspaceFiles({
    snapshot,
    fileAdapter,
  });
  const {
    openFiles,
    openTabs,
    openImageTabs,
    dirtyPaths,
    assetCache,
    fileLoadErrors,
    assetLoadErrors,
    debugLogLines: workspaceDebugLogLines,
    activeFilePath,
    loadingFilePath,
    editorImagePath,
    editorImageUrl,
    draftContentRef,
    activeFile,
    dirtyPathSet,
    openImageTabSet,
    editorTabs,
    setOpenFiles,
    setOpenTabs,
    setDirtyPaths,
    setAssetCache,
    setActiveFilePath,
    loadTextFile,
    loadAsset,
    saveOpenFiles,
    replaceFileContent,
    handleFileChange,
    addDirtyPath,
    openTextFile: openTextFileBase,
    openImageFile: openImageFileBase,
    closeImageTab: closeImageTabBase,
    resetForSnapshot: resetWorkspaceFilesForSnapshot,
  } = workspaceFiles;

  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [collabLoginMode, setCollabLoginMode] = useState<CollabLoginMode>("edit");
  const [collabConfigState, setCollabConfigState] = useState<CollabConfig | null>(() => readCollabConfig());
  const [collabAuthRevision, setCollabAuthRevision] = useState(0);
  const [activeDocComments, setActiveDocComments] = useState<ReviewComment[]>([]);
  const [collabBusyAction, setCollabBusyAction] = useState<CollabBusyAction | null>(null);
  const [collabNotice, setCollabNotice] = useState<CollabNotice | null>(null);
  const [lastManualCollabSyncAt, setLastManualCollabSyncAt] = useState("");
  const [collabSyncError, setCollabSyncError] = useState("");
  const [collabWorkspaceSyncSummary, setCollabWorkspaceSyncSummary] = useState<CollabWorkspaceSyncSummary>({
    byPath: {},
    pendingPushCount: 0,
    pendingPullCount: 0,
    conflictCount: 0,
  });
  const [ignoredSyncPaths, setIgnoredSyncPaths] = useState<Set<string>>(new Set());
  const [collabProjectModal, setCollabProjectModal] = useState<CollabProjectModalState | null>(null);
  const [createEntryModal, setCreateEntryModal] = useState<CreateEntryModalState | null>(null);
  const [shareLinkModalOpen, setShareLinkModalOpen] = useState(false);
  const [availableCloudProjects, setAvailableCloudProjects] = useState<CloudProjectSummary[]>([]);
  const [isLoadingCloudProjects, setIsLoadingCloudProjects] = useState(false);
  const [pendingCloudProjectReference, setPendingCloudProjectReference] = useState<string | null>(null);
  const [authorizedCollabProjectId, setAuthorizedCollabProjectId] = useState<string | null>(null);
  const [authorizedCollabProjectRole, setAuthorizedCollabProjectRole] = useState<CloudProjectRole | null>(null);
  const [releaseNotesModal, setReleaseNotesModal] = useState<ReleaseNotesModalState | null>(null);

  const collabAuthSession = useMemo(
    () => readCollabAuthSession(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot?.collab?.cloudProjectId, snapshot?.projectConfig.rootPath, collabAuthRevision],
  );
  const activeCollabProjectId =
    snapshot?.collab?.mode === "cloud" ? snapshot.collab.cloudProjectId : null;

  const appendCollabDebugLog = useEffectEvent((message: string, details?: unknown) => {
    const suffix = (() => {
      if (details === undefined) {
        return "";
      }
      if (typeof details === "string") {
        return ` ${details}`;
      }
      try {
        return ` ${JSON.stringify(details)}`;
      } catch {
        return ` ${String(details)}`;
      }
    })();
    const line = `[${formatDebugTimestamp(new Date())}] ${message}${suffix}`;
    setCollabDebugLogLines((current) => {
      const next = [...current, line];
      return next.length > 240 ? next.slice(next.length - 240) : next;
    });
  });

  useEffect(() => {
    if (!activeCollabProjectId || !collabAuthSession) {
      setAuthorizedCollabProjectId(null);
      setAuthorizedCollabProjectRole(null);
      return;
    }

    let cancelled = false;
    setAuthorizedCollabProjectId(null);
    setAuthorizedCollabProjectRole(null);
    appendCollabDebugLog("[collab.http] joining cloud project", {
      projectId: activeCollabProjectId,
      httpBaseUrl: resolveCollabBaseUrls().httpBaseUrl,
      hasToken: Boolean(collabAuthSession.token),
      userId: collabAuthSession.userId,
    });

    void joinCloudProject(collabAuthSession.token, activeCollabProjectId)
      .then((result) => {
        if (!cancelled) {
          appendCollabDebugLog("[collab.http] join succeeded", {
            projectId: activeCollabProjectId,
            role: result.role,
          });
          setAuthorizedCollabProjectId(activeCollabProjectId);
          setAuthorizedCollabProjectRole(normalizeCloudRole(result.role));
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        appendCollabDebugLog("[collab.http] join failed", {
          projectId: activeCollabProjectId,
          message,
        });
        setAuthorizedCollabProjectId(null);
        setAuthorizedCollabProjectRole(null);
        setCollabNotice({
          tone: "error",
          text: `当前身份无法访问该云项目：${message}`,
        });
        window.alert(`云协作身份校验失败:\n${message}`);
      });

    return () => {
      cancelled = true;
    };
  }, [activeCollabProjectId, collabAuthSession]);

  useEffect(() => {
    setLastManualCollabSyncAt("");
    setCollabSyncError("");
    setShareLinkModalOpen(false);
    setAuthorizedCollabProjectRole(null);
    setCollabWorkspaceSyncSummary({
      byPath: {},
      pendingPushCount: 0,
      pendingPullCount: 0,
      conflictCount: 0,
    });
    // Load ignored paths for this project from localStorage
    if (activeCollabProjectId) {
      try {
        const stored = localStorage.getItem(`viwerleaf.collab.ignored.${activeCollabProjectId}`);
        setIgnoredSyncPaths(stored ? new Set(JSON.parse(stored) as string[]) : new Set());
      } catch {
        setIgnoredSyncPaths(new Set());
      }
    } else {
      setIgnoredSyncPaths(new Set());
    }
  }, [activeCollabProjectId]);

  const collabManager = useMemo(() => {
    const collabMetadata = snapshot?.collab;
    if (
      !collabMetadata ||
      collabMetadata.mode !== "cloud" ||
      !collabMetadata.cloudProjectId ||
      !collabAuthSession ||
      authorizedCollabProjectId !== collabMetadata.cloudProjectId
    ) {
      return null;
    }

    return new CollabDocManager({
      enabled: true,
      projectId: collabMetadata.cloudProjectId,
      authToken: collabAuthSession.token,
      user: {
        userId: collabAuthSession.userId,
        name: collabAuthSession.name,
        color: collabAuthSession.color,
      },
      fileAdapter,
      realtimeSyncEnabled: false,
      debugLog: appendCollabDebugLog,
    });
  }, [appendCollabDebugLog, authorizedCollabProjectId, collabAuthSession, fileAdapter, snapshot?.collab]);

  useEffect(() => {
    return () => {
      collabManager?.destroy();
    };
  }, [collabManager]);

  const refreshCollabSyncSummary = useEffectEvent(async () => {
    if (!collabManager || !snapshot) {
      setCollabWorkspaceSyncSummary({
        byPath: {},
        pendingPushCount: 0,
        pendingPullCount: 0,
        conflictCount: 0,
      });
      return;
    }

    try {
      const summary = await collabManager.getWorkspaceSyncSummary(snapshot);

      // Merge blob sync states into the summary
      const projectId = snapshot.collab?.cloudProjectId;
      if (projectId && collabAuthSession) {
        const blobBaseline = await readBlobSyncBaseline(fileAdapter, projectId);
        const localImagePaths = new Set(collectImagePaths(snapshot.tree));

        // pending-push: local image never synced (syncedVersion === 0)
        for (const imagePath of localImagePaths) {
          const syncedVersion = blobBaseline.versions.get(imagePath) ?? 0;
          if (syncedVersion === 0) {
            summary.byPath[imagePath] = "pending-push";
            summary.pendingPushCount += 1;
          } else {
            summary.byPath[imagePath] ??= "synced";
          }
        }

        // pending-pull: cloud blob newer than baseline
        try {
          const remoteBlobs = await listCloudBlobs(collabAuthSession.token, projectId);
          for (const blob of remoteBlobs) {
            const blobPath = normalizeProjectPath(blob.path);
            const syncedVersion = blobBaseline.versions.get(blobPath) ?? 0;
            if (blob.latestVersion > syncedVersion) {
              const existing = summary.byPath[blobPath];
              if (existing === "pending-push") {
                summary.byPath[blobPath] = "conflict";
                summary.pendingPushCount -= 1;
                summary.conflictCount += 1;
              } else {
                summary.byPath[blobPath] = "pending-pull";
                summary.pendingPullCount += 1;
              }
            } else if (!summary.byPath[blobPath]) {
              summary.byPath[blobPath] = "synced";
            }
          }
        } catch {
          // network unavailable — skip remote blob check, local states still shown
        }
      }

      setCollabWorkspaceSyncSummary(summary);
    } catch (error) {
      console.warn("failed to refresh collaborative workspace sync summary", error);
    }
  });

  useEffect(() => {
    if (!collabManager) {
      return;
    }
    const unsubscribe = collabManager.subscribe((event) => {
      if (event.kind === "content") {
        setCollabRevision((current) => current + 1);
      }
      void refreshCollabSyncSummary();
    });
    return unsubscribe;
  }, [collabManager, refreshCollabSyncSummary]);

  useEffect(() => {
    if (!collabManager) {
      return;
    }
    void collabManager.syncProject(snapshot).catch((error) => {
      console.warn("failed to sync collaborative project", error);
    });
  }, [collabManager, snapshot]);

  useEffect(() => {
    void refreshCollabSyncSummary();
  }, [collabManager, refreshCollabSyncSummary, snapshot]);

  useEffect(() => {
    if (!collabManager) {
      return;
    }

    const expectedPaths = new Set(openTabs);
    if (activeFilePath) {
      expectedPaths.add(activeFilePath);
    }

    for (const path of expectedPaths) {
      void collabManager.openDoc(path).catch((error) => {
        console.warn("failed to open collaborative doc", path, error);
      });
    }

    for (const path of collabManager.getAllConnectedPaths()) {
      if (!expectedPaths.has(path)) {
        collabManager.closeDoc(path);
      }
    }
  }, [activeFilePath, collabManager, openTabs]);

  useEffect(() => {
    if (!collabManager) {
      return;
    }

    setOpenFiles((current) => {
      let changed = false;
      const next = { ...current };
      for (const [path, file] of Object.entries(current)) {
        const doc = collabManager.getDoc(path);
        if (!doc) {
          continue;
        }
        const content = doc.yText.toString();
        draftContentRef.current[path] = content;
        if (file.content !== content) {
          next[path] = { ...file, content };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [collabManager, collabRevision, draftContentRef, setOpenFiles]);

  const replaceDocumentContent = useEffectEvent((filePath: string, content: string) => {
    const collabDoc = collabManager?.getDoc(filePath);
    if (collabDoc) {
      collabDoc.yDoc.transact(() => {
        collabDoc.yText.delete(0, collabDoc.yText.length);
        collabDoc.yText.insert(0, content);
      });
    }
    replaceFileContent(filePath, content);
  });

  const openTextFile = useEffectEvent((path: string, line?: number) => {
    const result = openTextFileBase(path, line);
    setPreviewSelection((current) => (current.kind === "compile" ? current : { kind: "compile" }));
    if (line && result.jumpTarget) {
      setCursorLine(line);
      setEditorJumpTarget(result.jumpTarget);
    }
  });

  const openImageFile = useEffectEvent((path: string) => {
    openImageFileBase(path);
    setPreviewSelection((current) => (current.kind === "compile" ? current : { kind: "compile" }));
  });

  const closeImageTab = useEffectEvent((path: string) => {
    closeImageTabBase(path);
  });

  const closeEditorTab = useEffectEvent((path: string, isImageTab: boolean) => {
    if (isImageTab) {
      closeImageTab(path);
      return;
    }
    const closed = closeTextTab(openTabs, activeFilePath, path);
    setOpenTabs(closed.openTabs);
    setActiveFilePath(closed.activePath);
  });

  const handleEditorTabsWheel = useEffectEvent((event: ReactWheelEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (element.scrollWidth <= element.clientWidth) {
      return;
    }
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return;
    }
    element.scrollLeft += event.deltaY;
    event.preventDefault();
  });

  const compilePipeline = useCompilePipeline({
    snapshot,
    activeFilePath,
    cursorLine,
    cursorColumn,
    dirtyPaths,
    drawerTab,
    compileAdapter,
    fileAdapter,
    saveOpenFiles,
    openTextFile,
    docManager: collabManager,
  });
  const {
    compileEnvironment,
    isCheckingCompileEnvironment,
    refreshCompileEnvironment,
  } = compilePipeline;

  const outlineReadFile = useEffectEvent(async (path: string) => {
    const collabDoc = collabManager?.getDoc(path);
    if (collabDoc) {
      const existing = openFiles[path];
      return {
        path,
        language: existing?.language ?? (await fileAdapter.readFile(path)).language,
        content: collabDoc.yText.toString(),
      };
    }
    return fileAdapter.readFile(path);
  });

  const {
    outlineHeadings,
    outlineTree,
    outlineWarnings,
    outlineLoading,
  } = useProjectOutline({
    snapshot,
    openFiles,
    draftContentRef,
    readFile: outlineReadFile,
    revision: collabRevision,
  });

  const agentChat = useAgentChat({
    snapshot,
    activeFile,
    selectedText,
    cursorLine,
    replaceFileContent: replaceDocumentContent,
    addDirtyPath,
    refreshWorkspace: async () => {},
  });
  const {
    messages,
    agentSessions,
    activeSessionId,
    usageRecords,
    activeProfileId,
    activeProfile,
    isStreaming,
    streamThinkingText,
    streamThinkingHistoryText,
    streamThinkingDurationMs,
    streamContent,
    streamError,
    pendingPatch,
    handleRunAgent: runAgentBase,
    handleSendMessage: sendMessageBase,
    handleNewSession: newSessionBase,
    handleSelectSession: selectSessionBase,
    handleApplyPatch: applyPatchBase,
    handleDismissPatch,
    resetForSnapshot: resetAgentChatForSnapshot,
  } = agentChat;

  const activeCollaborativeDoc = useCollaborativeDoc({
    docPath: activeFile?.path ?? "",
    projectId: snapshot?.collab?.cloudProjectId ?? null,
    userId: collabAuthSession?.userId ?? null,
    enabled: Boolean(collabManager && activeFile?.path && snapshot?.collab?.mode === "cloud"),
    manager: collabManager,
  });

  const currentCollabRole =
    activeCollabProjectId && activeCollabProjectId === authorizedCollabProjectId
      ? authorizedCollabProjectRole
      : null;
  const collabSyncInProgress =
    collabBusyAction === "sync-project" || collabBusyAction === "pull-project";
  const currentCollabStatus = useMemo(
    () => ({
      enabled: Boolean(snapshot?.collab?.cloudProjectId),
      mode: "manual" as const,
      role: currentCollabRole,
      connected: false,
      synced:
        collabWorkspaceSyncSummary.pendingPushCount === 0 &&
        collabWorkspaceSyncSummary.pendingPullCount === 0 &&
        collabWorkspaceSyncSummary.conflictCount === 0 &&
        !collabSyncInProgress &&
        Boolean(lastManualCollabSyncAt),
      syncInProgress: collabSyncInProgress,
      pendingLocalChanges:
        collabWorkspaceSyncSummary.pendingPushCount > 0 || collabWorkspaceSyncSummary.conflictCount > 0,
      pendingRemoteChanges:
        collabWorkspaceSyncSummary.pendingPullCount > 0 || collabWorkspaceSyncSummary.conflictCount > 0,
      hasConflict: collabWorkspaceSyncSummary.conflictCount > 0,
      canEditText: currentCollabRole === "owner" || currentCollabRole === "editor",
      canComment:
        currentCollabRole === "owner" ||
        currentCollabRole === "editor" ||
        currentCollabRole === "commenter",
      canShare: currentCollabRole === "owner" || currentCollabRole === "editor",
      lastSyncAt: lastManualCollabSyncAt,
      connectionError: collabSyncError || activeCollaborativeDoc.connectionError,
      members: [],
    }),
    [
      activeCollaborativeDoc.connectionError,
      collabSyncError,
      collabSyncInProgress,
      collabWorkspaceSyncSummary.conflictCount,
      collabWorkspaceSyncSummary.pendingPullCount,
      collabWorkspaceSyncSummary.pendingPushCount,
      currentCollabRole,
      lastManualCollabSyncAt,
      snapshot?.collab?.cloudProjectId,
    ],
  );

  useEffect(() => {
    if (!activeCollabProjectId) {
      return;
    }
    appendCollabDebugLog("[collab.state] active doc status", {
      projectId: activeCollabProjectId,
      docPath: activeFile?.path ?? "",
      mode: currentCollabStatus.mode,
      enabled: currentCollabStatus.enabled,
      connected: currentCollabStatus.connected,
      synced: currentCollabStatus.synced,
      syncInProgress: currentCollabStatus.syncInProgress,
      pendingLocalChanges: currentCollabStatus.pendingLocalChanges,
      lastSyncAt: currentCollabStatus.lastSyncAt || "",
      members: currentCollabStatus.members.length,
      connectionError: currentCollabStatus.connectionError || "",
    });
  }, [
    activeCollabProjectId,
    activeFile?.path,
    appendCollabDebugLog,
    currentCollabStatus.connected,
    currentCollabStatus.connectionError,
    currentCollabStatus.enabled,
    currentCollabStatus.lastSyncAt,
    currentCollabStatus.members.length,
    currentCollabStatus.mode,
    currentCollabStatus.pendingLocalChanges,
    currentCollabStatus.syncInProgress,
    currentCollabStatus.synced,
  ]);

  const commentStore = useMemo(() => {
    const yDoc = activeCollaborativeDoc.yDoc;
    return yDoc ? new CommentStore(yDoc) : null;
  }, [activeCollaborativeDoc.yDoc]);

  useEffect(() => {
    if (!commentStore) {
      setActiveDocComments([]);
      return;
    }
    setActiveDocComments(commentStore.getComments());
    return commentStore.subscribe(() => setActiveDocComments(commentStore.getComments()));
  }, [commentStore]);

  const hasProject = Boolean(snapshot?.projectConfig.rootPath);
  const activeEditorTabPath = editorImagePath || activeFilePath;
  const focusedTreePath =
    editorImagePath || (previewSelection.kind === "compile" ? activeFilePath : previewSelection.path);
  const activeOutlineId = useMemo(
    () => findActiveHeading(outlineHeadings, activeFilePath, cursorLine)?.id,
    [activeFilePath, cursorLine, outlineHeadings],
  );
  const compilePreviewPath = compilePipeline.compilePreviewPath;
  const previewAsset = previewSelection.kind === "asset" ? assetCache[previewSelection.path] : undefined;
  const previewAssetLoadError =
    previewSelection.kind === "asset" ? assetLoadErrors[previewSelection.path] ?? "" : "";
  const editorImageAsset = editorImagePath ? assetCache[editorImagePath] : undefined;
  const activeFileLoadError = activeFilePath ? fileLoadErrors[activeFilePath] ?? "" : "";
  const workspaceTargetDir = activeFilePath.includes("/")
    ? activeFilePath.slice(0, activeFilePath.lastIndexOf("/"))
    : "";
  const syncChangeEntries = useMemo(
    () =>
      Object.entries(collabWorkspaceSyncSummary.byPath)
        .filter(([, state]) => state !== "synced")
        .map(([path, state]) => ({
          path,
          state: (ignoredSyncPaths.has(path) ? "ignored" : state) as import("./types").CollabFileSyncState,
        }))
        .sort((left, right) =>
          left.state === right.state ? left.path.localeCompare(right.path) : left.state.localeCompare(right.state),
        ),
    [collabWorkspaceSyncSummary.byPath, ignoredSyncPaths],
  );
  const activeWorkspaceRoot = snapshot?.projectConfig.rootPath ?? "";
  const isMacOverlayWindow =
    typeof window !== "undefined" &&
    isTauriRuntime() &&
    /mac/i.test(window.navigator.userAgent);
  const isWindows =
    typeof window !== "undefined" &&
    isTauriRuntime() &&
    /win/i.test(window.navigator.userAgent) &&
    !/mac/i.test(window.navigator.userAgent);
  const isZh = locale === "zh-CN";
  const openDrawerTab = useEffectEvent((tab: DrawerTab) => {
    setIsSettingsOpen(false);
    setDrawerTab(tab);
    setIsDrawerVisible(true);
  });
  const toggleDrawerTab = useEffectEvent((tab: DrawerTab) => {
    setIsSettingsOpen(false);
    if (drawerTab === tab && isDrawerVisible) {
      setIsDrawerVisible(false);
      return;
    }
    setDrawerTab(tab);
    setIsDrawerVisible(true);
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(APP_LOCALE_STORAGE_KEY, locale);
  }, [locale]);

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!activityBarShellRef.current?.contains(event.target as Node)) {
        setIsSettingsOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [isSettingsOpen]);

  useEffect(() => {
    writeStoredWorkspaceEntries(RECENT_WORKSPACE_STORAGE_KEY, recentWorkspaces);
  }, [recentWorkspaces]);

  useEffect(() => {
    writeWindowSessionWorkspaceEntries(WINDOW_WORKSPACE_TABS_STORAGE_KEY, workspaceTabs);
  }, [workspaceTabs]);

  useEffect(() => {
    writeStoredBoolean(AUTO_SAVE_STORAGE_KEY, isAutoSaveEnabled);
  }, [isAutoSaveEnabled]);

  useEffect(() => {
    if (!activeWorkspaceRoot) {
      return;
    }

    setRecentWorkspaces((current) =>
      upsertWorkspaceEntry(current, activeWorkspaceRoot, MAX_RECENT_WORKSPACES),
    );
    setWorkspaceTabs((current) =>
      upsertWorkspaceEntry(current, activeWorkspaceRoot, MAX_OPEN_WORKSPACES),
    );
  }, [activeWorkspaceRoot]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    const menuState: AppMenuState = {
      autoSave: isAutoSaveEnabled,
      compileOnSave: snapshot?.projectConfig.autoCompile ?? false,
      activeWorkspaceRoot,
      recentWorkspaces,
    };

    void desktop.syncAppMenu(menuState);
  }, [activeWorkspaceRoot, isAutoSaveEnabled, recentWorkspaces, snapshot?.projectConfig.autoCompile]);

  useEffect(() => {
    const workspaceLabel = activeWorkspaceRoot
      ? workspaceLabelFromRoot(activeWorkspaceRoot)
      : "";
    const activeDocumentPath =
      editorImagePath ||
      activeFilePath ||
      (previewSelection.kind === "asset" || previewSelection.kind === "unsupported"
        ? previewSelection.path
        : "");
    const dirtyPrefix = dirtyPaths.length > 0 ? "* " : "";
    const nextTitle = workspaceLabel
      ? activeDocumentPath
        ? `${dirtyPrefix}${activeDocumentPath} - ${workspaceLabel} - ViewerLeaf`
        : `${dirtyPrefix}${workspaceLabel} - ViewerLeaf`
      : "ViewerLeaf";

    document.title = nextTitle;
    void desktop.setWindowTitle(nextTitle);
  }, [activeFilePath, activeWorkspaceRoot, dirtyPaths.length, editorImagePath, previewSelection]);

  const loadSnapshotWithCollab = useEffectEvent(async (loader: () => Promise<WorkspaceSnapshot>) => {
    const nextSnapshot = await loader();
    const collab = nextSnapshot.projectConfig.rootPath
      ? await readWorkspaceCollabMetadata(fileAdapter)
      : null;
    return {
      ...nextSnapshot,
      collab,
    } satisfies WorkspaceSnapshot;
  });

  const applySnapshot = useEffectEvent((
    nextSnapshot: WorkspaceSnapshot,
    options?: {
      activeFilePath?: string;
      openTabs?: string[];
      openImageTabs?: string[];
      editorImagePath?: string;
      previewSelection?: PreviewSelection;
      clearCaches?: boolean;
    },
  ) => {
    const rootChanged =
      options?.clearCaches ||
      nextSnapshot.projectConfig.rootPath !== (snapshot?.projectConfig.rootPath ?? "");
    const nextPreview = (() => {
      const requestedPreview = options?.previewSelection ?? previewSelection;
      if (requestedPreview.kind === "asset") {
        const node = getNodeByPath(nextSnapshot.tree, requestedPreview.path);
        if (node?.isPreviewable) {
          return requestedPreview;
        }
      }
      if (requestedPreview.kind === "unsupported") {
        const node = getNodeByPath(nextSnapshot.tree, requestedPreview.path);
        if (node && !node.isText) {
          return requestedPreview;
        }
      }
      return { kind: "compile" } as PreviewSelection;
    })();

    setSnapshot(nextSnapshot);
    setPreviewSelection(nextPreview);
    setEditorJumpTarget(null);
    resetWorkspaceFilesForSnapshot({ nextSnapshot, options });
    compilePipeline.resetForSnapshot();
    if (rootChanged) {
      resetAgentChatForSnapshot();
      setSelectedText("");
      setLastAutoWritingHandoffKey("");
      setWorkspaceSurface(nextSnapshot.projectConfig.rootPath ? "research" : "writing");
      setIsDrawerVisible(true);
      setIsSettingsOpen(false);
    }
    setSelectedBrief((current) =>
      current ? nextSnapshot.figureBriefs.find((item) => item.id === current.id) ?? null : null,
    );
    setSelectedAsset((current) =>
      current ? nextSnapshot.assets.find((item) => item.id === current.id) ?? null : null,
    );
  });

  const refreshWorkspace = useEffectEvent(async (options?: {
    activeFilePath?: string;
    openTabs?: string[];
    openImageTabs?: string[];
    editorImagePath?: string;
    previewSelection?: PreviewSelection;
    clearCaches?: boolean;
  }) => {
    const nextSnapshot = await loadSnapshotWithCollab(() => projectAdapter.openProject());
    applySnapshot(nextSnapshot, options);
    return nextSnapshot;
  });

  useEffect(() => {
    void (async () => {
      try {
        await refreshWorkspace({ clearCaches: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setBootstrapError(message);
      }
    })();
  }, [refreshWorkspace]);

  useEffect(() => {
    if (!isTauriRuntime() || typeof window === "undefined") {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const currentVersion = await desktop.getAppVersion();
        if (!currentVersion || cancelled) {
          return;
        }

        const lastSeenVersion = window.localStorage.getItem(RELEASE_NOTES_VERSION_STORAGE_KEY);
        if (!lastSeenVersion) {
          window.localStorage.setItem(RELEASE_NOTES_VERSION_STORAGE_KEY, currentVersion);
          return;
        }

        if (lastSeenVersion === currentVersion) {
          return;
        }

        const notes = await fetchReleaseNotesForVersion(currentVersion);
        if (!cancelled) {
          setReleaseNotesModal(notes);
        }
      } catch (error) {
        console.warn("failed to resolve app release notes", error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (previewSelection.kind !== "asset") {
      return;
    }
    if (!assetCache[previewSelection.path]) {
      void loadAsset(previewSelection.path);
    }
  }, [assetCache, loadAsset, previewSelection]);

  useEffect(() => {
    const research = snapshot?.research;
    if (!activeWorkspaceRoot || !research?.handoffToWriting) {
      return;
    }

    const handoffKey = `${activeWorkspaceRoot}:${research.currentStage}:${research.nextTask?.id ?? ""}`;
    if (handoffKey === lastAutoWritingHandoffKey) {
      return;
    }

    setWorkspaceSurface("writing");
    setLastAutoWritingHandoffKey(handoffKey);
  }, [
    activeWorkspaceRoot,
    lastAutoWritingHandoffKey,
    snapshot?.research?.currentStage,
    snapshot?.research?.handoffToWriting,
    snapshot?.research?.nextTask?.id,
  ]);

  const executeCompile = useEffectEvent(async (filePath: string) => {
    const previousCompilePath = toProjectRelativePath(activeWorkspaceRoot, snapshot?.compileResult.pdfPath);
    setSnapshot((current) =>
      current
        ? {
          ...current,
          compileResult: {
            ...current.compileResult,
            status: "running",
            logOutput: "Compile queued…",
            diagnostics: current.compileResult.diagnostics,
            logPath: current.compileResult.logPath,
            timestamp: new Date().toISOString(),
          },
        }
        : current,
    );
    const compileResult = await compilePipeline.runCompile(filePath);
    const nextCompilePath = toProjectRelativePath(activeWorkspaceRoot, compileResult.pdfPath);
    if (previousCompilePath && previousCompilePath !== nextCompilePath) {
      setAssetCache((current) => {
        const next = { ...current };
        delete next[previousCompilePath];
        return next;
      });
    }
    setSnapshot((current) => (current ? { ...current, compileResult } : current));
    return compileResult;
  });

  const saveDirtyFilesBeforeWorkspaceSwitch = useEffectEvent(async () => {
    if (dirtyPaths.length === 0) {
      return;
    }

    await saveOpenFiles(dirtyPaths);
  });

  const applyFreshWorkspaceSnapshot = useEffectEvent((nextSnapshot: WorkspaceSnapshot) => {
    resetAgentChatForSnapshot();
    applySnapshot(nextSnapshot, {
      openTabs: [],
      openImageTabs: [],
      editorImagePath: "",
      previewSelection: { kind: "compile" },
      clearCaches: true,
    });
  });

  const activateWorkspace = useEffectEvent(async (rootPath: string) => {
    if (!rootPath || rootPath === activeWorkspaceRoot || isStreaming) {
      return;
    }

    try {
      await saveDirtyFilesBeforeWorkspaceSwitch();
      const nextSnapshot = await loadSnapshotWithCollab(() => projectAdapter.switchProject(rootPath));
      applyFreshWorkspaceSnapshot(nextSnapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRecentWorkspaces((current) => current.filter((entry) => entry.rootPath !== rootPath));
      setWorkspaceTabs((current) => current.filter((entry) => entry.rootPath !== rootPath));
      window.alert(`无法打开项目:\n${message}`);
    }
  });

  const handleEditorChange = useEffectEvent((content: string) => {
    if (!activeFile) {
      return;
    }
    handleFileChange(activeFile.path, content);
  });

  const handleEditorCursorChange = useEffectEvent((line: number, column: number, selection: string) => {
    setCursorLine(line);
    setCursorColumn(column);
    setSelectedText(selection);
  });

  const handleSaveCurrentFile = useEffectEvent(async () => {
    if (!snapshot || !activeFile) {
      return;
    }

    if (snapshot.projectConfig.autoCompile) {
      await saveOpenFiles(dirtyPaths);
      await executeCompile(activeFile.path);
      return;
    }

    await saveOpenFiles([activeFile.path]);
  });

  const handleSaveAllFiles = useEffectEvent(async () => {
    if (!snapshot || dirtyPaths.length === 0) {
      return;
    }

    await saveOpenFiles(dirtyPaths);

    if (snapshot.projectConfig.autoCompile && snapshot.compileResult.status !== "running") {
      await executeCompile(activeFilePath || snapshot.projectConfig.mainTex);
    }
  });

  const handleManualCompile = useEffectEvent(async () => {
    if (!snapshot) {
      return;
    }

    await saveOpenFiles(dirtyPaths);
    setPreviewSelection({ kind: "compile" });
    await executeCompile(activeFilePath || snapshot.projectConfig.mainTex);
  });

  const handleInteractiveCompile = useEffectEvent(async () => {
    if (!snapshot) {
      return;
    }

    try {
      const environment = await compilePipeline.refreshCompileEnvironment();
      const selectedEngine = snapshot.projectConfig.engine as LatexEngine;
      const selectedEngineAvailable = environment?.availableEngines.includes(selectedEngine) ?? false;

      if (!environment?.ready || !selectedEngineAvailable) {
        openDrawerTab("latex");
        return;
      }
    } catch (error) {
      compilePipeline.logCompileDebug("warn", "[compile] failed to detect compile environment", {
        reason: error instanceof Error ? error.message : String(error),
      });
      openDrawerTab("latex");
      return;
    }

    await handleManualCompile();
  });

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "b") {
        return;
      }
      event.preventDefault();
      void handleInteractiveCompile();
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [handleInteractiveCompile]);

  const handleToggleTerminal = useEffectEvent(() => {
    setIsTerminalVisible((current) => !current);
  });

  const handleRunTerminalCommand = useEffectEvent((command: string) => {
    const trimmed = command.trim();
    if (!trimmed) {
      return;
    }

    terminalCommandCounterRef.current += 1;
    setTerminalCommandRequest({
      id: terminalCommandCounterRef.current,
      command: trimmed,
    });
    setIsTerminalVisible(true);
  });

  const handleWorkerTerminalAction = useEffectEvent(
    async (mode: "login" | "deploy" | "login-deploy") => {
      try {
        const workerDir = await desktop.prepareWorkerDeployDir();
        const quotedDir = shellQuote(workerDir);
        const ensureDeps =
          'if [ ! -d "./node_modules" ]; then npm install --no-audit --no-fund; fi';

        let command = "";
        if (mode === "login") {
          command = `cd ${quotedDir} && ${ensureDeps} && npx wrangler login`;
        } else if (mode === "deploy") {
          command = `cd ${quotedDir} && ${ensureDeps} && npm run viewerleaf:deploy`;
        } else {
          command =
            `cd ${quotedDir} && ${ensureDeps} ` +
            '&& (npx wrangler whoami >/dev/null 2>&1 || npx wrangler login) ' +
            "&& npm run viewerleaf:deploy";
        }

        handleRunTerminalCommand(command);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        handleRunTerminalCommand(
          `printf '%s\\n' ${shellQuote(`[ViewerLeaf] 准备 Worker 模板失败: ${message}`)}`,
        );
      }
    },
  );

  const handlePreviewResizeStart = useEffectEvent((event: ReactMouseEvent<HTMLDivElement>) => {
    const container = editorPreviewSplitRef.current;
    if (!container) {
      return;
    }

    event.preventDefault();
    const bounds = container.getBoundingClientRect();

    const updateWidth = (clientX: number) => {
      const nextWidth = ((bounds.right - clientX) / bounds.width) * 100;
      setPreviewPaneWidth(Math.min(68, Math.max(28, nextWidth)));
    };

    updateWidth(event.clientX);

    const handlePointerMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      updateWidth(moveEvent.clientX);
    };

    const handlePointerUp = () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", handlePointerUp);
    };

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", handlePointerUp);
  });

  const handleTerminalResizeStart = useEffectEvent((event: ReactMouseEvent<HTMLDivElement>) => {
    const workspaceBody = workspaceBodyRef.current;
    if (!workspaceBody) {
      return;
    }

    event.preventDefault();
    const rect = workspaceBody.getBoundingClientRect();
    const maxHeight = Math.min(TERMINAL_PANEL_MAX_HEIGHT, Math.max(TERMINAL_PANEL_MIN_HEIGHT, rect.height - 180));

    function updateHeight(clientY: number) {
      const nextHeight = rect.bottom - clientY;
      const clampedHeight = Math.min(maxHeight, Math.max(TERMINAL_PANEL_MIN_HEIGHT, nextHeight));
      setTerminalPanelHeight(clampedHeight);
    }

    updateHeight(event.clientY);

    function handlePointerMove(moveEvent: MouseEvent) {
      updateHeight(moveEvent.clientY);
    }

    function handlePointerUp() {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", handlePointerUp);
    }

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", handlePointerUp);
  });

  useEffect(() => {
    function handleTerminalKeydown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "j") {
        return;
      }
      event.preventDefault();
      handleToggleTerminal();
    }

    window.addEventListener("keydown", handleTerminalKeydown);
    return () => window.removeEventListener("keydown", handleTerminalKeydown);
  }, [handleToggleTerminal]);

  useEffect(() => {
    if (snapshot) {
      return;
    }
    setIsTerminalVisible(false);
  }, [snapshot]);

  const handleSetAutoCompile = useEffectEvent(async (enabled: boolean) => {
    if (!snapshot) {
      return;
    }

    const projectConfig = await projectAdapter.updateProjectConfig({
      ...snapshot.projectConfig,
      autoCompile: enabled,
    });

    setSnapshot((current) => (current ? { ...current, projectConfig } : current));
  });

  const handleSetCompileEngine = useEffectEvent(async (engine: LatexEngine) => {
    if (!snapshot || snapshot.projectConfig.engine === engine) {
      return;
    }

    const projectConfig = await projectAdapter.updateProjectConfig({
      ...snapshot.projectConfig,
      engine,
    });

    setSnapshot((current) => (current ? { ...current, projectConfig } : current));
  });

  useEffect(() => {
    if (!isAutoSaveEnabled || !snapshot || dirtyPaths.length === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      void saveOpenFiles(dirtyPaths).then(() => {
        if (snapshot.projectConfig.autoCompile) {
          void executeCompile(activeFilePath || snapshot.projectConfig.mainTex);
        }
      });
    }, 900);

    return () => window.clearTimeout(timer);
  }, [activeFilePath, dirtyPaths, executeCompile, isAutoSaveEnabled, saveOpenFiles, snapshot]);

  useEffect(() => {
    function appendRuntimeLog(kind: "error" | "promise", message: string) {
      const line = `[${formatDebugTimestamp(new Date())}] [${kind.toUpperCase()}] ${message}`;
      setRuntimeDebugLogLines((current) => {
        const next = [...current, line];
        return next.length > 120 ? next.slice(next.length - 120) : next;
      });
    }

    function handleError(event: ErrorEvent) {
      appendRuntimeLog("error", event.error?.stack || event.message || "Unknown window error");
    }

    function handleUnhandledRejection(event: PromiseRejectionEvent) {
      const reason = event.reason instanceof Error
        ? event.reason.stack || event.reason.message
        : String(event.reason);
      appendRuntimeLog("promise", reason);
    }

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  const handleEditorSave = useEffectEvent(() => {
    void handleSaveCurrentFile();
  });

  const handleEditorCompile = useEffectEvent(() => {
    void handleInteractiveCompile();
  });

  const handleEditorForwardSync = useEffectEvent(() => {
    if (!activeFile) {
      return;
    }
    void compilePipeline.performForwardSync(activeFile.path, cursorLine, cursorColumn);
  });

  const handleRunAgent = useEffectEvent(async () => {
    openDrawerTab("ai");
    await collabManager?.flushAll();
    await runAgentBase();
  });

  const handleEditorRunAgent = useEffectEvent(() => {
    void handleRunAgent();
  });

  const handleNewSession = useEffectEvent(() => {
    openDrawerTab("ai");
    newSessionBase();
  });

  const handleSelectSession = useEffectEvent(async (sessionId: string) => {
    openDrawerTab("ai");
    await selectSessionBase(sessionId);
  });

  const handleApplyPatch = useEffectEvent(async () => {
    const patchFilePath = pendingPatch?.filePath;
    await applyPatchBase();
    if (patchFilePath) {
      setDirtyPaths((current) => current.filter((path) => path !== patchFilePath));
    }
  });

  const handleSendMessage = useEffectEvent(async (text: string) => {
    openDrawerTab("ai");
    await collabManager?.flushAll();
    await sendMessageBase(text);
  });

  const handleEnsureResearchScaffold = useEffectEvent(async () => {
    if (!snapshot?.projectConfig.rootPath || isResearchBootstrapBusy) {
      return;
    }

    setIsResearchBootstrapBusy(true);
    try {
      const nextSnapshot = await loadSnapshotWithCollab(() => desktop.ensureResearchScaffold());
      applySnapshot(nextSnapshot, {
        activeFilePath,
        openTabs,
        openImageTabs,
        editorImagePath,
        previewSelection,
      });
      setWorkspaceSurface("research");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(`初始化研究工作流失败:\n${message}`);
    } finally {
      setIsResearchBootstrapBusy(false);
    }
  });

  const handleOpenResearchArtifact = useEffectEvent((path: string) => {
    const fileType = detectProjectFileType(path);
    setWorkspaceSurface("writing");

    if (isTextFileType(fileType)) {
      openTextFile(path);
      return;
    }

    if (fileType === "image") {
      openImageFile(path);
      return;
    }

    if (isPreviewableFileType(fileType)) {
      if (fileType === "pdf" && compilePreviewPath && path === compilePreviewPath) {
        setPreviewSelection((current) => (current.kind === "compile" ? current : { kind: "compile" }));
        return;
      }
      setPreviewSelection({ kind: "asset", path });
      void loadAsset(path);
      return;
    }

    setPreviewSelection({
      kind: "unsupported",
      path,
      title: path.split("/").at(-1) ?? path,
      description: "该研究产物暂时不支持内置预览。",
    });
  });

  const enableSkillsById = useEffectEvent(async (skillIds: string[]) => {
    const currentSnapshot = snapshot;
    if (!currentSnapshot || skillIds.length === 0) {
      return;
    }

    const nextEnabledIds = [...new Set(skillIds)].filter((skillId) => {
      const skill = currentSnapshot.skills.find((item) => item.id === skillId);
      return Boolean(skill) && !(skill?.isEnabled ?? skill?.enabled ?? false);
    });

    if (nextEnabledIds.length === 0) {
      return;
    }

    await Promise.all(nextEnabledIds.map((skillId) => desktop.enableSkill(skillId, true)));
    setSnapshot((current) =>
      current
        ? {
          ...current,
          skills: current.skills.map((item) =>
            nextEnabledIds.includes(item.id) ? { ...item, enabled: true, isEnabled: true } : item,
          ),
        }
        : current,
    );
  });

  const handleUseResearchTaskInChat = useEffectEvent(async (task: ResearchTask) => {
    if (task.suggestedSkills.length > 0) {
      await enableSkillsById(task.suggestedSkills);
    }
    await handleSendMessage(task.nextActionPrompt || task.description || task.title);
  });

  function handleOpenNode(node: ProjectNode) {
    if (node.kind === "directory") {
      return;
    }
    setWorkspaceSurface("writing");
    if (node.isText) {
      openTextFile(node.path);
      return;
    }
    if (node.isPreviewable) {
      if (node.fileType === "pdf" && compilePreviewPath && node.path === compilePreviewPath) {
        setPreviewSelection((current) => (current.kind === "compile" ? current : { kind: "compile" }));
        return;
      }
      if (node.fileType === "image") {
        openImageFile(node.path);
        return;
      }
      setPreviewSelection({ kind: "asset", path: node.path });
      void loadAsset(node.path);
      return;
    }
    setPreviewSelection({
      kind: "unsupported",
      path: node.path,
      title: node.name,
      description: "该文件类型暂时不支持内置预览。",
    });
  }

  async function handleCreateBrief() {
    if (!activeFile) {
      return;
    }
    await collabManager?.flushAll();
    const brief = await desktop.createFigureBrief(activeFile.path, selectedText);
    setSnapshot((current) =>
      current
        ? {
          ...current,
          figureBriefs: [brief, ...current.figureBriefs.filter((item) => item.id !== brief.id)],
        }
        : current,
    );
    setSelectedBrief(brief);
    openDrawerTab("figures");
  }

  async function handleRunFigureSkill() {
    if (!selectedBrief) {
      return;
    }
    const updated = await desktop.runFigureSkill(selectedBrief.id);
    setSelectedBrief(updated);
    setSnapshot((current) =>
      current
        ? {
          ...current,
          figureBriefs: current.figureBriefs.map((item) => (item.id === updated.id ? updated : item)),
        }
        : current,
    );
  }

  async function handleGenerateFigure() {
    if (!selectedBrief) {
      return;
    }
    const asset = await desktop.runBananaGeneration(selectedBrief.id);
    await desktop.registerGeneratedAsset(asset);
    setSelectedAsset(asset);
    setSnapshot((current) =>
      current
        ? {
          ...current,
          assets: [asset, ...current.assets.filter((item) => item.id !== asset.id)],
        }
        : current,
    );
  }

  async function handleInsertFigure() {
    if (!activeFile || !selectedAsset) {
      return;
    }
    const result = await desktop.insertFigureSnippet(
      activeFile.path,
      selectedAsset.id,
      "Workflow overview of ViewerLeaf.",
      cursorLine + 1,
    );
    replaceDocumentContent(result.filePath, result.content);
    setDirtyPaths((current) => current.filter((path) => path !== result.filePath));
  }

  async function refreshAgentProvidersAndProfiles() {
    const [providers, profiles] = await Promise.all([
      desktop.listProviders(),
      desktop.listProfiles(),
    ]);
    setSnapshot((prev) => (prev ? { ...prev, providers, profiles } : prev));
  }

  async function ensureAgentProvider(vendor: AgentVendor) {
    const currentSnapshot = snapshot;
    if (!currentSnapshot) {
      return { providers: [] as ProviderConfig[], provider: null as ProviderConfig | null };
    }

    const existing = currentSnapshot.providers.find((provider) => provider.vendor === vendor) ?? null;
    if (existing) {
      return { providers: currentSnapshot.providers, provider: existing };
    }

    const brand = AGENT_BRANDS[vendor];
    const builtinProvider: ProviderConfig = {
      id: `builtin-${vendor}`,
      name: brand.label,
      vendor,
      baseUrl: "",
      defaultModel: brand.defaultModel,
      apiKey: "",
      isEnabled: vendor === "claude-code",
      sortOrder: currentSnapshot.providers.length,
      metaJson: "{\"builtin\":true}",
    };
    await desktop.addProvider(builtinProvider);
    const providers = await desktop.listProviders();
    setSnapshot((prev) => (prev ? { ...prev, providers } : prev));
    return {
      providers,
      provider: providers.find((provider) => provider.vendor === vendor) ?? builtinProvider,
    };
  }

  async function handleSelectChatVendor(vendor: AgentVendor) {
    const currentSnapshot = snapshot;
    if (!currentSnapshot) {
      return;
    }

    const targetProfile =
      currentSnapshot.profiles.find((profile) => profile.id === activeProfileId) ??
      currentSnapshot.profiles.find((profile) => profile.id === "chat") ??
      currentSnapshot.profiles[0];
    if (!targetProfile) {
      return;
    }

    const { providers, provider } = await ensureAgentProvider(vendor);
    if (!provider) {
      return;
    }

    const nextModel = provider.defaultModel?.trim() || getAgentBrand(vendor).defaultModel;
    await Promise.all([
      ...providers
        .filter((item) => isAgentVendor(item.vendor))
        .map((item) =>
          desktop.updateProvider(item.id, { isEnabled: item.id === provider.id }),
        ),
      desktop.updateProfile({
        ...targetProfile,
        providerId: provider.id,
        model: nextModel,
      }),
    ]);

    await refreshAgentProvidersAndProfiles();
  }

  async function handleSelectChatModel(model: string) {
    const currentSnapshot = snapshot;
    if (!currentSnapshot) {
      return;
    }

    const targetProfile =
      currentSnapshot.profiles.find((profile) => profile.id === activeProfileId) ??
      currentSnapshot.profiles.find((profile) => profile.id === "chat") ??
      currentSnapshot.profiles[0];
    if (!targetProfile) {
      return;
    }

    const targetProvider =
      currentSnapshot.providers.find((provider) => provider.id === targetProfile.providerId) ??
      currentSnapshot.providers.find(
        (provider) => provider.isEnabled && isAgentVendor(provider.vendor),
      ) ??
      null;
    if (!targetProvider) {
      return;
    }

    await Promise.all([
      desktop.updateProfile({
        ...targetProfile,
        model,
      }),
      desktop.updateProvider(targetProvider.id, { defaultModel: model }),
    ]);

    await refreshAgentProvidersAndProfiles();
  }

  async function handleToggleSkill(skill: SkillManifest) {
    const enabled = !(skill.isEnabled ?? skill.enabled ?? false);
    await desktop.enableSkill(skill.id, enabled);
    setSnapshot((current) =>
      current
        ? {
          ...current,
          skills: current.skills.map((item) =>
            item.id === skill.id ? { ...item, enabled, isEnabled: enabled } : item,
          ),
        }
        : current,
    );
  }

  async function handleSkillsChanged() {
    try {
      const fresh = await desktop.listSkills();
      setSnapshot((current) => current ? { ...current, skills: fresh } : current);
    } catch {
      // ignore
    }
  }

  async function handleCreateFile(parentDir: string, fileName: string) {
    const targetPath = parentDir ? `${parentDir}/${fileName}` : fileName;
    await fileAdapter.createFile(targetPath, "");
    setWorkspaceSurface("writing");
    await refreshWorkspace({
      activeFilePath: targetPath,
      openTabs: [...openTabs, targetPath],
      openImageTabs,
      editorImagePath,
      previewSelection: { kind: "compile" },
    });
    void loadTextFile(targetPath);
  }

  async function handleCreateFolder(parentDir: string, folderName: string) {
    const targetPath = parentDir ? `${parentDir}/${folderName}` : folderName;
    await fileAdapter.createFolder(targetPath);
    await refreshWorkspace({
      activeFilePath,
      openTabs,
      openImageTabs,
      editorImagePath,
      previewSelection,
    });
  }

  async function handleDeleteFile(path: string) {
    const removedTabs = openTabs.filter((tab) => isSamePathOrChild(tab, path));
    const removedImageTabs = openImageTabs.filter((tab) => isSamePathOrChild(tab, path));
    const closed = removedTabs.reduce(
      (current, tab) => closeTextTab(current.openTabs, current.activePath, tab),
      { openTabs, activePath: activeFilePath },
    );
    const closedImages = removedImageTabs.reduce(
      (current, tab) => closePathTab(current.openTabs, current.activePath, tab),
      { openTabs: openImageTabs, activePath: editorImagePath },
    );
    const nextPreview =
      previewSelection.kind !== "compile" && isSamePathOrChild(previewSelection.path, path)
        ? ({ kind: "compile" } as PreviewSelection)
        : previewSelection;

    for (const draftPath of Object.keys(draftContentRef.current)) {
      if (isSamePathOrChild(draftPath, path)) {
        delete draftContentRef.current[draftPath];
      }
    }
    setOpenFiles((current) => {
      const next = { ...current };
      for (const key of Object.keys(next)) {
        if (isSamePathOrChild(key, path)) {
          delete next[key];
        }
      }
      return next;
    });
    setAssetCache((current) => {
      const next = { ...current };
      for (const key of Object.keys(next)) {
        if (isSamePathOrChild(key, path)) {
          delete next[key];
        }
      }
      return next;
    });
    setDirtyPaths((current) => current.filter((item) => !isSamePathOrChild(item, path)));

    collabManager?.closeDoc(path);
    await fileAdapter.deleteFile(path);
    await refreshWorkspace({
      activeFilePath: closed.activePath,
      openTabs: closed.openTabs,
      openImageTabs: closedImages.openTabs,
      editorImagePath: closedImages.activePath,
      previewSelection: nextPreview,
    });
  }

  async function handleRenameFile(oldPath: string, newPath: string) {
    const nextTabs = openTabs.map((tab) =>
      isSamePathOrChild(tab, oldPath) ? tab.replace(oldPath, newPath) : tab,
    );
    const nextImageTabs = openImageTabs.map((tab) =>
      isSamePathOrChild(tab, oldPath) ? tab.replace(oldPath, newPath) : tab,
    );
    const nextActive = isSamePathOrChild(activeFilePath, oldPath)
      ? activeFilePath.replace(oldPath, newPath)
      : activeFilePath;
    const nextEditorImagePath = isSamePathOrChild(editorImagePath, oldPath)
      ? editorImagePath.replace(oldPath, newPath)
      : editorImagePath;
    const nextPreview =
      previewSelection.kind !== "compile" && isSamePathOrChild(previewSelection.path, oldPath)
        ? ({ ...previewSelection, path: previewSelection.path.replace(oldPath, newPath) } as PreviewSelection)
        : previewSelection;

    for (const [draftPath, draftContent] of Object.entries(draftContentRef.current)) {
      if (isSamePathOrChild(draftPath, oldPath)) {
        draftContentRef.current[draftPath.replace(oldPath, newPath)] = draftContent;
        delete draftContentRef.current[draftPath];
      }
    }
    setOpenFiles((current) => {
      const next = { ...current };
      let changed = false;
      for (const [path, file] of Object.entries(current)) {
        if (isSamePathOrChild(path, oldPath)) {
          delete next[path];
          next[path.replace(oldPath, newPath)] = { ...file, path: file.path.replace(oldPath, newPath) };
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setAssetCache((current) => {
      const next = { ...current };
      let changed = false;
      for (const [path, asset] of Object.entries(current)) {
        if (isSamePathOrChild(path, oldPath)) {
          delete next[path];
          next[path.replace(oldPath, newPath)] = { ...asset, path: asset.path.replace(oldPath, newPath) };
          changed = true;
        }
      }
      return changed ? next : current;
    });
    setDirtyPaths((current) =>
      current.map((path) => (isSamePathOrChild(path, oldPath) ? path.replace(oldPath, newPath) : path)),
    );

    collabManager?.closeDoc(oldPath);
    await fileAdapter.renameFile(oldPath, newPath);
    await refreshWorkspace({
      activeFilePath: nextActive,
      openTabs: nextTabs,
      openImageTabs: nextImageTabs,
      editorImagePath: nextEditorImagePath,
      previewSelection: nextPreview,
    });
  }

  async function handleQuickCreateFile() {
    setCreateEntryModal({
      kind: "file",
      parentDir: workspaceTargetDir,
    });
  }

  async function handleQuickCreateFolder() {
    setCreateEntryModal({
      kind: "folder",
      parentDir: workspaceTargetDir,
    });
  }

  async function handleCreateEntrySubmit(name: string) {
    if (!createEntryModal || !name.trim()) {
      return;
    }
    try {
      if (createEntryModal.kind === "file") {
        await handleCreateFile(createEntryModal.parentDir, name.trim());
      } else {
        await handleCreateFolder(createEntryModal.parentDir, name.trim());
      }
      setCreateEntryModal(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.alert(`创建失败:\n${message}`);
    }
  }

  async function pickDirectory() {
    const selected = await openDialog({
      directory: true,
      multiple: false,
    });
    return typeof selected === "string" ? selected : null;
  }

  async function handleOpenExistingProject() {
    const selectedDir = await pickDirectory();
    if (!selectedDir || selectedDir === activeWorkspaceRoot || isStreaming) {
      return;
    }

    await saveDirtyFilesBeforeWorkspaceSwitch();
    const nextSnapshot = await loadSnapshotWithCollab(() => projectAdapter.switchProject(selectedDir));
    applyFreshWorkspaceSnapshot(nextSnapshot);
  }

  async function handleOpenProjectInNewWindow() {
    const selectedDir = await pickDirectory();
    if (!selectedDir) {
      return;
    }

    await desktop.launchWorkspaceWindow(selectedDir);
  }

  async function handleCreateNewProject() {
    const parentDir = await pickDirectory();
    if (!parentDir || isStreaming) {
      return;
    }
    const projectName = window.prompt("输入项目名称", "MyPaper");
    if (!projectName?.trim()) {
      return;
    }

    await saveDirtyFilesBeforeWorkspaceSwitch();
    const nextSnapshot = await loadSnapshotWithCollab(() => projectAdapter.createProject(parentDir, projectName.trim()));
    applyFreshWorkspaceSnapshot(nextSnapshot);
  }

  async function refreshAvailableCloudProjects() {
    if (!collabAuthSession) {
      setAvailableCloudProjects([]);
      return;
    }

    setIsLoadingCloudProjects(true);
    try {
      const projects = await listCloudProjects(collabAuthSession.token);
      setAvailableCloudProjects(projects);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAvailableCloudProjects([]);
      setCollabNotice({
        tone: "error",
        text: `读取项目列表失败：${message}`,
      });
    } finally {
      setIsLoadingCloudProjects(false);
    }
  }

  function resolveProjectReference(projectReference: string) {
    const resolvedProject = parseProjectReference(projectReference);
    if (!resolvedProject) {
      setCollabNotice({
        tone: "error",
        text: "请输入有效的 Project ID 或分享链接。",
      });
      return null;
    }

    if (resolvedProject.httpBaseUrl && resolvedProject.wsBaseUrl) {
      const nextConfig: CollabConfig = {
        httpBaseUrl: resolvedProject.httpBaseUrl,
        wsBaseUrl: resolvedProject.wsBaseUrl,
        teamLabel: collabConfigState?.teamLabel?.trim() || new URL(resolvedProject.httpBaseUrl).host,
      };
      if (
        collabConfigState?.httpBaseUrl !== nextConfig.httpBaseUrl ||
        collabConfigState?.wsBaseUrl !== nextConfig.wsBaseUrl ||
        collabConfigState?.teamLabel !== nextConfig.teamLabel
      ) {
        writeCollabConfig(nextConfig);
        setCollabConfigState(nextConfig);
      }
    }

    const { httpBaseUrl } = resolveCollabBaseUrls();
    if (!httpBaseUrl) {
      setCollabNotice({
        tone: "error",
        text: "这台电脑还没有协作服务器配置。请粘贴完整分享链接，而不是只填 Project ID。",
      });
      return null;
    }

    return resolvedProject;
  }

  async function hydrateCloudProjectWorkspace(
    token: string,
    projectId: string,
    rootMainFile: string,
    options?: {
      additionalSyncedPaths?: Iterable<string>;
    },
  ) {
    await ensureCloudDocument(token, projectId, rootMainFile);
    const documents = await listCloudDocuments(token, projectId);

    for (const document of documents.filter((item) => item.kind === "text" || item.kind === "tex" || item.kind === "bib")) {
      const snapshotUpdate = await fetchDocumentSnapshot(token, projectId, document.path);
      const content = decodeCollabTextSnapshot(snapshotUpdate);
      // Skip empty documents — don't create blank local files for unedited cloud placeholders
      if (content.trim() === "") continue;
      await fileAdapter.saveFile(document.path, content);
    }

    await seedCollabSyncBaseline(fileAdapter, projectId, documents, {
      additionalSyncedPaths: options?.additionalSyncedPaths,
    });

    // Download all binary blobs (images, etc.)
    const blobs = await listCloudBlobs(token, projectId);
    const blobHashes = new Map<string, string>();
    for (const blob of blobs) {
      try {
        const data = await downloadCloudBlob(token, projectId, blob.path);
        await desktop.saveFileBinary(blob.path, data);
        const hash = await computeHash(data);
        blobHashes.set(blob.path, hash);
      } catch (error) {
        console.warn("[collab.hydrate] failed to download blob", blob.path, error);
      }
    }
    await seedBlobBaseline(fileAdapter, projectId, blobs);
    // Patch in the hashes so first push won't re-upload everything
    if (blobHashes.size > 0) {
      const baseline = await readBlobSyncBaseline(fileAdapter, projectId);
      for (const [path, hash] of blobHashes) {
        baseline.hashes.set(path, hash);
      }
      await writeBlobSyncBaseline(fileAdapter, projectId, baseline);
    }
  }

  async function handleCreateCloudProject() {
    if (!snapshot || !collabAuthSession) {
      setCollabLoginMode("edit");
      setLoginModalOpen(true);
      return;
    }
    const { httpBaseUrl } = resolveCollabBaseUrls();
    if (!httpBaseUrl) {
      window.alert("请先在云协作面板中配置服务器地址。");
      openDrawerTab("collab");
      return;
    }
    const defaultName = workspaceLabelFromRoot(snapshot.projectConfig.rootPath);
    setCollabNotice(null);
    setCollabProjectModal({
      mode: "create",
      defaultValue: defaultName,
    });
  }

  async function handleSubmitCreateCloudProject(projectName: string) {
    if (!snapshot || !collabAuthSession || !projectName.trim()) {
      return;
    }

    setCollabBusyAction("create-project");
    setCollabNotice(null);

    try {
      const result = await createCloudProject(collabAuthSession.token, projectName.trim(), snapshot.projectConfig.mainTex);
      const collab: WorkspaceCollabMetadata = {
        mode: "cloud",
        cloudProjectId: result.projectId,
        checkoutRoot: snapshot.projectConfig.rootPath,
        linkedAt: new Date().toISOString(),
      };
      await writeWorkspaceCollabMetadata(fileAdapter, collab);
      setSnapshot((current) => (current ? { ...current, collab } : current));
      setLastManualCollabSyncAt("");
      setCollabSyncError("");
      setCollabProjectModal(null);
      setCollabNotice({
        tone: "success",
        text: `云项目已创建并关联：${projectName.trim()}。下一步请推送待同步文件。`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCollabNotice({
        tone: "error",
        text: `创建云项目失败：${message}`,
      });
    } finally {
      setCollabBusyAction(null);
    }
  }

  async function handleLinkCloudProject() {
    if (!snapshot || !collabAuthSession) {
      setCollabLoginMode("edit");
      setLoginModalOpen(true);
      return;
    }
    setCollabNotice(null);
    setCollabProjectModal({
      mode: "link",
      defaultValue: "",
    });
    void refreshAvailableCloudProjects();
  }

  function handleLinkCloudProjectFromWelcome() {
    setCollabNotice(null);
    setCollabProjectModal({
      mode: "link",
      defaultValue: "",
    });
    if (collabAuthSession) {
      void refreshAvailableCloudProjects();
    }
  }

  function handlePrepareBootstrapCloudProject(projectReference: string) {
    const resolvedProject = resolveProjectReference(projectReference);
    if (!resolvedProject) {
      return;
    }

    setPendingCloudProjectReference(projectReference.trim());
    setCollabProjectModal(null);
    setCollabLoginMode("bootstrap");
    setLoginModalOpen(true);
  }

  async function handleSubmitLinkCloudProject(projectReference: string) {
    if (!snapshot || !collabAuthSession) {
      return;
    }

    const resolvedProject = resolveProjectReference(projectReference);
    if (!resolvedProject) return;

    const cloudProjectId = resolvedProject.projectId;

    setCollabBusyAction("link-project");
    setCollabNotice(null);

    try {
      await joinCloudProject(collabAuthSession.token, cloudProjectId, resolvedProject.role);
      const project = await getCloudProject(collabAuthSession.token, cloudProjectId);
      const rootMainFile = project.rootMainFile?.trim() || "main.tex";
      const existingLocalTextPaths = collectTextPathsFromTree(snapshot.tree);

      await saveDirtyFilesBeforeWorkspaceSwitch();
      await hydrateCloudProjectWorkspace(collabAuthSession.token, cloudProjectId, rootMainFile, {
        additionalSyncedPaths: existingLocalTextPaths,
      });

      const collab: WorkspaceCollabMetadata = {
        mode: "cloud",
        cloudProjectId,
        checkoutRoot: snapshot.projectConfig.rootPath,
        linkedAt: new Date().toISOString(),
      };
      await writeWorkspaceCollabMetadata(fileAdapter, collab);
      await refreshWorkspace({
        activeFilePath,
        openTabs,
        openImageTabs,
        editorImagePath,
        previewSelection,
      });
      const linkedAt = new Date().toISOString();
      setLastManualCollabSyncAt(linkedAt);
      setCollabSyncError("");
      setCollabProjectModal(null);
      setCollabNotice({
        tone: "success",
        text: `云项目已关联并完成首次拉取：${project.name || cloudProjectId}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCollabNotice({
        tone: "error",
        text: `关联云项目失败：${message}`,
      });
    } finally {
      setCollabBusyAction(null);
    }
  }

  async function handleBootstrapCloudProject(projectReference: string, sessionOverride?: CollabAuthSession) {
    const resolvedProject = resolveProjectReference(projectReference);
    if (!resolvedProject) return;

    const session = sessionOverride ?? collabAuthSession;
    if (!session) {
      setPendingCloudProjectReference(projectReference);
      setCollabProjectModal(null);
      setCollabLoginMode("bootstrap");
      setLoginModalOpen(true);
      return;
    }

    setCollabBusyAction("link-project");
    setCollabNotice(null);

    try {
      await joinCloudProject(session.token, resolvedProject.projectId, resolvedProject.role);
      const project = await getCloudProject(session.token, resolvedProject.projectId);
      const parentDir = await pickDirectory();
      if (!parentDir || isStreaming) {
        return;
      }

      const localProjectName =
        sanitizeProjectFolderName(project.name) || `Cloud Project ${resolvedProject.projectId.slice(0, 8)}`;

      await saveDirtyFilesBeforeWorkspaceSwitch();

      // Create an empty directory and switch to it — do NOT use createProject
      // which generates template files (main.tex, sections/, refs/) that would
      // show up as untracked changes needing to be pushed.
      const projectRoot = `${parentDir}/${localProjectName.trim()}`;
      await desktop.createWorkspaceDir(projectRoot);
      const createdSnapshot = await loadSnapshotWithCollab(() => projectAdapter.switchProject(projectRoot));

      const rootMainFile = project.rootMainFile?.trim() || "main.tex";
      let projectConfig = createdSnapshot.projectConfig;
      if (rootMainFile !== createdSnapshot.projectConfig.mainTex) {
        projectConfig = await projectAdapter.updateProjectConfig({
          ...createdSnapshot.projectConfig,
          mainTex: rootMainFile,
        });
      }

      const collab: WorkspaceCollabMetadata = {
        mode: "cloud",
        cloudProjectId: resolvedProject.projectId,
        checkoutRoot: createdSnapshot.projectConfig.rootPath,
        linkedAt: new Date().toISOString(),
      };
      await writeWorkspaceCollabMetadata(fileAdapter, collab);

      setCollabProjectModal(null);
      setPendingCloudProjectReference(null);
      applyFreshWorkspaceSnapshot({
        ...createdSnapshot,
        projectConfig,
        collab,
      });
      setCollabNotice({
        tone: "success",
        text: `已创建本地工作区，正在同步云项目：${project.name || resolvedProject.projectId}`,
      });

      await hydrateCloudProjectWorkspace(session.token, resolvedProject.projectId, rootMainFile);

      const nextSnapshot = await loadSnapshotWithCollab(() => projectAdapter.openProject());
      applyFreshWorkspaceSnapshot(nextSnapshot);
      setLastManualCollabSyncAt(new Date().toISOString());
      setCollabSyncError("");
      setCollabNotice({
        tone: "success",
        text: `云项目已下载并关联：${project.name || resolvedProject.projectId}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCollabNotice({
        tone: "error",
        text: `关联云项目失败：${message}`,
      });
      window.alert(`关联云项目失败:\n${message}`);
    } finally {
      setCollabBusyAction(null);
    }
  }

  function handleCollabLogin(session: CollabAuthSession) {
    const nextPendingProjectReference = pendingCloudProjectReference;
    writeCollabAuthSession(session);
    setCollabAuthRevision((n) => n + 1);
    setCollabLoginMode("edit");
    setCollabNotice(null);
    setAvailableCloudProjects([]);
    setPendingCloudProjectReference(null);
    setLoginModalOpen(false);
    if (nextPendingProjectReference) {
      void handleBootstrapCloudProject(nextPendingProjectReference, session);
    }
  }

  function handleCollabLogout() {
    writeCollabAuthSession(null);
    setCollabAuthRevision((n) => n + 1);
    setCollabLoginMode("edit");
    setCollabNotice(null);
    setCollabProjectModal(null);
    setAvailableCloudProjects([]);
    setPendingCloudProjectReference(null);
    setLastManualCollabSyncAt("");
    setCollabSyncError("");
  }

  function handleSaveCollabConfig(config: CollabConfig) {
    setCollabBusyAction("save-config");
    try {
      writeCollabConfig(config);
      setCollabConfigState(config);
      setCollabNotice({
        tone: "success",
        text: "服务器配置已保存到本地。",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCollabNotice({
        tone: "error",
        text: `保存配置失败：${message}`,
      });
    } finally {
      setCollabBusyAction(null);
    }
  }

  function handleOpenShareLinkModal() {
    const projectId = snapshot?.collab?.cloudProjectId;
    if (!projectId || !currentCollabStatus.canShare) return;
    const { httpBaseUrl } = resolveCollabBaseUrls();
    if (!httpBaseUrl) return;
    setShareLinkModalOpen(true);
  }

  function handleCopyShareLink(role: CloudProjectRole) {
    const projectId = snapshot?.collab?.cloudProjectId;
    if (!projectId) return;
    const { httpBaseUrl } = resolveCollabBaseUrls();
    if (!httpBaseUrl) return;
    const link = generateShareLink(projectId, httpBaseUrl, role);
    navigator.clipboard.writeText(link).then(() => {
      setShareLinkModalOpen(false);
      window.alert(`分享链接已复制:\n${link}`);
    });
  }

  async function handleUnlinkCloudProject() {
    if (!snapshot?.collab?.cloudProjectId) {
      return;
    }

    const confirmed = window.confirm(
      "解除当前工作区与云项目的关联？这不会删除云端项目，但你可以随后重新创建或重新关联别的云项目。",
    );
    if (!confirmed) {
      return;
    }

    setCollabBusyAction("unlink-project");
    setCollabNotice(null);

    try {
      await clearWorkspaceCollabMetadata(fileAdapter);
      appendCollabDebugLog("[collab.local] workspace unlinked from cloud project", {
        projectId: snapshot.collab.cloudProjectId,
        workspaceRoot: snapshot.projectConfig.rootPath,
      });
      setSnapshot((current) => (current ? { ...current, collab: null } : current));
      setLastManualCollabSyncAt("");
      setCollabSyncError("");
      setCollabNotice({
        tone: "success",
        text: "当前工作区已解除云关联，可以重新创建或关联新的云项目。",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCollabNotice({
        tone: "error",
        text: `解除云关联失败：${message}`,
      });
    } finally {
      setCollabBusyAction(null);
    }
  }

  function handleIgnoreSyncPath(path: string) {
    const projectId = snapshot?.collab?.cloudProjectId;
    if (!projectId) return;
    setIgnoredSyncPaths((current) => {
      const next = new Set(current);
      next.add(path);
      localStorage.setItem(`viwerleaf.collab.ignored.${projectId}`, JSON.stringify([...next]));
      return next;
    });
  }

  function handleUnignoreSyncPath(path: string) {
    const projectId = snapshot?.collab?.cloudProjectId;
    if (!projectId) return;
    setIgnoredSyncPaths((current) => {
      const next = new Set(current);
      next.delete(path);
      localStorage.setItem(`viwerleaf.collab.ignored.${projectId}`, JSON.stringify([...next]));
      return next;
    });
  }

  async function handleSyncCloudWorkspace() {
    if (!snapshot || !snapshot.collab?.cloudProjectId || !collabManager) {
      return;
    }
    if (!currentCollabStatus.canComment) {
      setCollabNotice({
        tone: "error",
        text: "当前权限不能推送到云端。",
      });
      return;
    }

    setCollabBusyAction("sync-project");
    setCollabNotice(null);
    setCollabSyncError("");
    appendCollabDebugLog("[collab.manual] syncing workspace", {
      projectId: snapshot.collab.cloudProjectId,
      workspaceRoot: snapshot.projectConfig.rootPath,
      mode: "push",
    });

    try {
      const result = await collabManager.syncWorkspaceNow(snapshot);

      // Push new/modified images to KV
      let blobSyncedCount = 0;
      const collabMeta = snapshot.collab;
      if (collabMeta?.cloudProjectId && collabAuthSession) {
        const token = collabAuthSession.token;
        const projectId = collabMeta.cloudProjectId;
        const blobBaseline = await readBlobSyncBaseline(fileAdapter, projectId);
        const localImagePaths = collectImagePaths(snapshot.tree);
        for (const imagePath of localImagePaths) {
          if (ignoredSyncPaths.has(imagePath)) continue;
          try {
            const data = await desktop.readFileBinary(imagePath);
            if (!data || data.length === 0) continue;
            const hash = await computeHash(data);
            const storedHash = blobBaseline.hashes.get(imagePath);
            const syncedVersion = blobBaseline.versions.get(imagePath) ?? 0;
            // Upload if never pushed OR content changed
            if (syncedVersion === 0 || storedHash !== hash) {
              const latestVersion = await uploadCloudBlob(token, projectId, imagePath, data, imageMimeType(imagePath));
              blobBaseline.versions.set(imagePath, latestVersion);
              blobBaseline.hashes.set(imagePath, hash);
              blobSyncedCount += 1;
            }
          } catch (error) {
            console.warn("[collab.sync] failed to upload blob", imagePath, error);
          }
        }
        if (blobSyncedCount > 0) {
          await writeBlobSyncBaseline(fileAdapter, projectId, blobBaseline);
        }
      }

      await refreshCollabSyncSummary();
      const totalSynced = result.syncedCount + blobSyncedCount;
      if (totalSynced > 0) {
        const syncedAt = new Date().toISOString();
        setLastManualCollabSyncAt(syncedAt);
        const parts: string[] = [];
        if (result.syncedCount > 0) parts.push(`${result.syncedCount} 个文本文件`);
        if (blobSyncedCount > 0) parts.push(`${blobSyncedCount} 个图片`);
        setCollabNotice({
          tone: "success",
          text: `已推送 ${parts.join("、")} 到云端。`,
        });
        appendCollabDebugLog("[collab.manual] workspace sync succeeded", {
          projectId: snapshot.collab.cloudProjectId,
          syncedCount: result.syncedCount,
          blobSyncedCount,
          syncedAt,
        });
      } else {
        setCollabNotice({
          tone: "success",
          text: "当前没有待同步的文件。",
        });
        appendCollabDebugLog("[collab.manual] workspace sync skipped", {
          projectId: snapshot.collab.cloudProjectId,
          reason: "no-pending-files",
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCollabSyncError(message);
      setCollabNotice({
        tone: "error",
        text: `手动同步失败：${message}`,
      });
      appendCollabDebugLog("[collab.manual] workspace sync failed", {
        projectId: snapshot.collab.cloudProjectId,
        message,
      });
    } finally {
      setCollabBusyAction(null);
    }
  }

  async function handlePullCloudWorkspace() {
    if (!snapshot || !snapshot.collab?.cloudProjectId || !collabManager) {
      return;
    }

    setCollabBusyAction("pull-project");
    setCollabNotice(null);
    setCollabSyncError("");
    appendCollabDebugLog("[collab.manual] pulling workspace from cloud", {
      projectId: snapshot.collab.cloudProjectId,
      workspaceRoot: snapshot.projectConfig.rootPath,
    });

    try {
      const result = await collabManager.pullWorkspace(snapshot);

      // Pull new/updated blobs from KV
      let blobPulledCount = 0;
      const collabMeta = snapshot.collab;
      if (collabMeta?.cloudProjectId && collabAuthSession) {
        const token = collabAuthSession.token;
        const projectId = collabMeta.cloudProjectId;
        const remoteBlobs = await listCloudBlobs(token, projectId);
        const blobBaseline = await readBlobSyncBaseline(fileAdapter, projectId);
        for (const blob of remoteBlobs) {
          const blobPath = normalizeProjectPath(blob.path);
          const syncedVersion = blobBaseline.versions.get(blobPath) ?? 0;
          if (blob.latestVersion > syncedVersion) {
            try {
              const data = await downloadCloudBlob(token, projectId, blob.path);
              await desktop.saveFileBinary(blobPath, data);
              blobBaseline.versions.set(blobPath, blob.latestVersion);
              const hash = await computeHash(data);
              blobBaseline.hashes.set(blobPath, hash);
              blobPulledCount += 1;
            } catch (error) {
              console.warn("[collab.pull] failed to download blob", blob.path, error);
            }
          }
        }
        if (blobPulledCount > 0) {
          await writeBlobSyncBaseline(fileAdapter, projectId, blobBaseline);
        }
      }

      const syncedAt = new Date().toISOString();
      const totalPulled = result.syncedCount + blobPulledCount;
      if (totalPulled > 0) {
        await refreshWorkspace();
      } else {
        await refreshCollabSyncSummary();
      }
      setLastManualCollabSyncAt(syncedAt);
      if (totalPulled > 0) {
        const parts: string[] = [];
        if (result.syncedCount > 0) parts.push(`${result.syncedCount} 个文本文件`);
        if (blobPulledCount > 0) parts.push(`${blobPulledCount} 个图片`);
        setCollabNotice({
          tone: "success",
          text: `已从云端拉取 ${parts.join("、")}。`,
        });
      } else {
        setCollabNotice({
          tone: "success",
          text: "当前没有待拉取的文件。",
        });
      }
      appendCollabDebugLog("[collab.manual] workspace pull succeeded", {
        projectId: snapshot.collab.cloudProjectId,
        syncedCount: result.syncedCount,
        blobPulledCount,
        syncedAt,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCollabSyncError(message);
      setCollabNotice({
        tone: "error",
        text: `拉取云端内容失败：${message}`,
      });
      appendCollabDebugLog("[collab.manual] workspace pull failed", {
        projectId: snapshot.collab.cloudProjectId,
        message,
      });
    } finally {
      setCollabBusyAction(null);
    }
  }

  const handleAddComment = useEffectEvent((
    lineStart: number,
    lineEnd: number,
    selectedText: string,
    commentText?: string,
  ) => {
    if (!commentStore || !collabAuthSession || !activeFile || !currentCollabStatus.canComment) return;
    const text =
      typeof commentText === "string"
        ? commentText.trim()
        : window.prompt("输入批注内容：", selectedText ? `关于 "${selectedText.slice(0, 30)}…"` : "")?.trim();
    if (!text) return;
    commentStore.addComment({
      userId: collabAuthSession.userId,
      userName: collabAuthSession.name,
      userColor: collabAuthSession.color,
      filePath: activeFile.path,
      lineStart,
      lineEnd,
      text: text.trim(),
    });
  });

  const handleResolveComment = useEffectEvent((id: string) => {
    if (!currentCollabStatus.canComment) return;
    commentStore?.resolveComment(id);
  });

  const handleReplyComment = useEffectEvent((id: string, text: string) => {
    if (!commentStore || !collabAuthSession || !currentCollabStatus.canComment) return;
    commentStore.addReply(id, {
      userId: collabAuthSession.userId,
      userName: collabAuthSession.name,
      userColor: collabAuthSession.color,
      text,
      timestamp: new Date().toISOString(),
    });
  });

  const handleDeleteComment = useEffectEvent((id: string) => {
    if (!currentCollabStatus.canComment) return;
    commentStore?.deleteComment(id);
  });

  const handleJumpToCommentLine = useEffectEvent((line: number) => {
    if (!activeFile) return;
    setEditorJumpTarget({ path: activeFile.path, line, nonce: Date.now() });
  });

  async function handleCloseWorkspaceTab(rootPath: string) {
    const nextTabs = workspaceTabs.filter((entry) => entry.rootPath !== rootPath);
    const isCurrentWorkspace = rootPath === activeWorkspaceRoot;

    if (nextTabs.length === 0) {
      return;
    }

    setWorkspaceTabs(nextTabs);

    if (!isCurrentWorkspace) {
      return;
    }

    const currentIndex = workspaceTabs.findIndex((entry) => entry.rootPath === rootPath);
    const fallbackEntry = nextTabs[Math.max(0, currentIndex - 1)] ?? nextTabs[0];
    if (fallbackEntry) {
      await activateWorkspace(fallbackEntry.rootPath);
    }
  }

  const handleNativeMenuAction = useEffectEvent((payload: AppMenuAction) => {
    switch (payload.action) {
      case "open-project":
        void handleOpenExistingProject();
        break;
      case "open-project-new-window":
        void handleOpenProjectInNewWindow();
        break;
      case "new-project":
        void handleCreateNewProject();
        break;
      case "open-recent-workspace":
        if (payload.rootPath) {
          void activateWorkspace(payload.rootPath);
        }
        break;
      case "clear-recent-workspaces":
        setRecentWorkspaces([]);
        break;
      case "save-current":
        void handleSaveCurrentFile();
        break;
      case "save-all":
        void handleSaveAllFiles();
        break;
      case "toggle-auto-save":
        setIsAutoSaveEnabled(Boolean(payload.checked));
        break;
      case "toggle-compile-on-save":
        void handleSetAutoCompile(Boolean(payload.checked));
        break;
    }
  });

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let unlisten: (() => void | Promise<void>) | undefined;

    void desktop.onAppMenuAction((payload) => {
      handleNativeMenuAction(payload);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      safelyDisposeListener(unlisten);
    };
  }, [handleNativeMenuAction]);

  const previewState = useMemo<PreviewPaneState | null>(() => {
    if (!snapshot) {
      return null;
    }

    if (previewSelection.kind === "asset") {
      const node = getNodeByPath(snapshot.tree, previewSelection.path);
      const asset = previewAsset;
      const fallbackTitle = previewSelection.path.split("/").at(-1) ?? previewSelection.path;
      const resolvedFileType = node?.fileType ?? detectProjectFileType(previewSelection.path);
      if (!asset) {
        return {
          kind: "unsupported",
          title: node?.name ?? fallbackTitle,
          description: previewAssetLoadError || "正在加载预览资源…",
        };
      }
      if (resolvedFileType === "pdf") {
        const fileData = asset.data instanceof Uint8Array ? asset.data : undefined;
        const fileUrl = asset.resourceUrl ?? desktop.resolveResourceUrl(asset.absolutePath);
        if (!resolvePdfSource(fileData, fileUrl)) {
          return {
            kind: "unsupported",
            title: node?.name ?? fallbackTitle,
            description: previewAssetLoadError || "正在加载预览资源…",
          };
        }
        return {
          kind: "pdf",
          title: node?.name ?? fallbackTitle,
          fileData,
          fileUrl: undefined,
          isLoading: false,
          onDebug: compilePipeline.logCompileDebug,
          highlightedPage: compilePipeline.highlightedPage,
          highlights: undefined,
          onPageJump: () => undefined,
          onDoubleClickPage: undefined,
        };
      }
      if (!asset.resourceUrl) {
        return {
          kind: "unsupported",
          title: node?.name ?? fallbackTitle,
          description: previewAssetLoadError || "正在加载预览资源…",
        };
      }
      if (resolvedFileType === "image") {
        return {
          kind: "image",
          title: node?.name ?? fallbackTitle,
          fileUrl: asset.resourceUrl ?? "",
        };
      }
      return {
        kind: "unsupported",
        title: node?.name ?? fallbackTitle,
        description: "该文件类型暂时不支持内置预览。",
      };
    }

    if (previewSelection.kind === "unsupported") {
      return {
        kind: "unsupported",
        title: previewSelection.title,
        description: previewSelection.description,
      };
    }

    const inlineCompileData =
      compilePipeline.compilePdfData ??
      (snapshot.compileResult.pdfData instanceof Uint8Array ? snapshot.compileResult.pdfData : undefined);
    const hasCompileSource = Boolean(resolvePdfSource(inlineCompileData, undefined, false));

    if (!hasCompileSource && compilePipeline.compilePreviewLoadError) {
      return {
        kind: "unsupported",
        title: "PDF 预览",
        description: compilePipeline.compilePreviewLoadError,
      };
    }

    return {
      kind: "compile",
      compileResult: snapshot.compileResult,
      fileData: inlineCompileData,
      fileUrl: undefined,
      reloadKey:
        compilePipeline.compilePdfLoadedKey ||
        `${snapshot.compileResult.timestamp}:${snapshot.compileResult.pdfPath ?? ""}`,
      isLoading:
        snapshot.compileResult.status === "running" ||
        (compilePipeline.isLoadingCompilePdf && !hasCompileSource),
      onDebug: compilePipeline.logCompileDebug,
      highlightedPage: compilePipeline.highlightedPage,
      highlights: compilePipeline.syncHighlights,
      onPageJump: (page) => {
        void compilePipeline.handlePageJump(page);
      },
      onDoubleClickPage: (page, h, v) => {
        void compilePipeline.handleDoubleClickPage(page, h, v);
      },
    };
  }, [compilePipeline, previewAsset, previewAssetLoadError, previewSelection, snapshot]);

  const frontendCompileDebugLog = useMemo(
    () => compilePipeline.compileDebugLogLines.join("\n"),
    [compilePipeline.compileDebugLogLines],
  );
  const mergedCompileLog = useMemo(() => {
    const sections: string[] = [];
    const backendLog = snapshot?.compileResult.logOutput?.trim();
    if (backendLog) {
      sections.push(backendLog);
    }
    if (runtimeDebugLogLines.length > 0) {
      sections.push(`=== Runtime Errors ===\n${runtimeDebugLogLines.join("\n")}`);
    }
    if (collabDebugLogLines.length > 0) {
      sections.push(`=== Collaboration Debug ===\n${collabDebugLogLines.join("\n")}`);
    }
    if (workspaceDebugLogLines.length > 0) {
      sections.push(`=== Workspace Debug ===\n${workspaceDebugLogLines.join("\n")}`);
    }
    if (frontendCompileDebugLog) {
      sections.push(`=== Frontend Debug ===\n${frontendCompileDebugLog}`);
    }
    return sections.join("\n\n");
  }, [
    collabDebugLogLines,
    frontendCompileDebugLog,
    runtimeDebugLogLines,
    snapshot?.compileResult.logOutput,
    workspaceDebugLogLines,
  ]);

  const outlineNode = useMemo(() => {
    if (outlineLoading) {
      return <div className="text-subtle text-sm" style={{ padding: "12px 8px" }}>正在分析文档结构…</div>;
    }

    return (
      <div>
        {outlineWarnings.length > 0 && (
          <div className="card" style={{ margin: "8px 8px 12px" }}>
            <div className="card-header">Outline Warnings</div>
            <div className="card-body">有 {outlineWarnings.length} 个 `\\input` / `\\include` 文件未能解析，已跳过。</div>
          </div>
        )}
        <OutlineTree
          nodes={outlineTree}
          activeId={activeOutlineId}
          onSelectNode={(node) => {
            openTextFile(node.heading.filePath, node.heading.line);
          }}
        />
      </div>
    );
  }, [activeOutlineId, openTextFile, outlineLoading, outlineTree, outlineWarnings.length]);

  const researchSnapshot = useMemo(
    () => (snapshot?.research ? localizeResearchSnapshot(snapshot.research, locale) : null),
    [locale, snapshot?.research],
  );
  const currentResearchStageSummary =
    researchSnapshot?.stageSummaries.find((stage) => stage.stage === researchSnapshot.currentStage) ?? null;
  const publicationTask =
    researchSnapshot
      ? (
        researchSnapshot.nextTask?.stage === "publication"
          ? researchSnapshot.nextTask
          : researchSnapshot.tasks.find(
            (task) => task.stage === "publication" && !isResearchTaskClosed(task),
          ) ?? null
      )
      : null;
  const showResearchSurface = hasProject && workspaceSurface === "research";
  const showWritingSurface = !showResearchSurface;
  const showResearchHandoffBanner = Boolean(
    showWritingSurface &&
    researchSnapshot &&
    (researchSnapshot.currentStage === "publication" || researchSnapshot.handoffToWriting),
  );

  if (bootstrapError) {
    return <div className="app-shell loading-shell">ViewerLeaf failed to start: {bootstrapError}</div>;
  }

  if (!snapshot) {
    return <div className="app-shell loading-shell">正在启动 ViewerLeaf…</div>;
  }

  const compileStatusLabel =
    snapshot.compileResult.status === "success"
      ? (isZh ? "成功" : "Success")
      : snapshot.compileResult.status === "failed"
        ? (isZh ? "失败" : "Failed")
        : snapshot.compileResult.status === "running"
          ? (isZh ? "正在编译" : "Compiling")
          : (isZh ? "空闲" : "Idle");
  const compileNeedsAttention = Boolean(
    compileEnvironment &&
    (!compileEnvironment.ready ||
      !compileEnvironment.availableEngines.includes(snapshot.projectConfig.engine as LatexEngine)),
  );

  function handleDismissReleaseNotes() {
    if (typeof window !== "undefined" && releaseNotesModal) {
      window.localStorage.setItem(RELEASE_NOTES_VERSION_STORAGE_KEY, releaseNotesModal.version);
    }
    setReleaseNotesModal(null);
  }

  return (
    <div className={`app-shell fade-in ${hasProject ? "" : "is-welcome"}`}>
      <header
        className={`topbar ${hasProject ? "" : "topbar--welcome"} ${isMacOverlayWindow ? "topbar--overlay" : ""} ${isWindows ? "topbar--windows" : ""}`}
        data-tauri-drag-region={(isMacOverlayWindow || isWindows) ? "true" : undefined}
      >
        <div className="topbar-left">
          {!hasProject ? (
            <span className="brand-title brand-title--welcome">
              ViewerLeaf
            </span>
          ) : null}
          {hasProject && (
            <WorkspaceMenuBar
              showInAppFileMenu={!isTauriRuntime()}
              hasProject={hasProject}
              hasDirtyChanges={dirtyPaths.length > 0}
              activeWorkspaceRoot={activeWorkspaceRoot}
              workspaceTabs={workspaceTabs}
              recentWorkspaces={recentWorkspaces}
              isAutoSaveEnabled={isAutoSaveEnabled}
              isCompileOnSaveEnabled={snapshot.projectConfig.autoCompile}
              isBusy={isStreaming}
              onOpenProject={() => void handleOpenExistingProject()}
              onCreateProject={() => void handleCreateNewProject()}
              onSaveCurrent={() => void handleSaveCurrentFile()}
              onSaveAll={() => void handleSaveAllFiles()}
              onToggleAutoSave={setIsAutoSaveEnabled}
              onToggleCompileOnSave={(enabled) => void handleSetAutoCompile(enabled)}
              onSelectWorkspace={(rootPath) => void activateWorkspace(rootPath)}
              onCloseWorkspaceTab={(rootPath) => void handleCloseWorkspaceTab(rootPath)}
            />
          )}
        </div>
        {hasProject && (
          <>
            <div className="topbar-center">
              <div className="surface-switcher">
                <button
                  type="button"
                  className={`surface-switcher__btn ${workspaceSurface === "research" ? "is-active" : ""}`}
                  onClick={() => setWorkspaceSurface("research")}
                >
                  {isZh ? "研究画布" : "Research Canvas"}
                </button>
                <button
                  type="button"
                  className={`surface-switcher__btn ${workspaceSurface === "writing" ? "is-active" : ""}`}
                  onClick={() => setWorkspaceSurface("writing")}
                >
                  {isZh ? "写作台" : "Writing Desk"}
                </button>
              </div>
              {workspaceSurface === "writing" ? (
                <span className="topbar-metric">
                  {isZh ? "编译状态" : "Compile"}
                  <strong>{compileStatusLabel}</strong>
                </span>
              ) : (
                <>
                  <span className="topbar-metric">
                    {isZh ? "当前阶段" : "Stage"}
                    <strong>{currentResearchStageSummary?.label ?? "Research Canvas"}</strong>
                  </span>
                  <span className="topbar-metric">
                    {isZh ? "下一任务" : "Next Task"}
                    <strong>{researchSnapshot?.nextTask?.title ?? (isZh ? "等待定义" : "Awaiting definition")}</strong>
                  </span>
                </>
              )}
            </div>
            <div className="topbar-right">
              {workspaceSurface === "writing" ? (
                <>
                  <span className="topbar-metric">{isZh ? "诊断结果" : "Diagnostics"} <strong>{snapshot.compileResult.diagnostics.length}{isZh ? " 项" : ""}</strong></span>
                  <button
                    className={`topbar-terminal-btn hover-spring ${isTerminalVisible ? "is-active" : ""}`}
                    onClick={() => setIsTerminalVisible((current) => !current)}
                    type="button"
                    title={isTerminalVisible ? (isZh ? "隐藏终端" : "Hide terminal") : (isZh ? "打开终端" : "Open terminal")}
                    aria-label={isTerminalVisible ? (isZh ? "隐藏终端" : "Hide terminal") : (isZh ? "打开终端" : "Open terminal")}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                      <polyline points="7 9 11 12 7 15"></polyline>
                      <line x1="13" y1="15" x2="17" y2="15"></line>
                    </svg>
                  </button>
                  <button
                    className="compile-launch-btn hover-spring"
                    onClick={() => void handleInteractiveCompile()}
                    type="button"
                    disabled={snapshot.compileResult.status === "running"}
                    title={compileNeedsAttention
                      ? (isZh ? "本地 TeX 环境未就绪，打开 LaTeX 配置" : "TeX environment is not ready, open LaTeX setup")
                      : (isZh ? "编译当前项目" : "Compile current project")}
                    aria-label={compileNeedsAttention
                      ? (isZh ? "打开 LaTeX 配置" : "Open LaTeX setup")
                      : (isZh ? "编译当前项目" : "Compile current project")}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <polygon points="8,5 19,12 8,19" fill="currentColor"></polygon>
                    </svg>
                  </button>
                </>
              ) : null}
            </div>
          </>
        )}
        {isWindows && (
          <div className="win-controls" onMouseDown={(e) => e.stopPropagation()}>
            <button
              className="win-ctrl win-ctrl--min"
              title="最小化"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => void desktop.minimizeWindow()}
              aria-label="最小化"
            >
              <svg viewBox="0 0 10 1" width="10" height="1"><rect width="10" height="1" fill="currentColor"/></svg>
            </button>
            <button
              className="win-ctrl win-ctrl--max"
              title="最大化"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => void desktop.toggleMaximizeWindow()}
              aria-label="最大化"
            >
              <svg viewBox="0 0 10 10" width="10" height="10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>
            </button>
            <button
              className="win-ctrl win-ctrl--close"
              title="关闭"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => void desktop.closeWindow()}
              aria-label="关闭"
            >
              <svg viewBox="0 0 10 10" width="10" height="10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/></svg>
            </button>
          </div>
        )}
      </header>

      <div className="workspace-container">
          <div className="activity-bar-shell" ref={activityBarShellRef}>
          <div className="activity-bar">
            <button
              className={`activity-icon hover-spring ${isDrawerVisible && drawerTab === "project" ? "is-active" : ""}`}
              onClick={() => toggleDrawerTab("project")}
              title={isZh ? "项目" : "Project"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7h5l2 2h11v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path>
              </svg>
            </button>
            <button
              className={`activity-icon hover-spring ${isDrawerVisible && drawerTab === "sync" ? "is-active" : ""}`}
              onClick={() => toggleDrawerTab("sync")}
              title={isZh ? "源码管理" : "Source Control"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 6v12"></path>
                <path d="M6 8h8a3 3 0 0 0 0-6"></path>
                <path d="M18 18V6"></path>
                <path d="M18 16h-8a3 3 0 0 0 0 6"></path>
              </svg>
            </button>
            <button
              className={`activity-icon hover-spring ${isDrawerVisible && drawerTab === "latex" ? "is-active" : ""}`}
              onClick={() => toggleDrawerTab("latex")}
              title={isZh ? "LaTeX 编译配置" : "LaTeX Setup"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4h10l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"></path><path d="M14 4v4h4"></path><path d="M8 12h8"></path><path d="M8 16h6"></path></svg>
              {compileNeedsAttention && <span className="activity-icon-dot activity-icon-dot-warning"></span>}
            </button>
            <button
              className={`activity-icon hover-spring ${isDrawerVisible && drawerTab === "ai" ? "is-active" : ""}`}
              onClick={() => toggleDrawerTab("ai")}
              title={isZh ? "AI 智能体助手" : "AI Assistant"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>
            </button>
            <button
              className={`activity-icon hover-spring ${isDrawerVisible && drawerTab === "figures" ? "is-active" : ""}`}
              onClick={() => toggleDrawerTab("figures")}
              title={isZh ? "图表工作区" : "Figures"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
            </button>
            <button
              className={`activity-icon hover-spring ${isDrawerVisible && drawerTab === "skills" ? "is-active" : ""}`}
              onClick={() => toggleDrawerTab("skills")}
              title={isZh ? "应用与技能" : "Apps & Skills"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
            </button>
            <button
              className={`activity-icon hover-spring ${isDrawerVisible && drawerTab === "usage" ? "is-active" : ""}`}
              onClick={() => toggleDrawerTab("usage")}
              title={isZh ? "模型用量" : "Usage"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"></path><path d="M7 14l4-4 3 3 5-7"></path></svg>
            </button>
            <button
              className={`activity-icon hover-spring ${isDrawerVisible && drawerTab === "collab" ? "is-active" : ""}`}
              onClick={() => toggleDrawerTab("collab")}
              title={isZh ? "云协作与审阅" : "Cloud Collaboration"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
            </button>

            <div style={{ flex: 1 }}></div>

            <button
              className={`activity-icon hover-spring ${isDrawerVisible && drawerTab === "logs" ? "is-active" : ""}`}
              onClick={() => toggleDrawerTab("logs")}
              title={isZh ? "编译日志" : "Compile Logs"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
              {snapshot.compileResult.diagnostics.length > 0 && <span style={{ position: "absolute", top: 2, right: 2, width: 8, height: 8, borderRadius: "50%", background: "var(--danger)" }}></span>}
            </button>
            <button
              className={`activity-icon hover-spring ${isSettingsOpen ? "is-active" : ""}`}
              onClick={() => setIsSettingsOpen((current) => !current)}
              title={isZh ? "设置" : "Settings"}
              aria-label={isZh ? "设置" : "Settings"}
              type="button"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33"></path>
                <path d="M4.6 9A1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 8.92 4"></path>
                <path d="M9 19.08A1.65 1.65 0 0 0 7.18 19l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4 14.92"></path>
                <path d="M15 4.92A1.65 1.65 0 0 0 16.82 5l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 20 9.08"></path>
              </svg>
            </button>
          </div>
          {isSettingsOpen && (
            <div className="activity-settings-popover">
              <div className="activity-settings-popover__eyebrow">{isZh ? "设置" : "Settings"}</div>
              <div className="activity-settings-popover__section">
                <div className="activity-settings-popover__label">{isZh ? "界面语言" : "Interface language"}</div>
                <div className="activity-settings-popover__options">
                  <button
                    type="button"
                    className={`activity-settings-popover__option ${locale === "zh-CN" ? "is-active" : ""}`}
                    onClick={() => setLocale("zh-CN")}
                  >
                    中文
                  </button>
                  <button
                    type="button"
                    className={`activity-settings-popover__option ${locale === "en-US" ? "is-active" : ""}`}
                    onClick={() => setLocale("en-US")}
                  >
                    English
                  </button>
                </div>
              </div>
            </div>
          )}
          </div>

          {isDrawerVisible && (drawerTab === "project" ? (
            <ProjectSidebar
              locale={locale}
              projectName={workspaceLabelFromRoot(snapshot.projectConfig.rootPath) || (isZh ? "未命名项目" : "Untitled Project")}
              mode={workspacePaneMode}
              nodes={snapshot.tree}
              activeFile={focusedTreePath}
              dirtyPaths={dirtyPathSet}
              collabSyncStates={collabWorkspaceSyncSummary.byPath}
              outlineContent={outlineNode}
              onModeChange={setWorkspacePaneMode}
              onOpenNode={handleOpenNode}
              onCreateFile={handleCreateFile}
              onCreateFolder={handleCreateFolder}
              onDeleteFile={handleDeleteFile}
              onRenameFile={handleRenameFile}
              onRequestCreateFile={() => void handleQuickCreateFile()}
              onRequestCreateFolder={() => void handleQuickCreateFolder()}
            />
          ) : drawerTab === "sync" ? (
            <SyncSidebar
              locale={locale}
              projectId={snapshot.collab?.cloudProjectId ?? null}
              workspaceLabel={workspaceLabelFromRoot(snapshot.projectConfig.rootPath)}
              linkedAt={snapshot.collab?.linkedAt ?? ""}
              notice={collabNotice}
              lastSyncAt={lastManualCollabSyncAt}
              role={currentCollabStatus.role}
              collabStatus={currentCollabStatus}
              busyAction={collabBusyAction}
              changes={syncChangeEntries}
              ignoredPaths={ignoredSyncPaths}
              onIgnorePath={handleIgnoreSyncPath}
              onUnignorePath={handleUnignoreSyncPath}
              onPush={() => void handleSyncCloudWorkspace()}
              onPull={() => void handlePullCloudWorkspace()}
              onOpenShareModal={handleOpenShareLinkModal}
              onCreateProject={() => void handleCreateCloudProject()}
              onLinkProject={() => void handleLinkCloudProject()}
              onOpenCollabSettings={() => openDrawerTab("collab")}
            />
          ) : (
            <Sidebar
              locale={locale}
              tab={drawerTab}
              messages={messages}
              sessions={agentSessions}
              activeSessionId={activeSessionId}
              onSelectSession={(sessionId) => void handleSelectSession(sessionId)}
              onNewSession={() => void handleNewSession()}
              onRunAgent={handleRunAgent}
              pendingPatchSummary={pendingPatch?.summary}
              onApplyPatch={handleApplyPatch}
              compileLog={mergedCompileLog}
              compileStatus={snapshot.compileResult.status}
              projectConfig={snapshot.projectConfig}
              compileEnvironment={compileEnvironment}
              isCheckingCompileEnvironment={isCheckingCompileEnvironment}
              onRefreshCompileEnvironment={() => void refreshCompileEnvironment()}
              onSetCompileEngine={(engine) => void handleSetCompileEngine(engine)}
              onSetAutoCompile={(enabled) => void handleSetAutoCompile(enabled)}
              diagnosticsCount={snapshot.compileResult.diagnostics.length}
              briefs={snapshot.figureBriefs}
              assets={snapshot.assets}
              selectedBriefId={selectedBrief?.id}
              selectedAssetId={selectedAsset?.id}
              onCreateBrief={handleCreateBrief}
              onRunFigureSkill={handleRunFigureSkill}
              onGenerateFigure={handleGenerateFigure}
              onInsertFigure={handleInsertFigure}
              onSelectBrief={(briefId: string) => setSelectedBrief(snapshot.figureBriefs.find((brief) => brief.id === briefId) ?? null)}
              onSelectAsset={(assetId: string) => setSelectedAsset(snapshot.assets.find((asset) => asset.id === assetId) ?? null)}
              providers={snapshot.providers}
              activeProviderId={activeProfile?.providerId || snapshot.providers.find((p) => p.isEnabled)?.id}
              activeChatProfile={activeProfile}
              skills={snapshot.skills}
              usageRecords={usageRecords}
              onSelectChatVendor={handleSelectChatVendor}
              onSelectChatModel={handleSelectChatModel}
              onToggleSkill={handleToggleSkill}
              onSkillsChanged={handleSkillsChanged}
              streamThinkingText={streamThinkingText}
              streamThinkingHistoryText={streamThinkingHistoryText}
              streamThinkingDurationMs={streamThinkingDurationMs}
              streamContent={streamContent}
              streamError={streamError}
              isStreaming={isStreaming}
              onSendMessage={handleSendMessage}
              onDismissPatch={handleDismissPatch}
              collabAuthSession={collabAuthSession}
              collabConfig={collabConfigState}
              cloudCollab={snapshot.collab ?? null}
              collabBusyAction={collabBusyAction}
              collabNotice={collabNotice}
              collabStatus={currentCollabStatus}
              activeFilePath={activeFilePath}
              onOpenLoginModal={() => {
                setCollabLoginMode("edit");
                setLoginModalOpen(true);
              }}
              onLogout={handleCollabLogout}
              onSaveCollabConfig={handleSaveCollabConfig}
              onCreateCloudProject={() => void handleCreateCloudProject()}
              onLinkCloudProject={() => void handleLinkCloudProject()}
              onUnlinkCloudProject={() => void handleUnlinkCloudProject()}
              onCopyShareLink={handleOpenShareLinkModal}
              onWorkerLogin={() => handleWorkerTerminalAction("login")}
              onWorkerDeploy={() => handleWorkerTerminalAction("deploy")}
              onWorkerLoginAndDeploy={() => handleWorkerTerminalAction("login-deploy")}
              comments={activeDocComments}
              onResolveComment={handleResolveComment}
              onReplyComment={handleReplyComment}
              onDeleteComment={handleDeleteComment}
              onJumpToCommentLine={handleJumpToCommentLine}
            />
          ))}

          <div className="workspace-body" ref={workspaceBodyRef}>
            {showResearchSurface ? (
              <div className="workspace-main">
                <ResearchCanvas
                  locale={locale}
                  research={researchSnapshot}
                  isBusy={isResearchBootstrapBusy}
                  onBootstrap={handleEnsureResearchScaffold}
                  onOpenArtifact={handleOpenResearchArtifact}
                  onUseTaskInChat={handleUseResearchTaskInChat}
                  onOpenWriting={() => setWorkspaceSurface("writing")}
                />
              </div>
            ) : (
              <>
                <div className="workspace-main">
                  {showResearchHandoffBanner && (
                    <div className="research-handoff-banner">
                      <div className="research-handoff-banner__meta">
                        <div className="research-inspector__eyebrow">{isZh ? "写作接力" : "Publication Handoff"}</div>
                        <strong>{publicationTask?.title ?? (isZh ? "进入论文写作阶段" : "Move into paper writing")}</strong>
                        <span>{publicationTask?.description ?? (isZh ? "当前研究流程已经进入论文撰写与整理阶段。" : "The workflow has moved into manuscript drafting and cleanup.")}</span>
                        {publicationTask?.suggestedSkills.length ? (
                          <div className="research-node-chips">
                            {publicationTask.suggestedSkills.map((skillId) => (
                              <span key={skillId} className="research-node-chip">{skillId}</span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className="research-handoff-banner__actions">
                        <button
                          type="button"
                          className="research-secondary-btn"
                          onClick={() => setWorkspaceSurface("research")}
                        >
                          {isZh ? "返回研究画布" : "Back to Research Canvas"}
                        </button>
                        {publicationTask ? (
                          <button
                            type="button"
                            className="research-primary-btn"
                            onClick={() => void handleUseResearchTaskInChat(publicationTask)}
                          >
                            {isZh ? "发送到聊天" : "Use in Chat"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  )}
                  <div className="workspace-main-content" ref={editorPreviewSplitRef}>
                    <div className="editor-area">
                      <div className="editor-tabs" onWheel={handleEditorTabsWheel}>
                      {editorTabs.map((tab) => {
                        const isImageTab = openImageTabSet.has(tab);
                        const isActive = tab === activeEditorTabPath;
                        const tabLabel = tab.split("/").at(-1) ?? tab;
                        return (
                          <div
                            key={tab}
                            className={`editor-tab ${isActive ? "is-active" : ""}`}
                            data-active={isActive ? "true" : "false"}
                            title={tab}
                          >
                            <button
                              className="editor-tab-trigger"
                              onClick={() => (isImageTab ? openImageFile(tab) : openTextFile(tab))}
                              type="button"
                              title={tab}
                            >
                              <span className="editor-tab-label">{tabLabel}</span>
                              {!isImageTab && dirtyPathSet.has(tab) && (
                                <span className="editor-tab-dirty-dot" aria-hidden="true"></span>
                              )}
                            </button>
                            <button
                              className="editor-tab-close"
                              type="button"
                              aria-label={`关闭 ${tabLabel}`}
                              title={`关闭 ${tabLabel}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                closeEditorTab(tab, isImageTab);
                              }}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            </button>
                          </div>
                        );
                      })}
                      </div>
                      {activeFile?.path.endsWith(".tex") && (
                        <div className="editor-mode-switch">
                          <button
                            type="button"
                            className={`editor-mode-btn ${editorMode === "code" ? "is-active" : ""}`}
                            onClick={() => setEditorMode("code")}
                          >
                            Code
                          </button>
                          <button
                            type="button"
                            className={`editor-mode-btn ${editorMode === "visual" ? "is-active" : ""}`}
                            onClick={() => setEditorMode("visual")}
                          >
                            Visual
                          </button>
                        </div>
                      )}
                      <div className="editor-content">
                        {editorImagePath ? (
                          <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-app)" }}>
                            <div
                              style={{
                                padding: "6px 16px",
                                borderBottom: "1px solid var(--border-light)",
                                fontSize: "12px",
                                color: "var(--text-secondary)",
                                display: "flex",
                                justifyContent: "space-between",
                                background: "var(--bg-app)",
                              }}
                            >
                              <span>图片路径: {editorImagePath}</span>
                              <span>{editorImageAsset?.mimeType ?? "image"}</span>
                            </div>
                            <div
                              style={{
                                flex: 1,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                background: "var(--bg-secondary, #1e1e1e)",
                                overflow: "auto",
                                padding: 24,
                              }}
                            >
                              {editorImageUrl ? (
                                <img
                                  src={editorImageUrl}
                                  alt={editorImagePath.split("/").at(-1) ?? ""}
                                  style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 8 }}
                                />
                              ) : (
                                <div style={{ color: "var(--text-secondary)" }}>
                                  {editorImageAsset ? "图片资源不可用" : "正在加载图片…"}
                                </div>
                              )}
                            </div>
                          </div>
                        ) : activeFile ? (
                          editorMode === "visual" && activeFile.path.endsWith(".tex") ? (
                            <VisualEditor
                              content={activeFile.content}
                              onChange={handleEditorChange}
                              onSave={handleSaveCurrentFile}
                              onSwitchToCode={() => setEditorMode("code")}
                            />
                          ) : (
                            <EditorPane
                              file={activeFile}
                              isDirty={dirtyPathSet.has(activeFile.path)}
                              targetLine={editorJumpTarget?.path === activeFile.path ? editorJumpTarget.line : undefined}
                              targetNonce={editorJumpTarget?.path === activeFile.path ? editorJumpTarget.nonce : undefined}
                              onChange={handleEditorChange}
                              onCursorChange={handleEditorCursorChange}
                              onSave={handleEditorSave}
                              onRunAgent={handleEditorRunAgent}
                              onCompile={handleEditorCompile}
                              onForwardSync={handleEditorForwardSync}
                              yText={activeCollaborativeDoc.yText}
                              awareness={activeCollaborativeDoc.awareness}
                              collabStatus={currentCollabStatus}
                              comments={activeDocComments}
                              onAddComment={handleAddComment}
                            />
                          )
                        ) : !hasProject ? (
                          <WelcomeWorkspace
                            locale={locale}
                            embedded
                            recentWorkspaces={recentWorkspaces}
                            onOpenProject={() => void handleOpenExistingProject()}
                            onCreateProject={() => void handleCreateNewProject()}
                            onLinkCloudProject={handleLinkCloudProjectFromWelcome}
                            onOpenRecentWorkspace={(rootPath) => void activateWorkspace(rootPath)}
                          />
                        ) : (
                          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)" }}>
                            {loadingFilePath
                              ? "正在加载文件…"
                              : activeFileLoadError
                                ? `文件加载失败：${activeFileLoadError}`
                                : "选择一个文本文件开始编辑"}
                          </div>
                        )}
                      </div>
                    </div>

                    <div
                      className="workspace-main-resize-handle"
                      onMouseDown={handlePreviewResizeStart}
                      role="separator"
                      aria-label="调整编辑区和预览区宽度"
                    />

                    <div className="preview-area" style={{ flexBasis: `${previewPaneWidth}%`, width: `${previewPaneWidth}%` }}>
                      {previewState ? (
                        <PdfPane preview={previewState} />
                      ) : (
                        <div className="pdf-placeholder">暂无预览内容</div>
                      )}
                    </div>
                  </div>
                </div>

                <div
                  className={`terminal-panel-shell ${isTerminalVisible ? "is-visible" : ""}`}
                  style={{ height: isTerminalVisible ? terminalPanelHeight : 0 }}
                >
                  <div
                    className="terminal-panel-resize-handle"
                    onMouseDown={handleTerminalResizeStart}
                    role="separator"
                    aria-label="调整终端高度"
                  />
                  <TerminalPanel
                    workspaceRoot={snapshot.projectConfig.rootPath}
                    isVisible={isTerminalVisible}
                    height={terminalPanelHeight}
                    commandRequest={terminalCommandRequest}
                    onHide={() => setIsTerminalVisible(false)}
                  />
                </div>
              </>
            )}
          </div>
        </div>

      {loginModalOpen && (
        <CollabLoginModal
          currentSession={collabAuthSession}
          preserveUserId={collabLoginMode !== "bootstrap"}
          onSave={handleCollabLogin}
          onClose={() => {
            setCollabLoginMode("edit");
            setLoginModalOpen(false);
            setPendingCloudProjectReference(null);
          }}
        />
      )}

      {createEntryModal && (
        <CreateEntryModal
          kind={createEntryModal.kind}
          parentDir={createEntryModal.parentDir}
          onClose={() => setCreateEntryModal(null)}
          onSubmit={(name) => void handleCreateEntrySubmit(name)}
        />
      )}

      {shareLinkModalOpen && snapshot?.collab?.cloudProjectId && resolveCollabBaseUrls().httpBaseUrl && (
        <ShareLinkModal
          projectId={snapshot.collab.cloudProjectId}
          httpBaseUrl={resolveCollabBaseUrls().httpBaseUrl}
          onClose={() => setShareLinkModalOpen(false)}
          onCopy={handleCopyShareLink}
        />
      )}

      {collabProjectModal && (
        <CollabProjectModal
          mode={collabProjectModal.mode}
          defaultValue={collabProjectModal.defaultValue}
          busy={collabBusyAction === "create-project" || collabBusyAction === "link-project"}
          projects={availableCloudProjects}
          isLoadingProjects={isLoadingCloudProjects}
          onRefreshProjects={() => void refreshAvailableCloudProjects()}
          onSubmit={(value) => {
            if (collabProjectModal.mode === "create") {
              void handleSubmitCreateCloudProject(value);
              return;
            }
            if (hasProject) {
              void handleSubmitLinkCloudProject(value);
              return;
            }
            handlePrepareBootstrapCloudProject(value);
          }}
          onClose={() => {
            if (!collabBusyAction) {
              setCollabProjectModal(null);
            }
          }}
        />
      )}

      {releaseNotesModal && (
        <ReleaseNotesModal
          version={releaseNotesModal.version}
          body={releaseNotesModal.body}
          publishedAt={releaseNotesModal.publishedAt}
          htmlUrl={releaseNotesModal.htmlUrl}
          onClose={handleDismissReleaseNotes}
        />
      )}
    </div>
  );
}

export default App;
