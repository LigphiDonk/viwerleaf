import {
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { EditorPane } from "./components/EditorPane";
import { OutlineTree } from "./components/OutlineTree";
import { PdfPane, type PreviewPaneState } from "./components/PdfPane";
import { ProjectTree } from "./components/ProjectTree";
import { Sidebar } from "./components/Sidebar";
import { desktop } from "./lib/desktop";
import {
  buildProjectOutline,
  findActiveHeading,
  type OutlineHeading,
  type OutlineNode,
} from "./lib/outline";
import { closeTextTab, findFirstTextPath, getNodeByPath } from "./lib/workspace";
import type {
  AgentMessage,
  AgentProfileId,
  AssetResource,
  DrawerTab,
  FigureBriefDraft,
  GeneratedAsset,
  ProjectFile,
  ProjectNode,
  ProviderConfig,
  SkillManifest,
  TestResult,
  UsageRecord,
  WorkspacePaneMode,
  WorkspaceSnapshot,
} from "./types";

type PreviewSelection =
  | { kind: "compile" }
  | { kind: "asset"; path: string }
  | { kind: "unsupported"; path: string; title: string; description: string };

type EditorJumpTarget = { path: string; line: number; nonce: number };

function isTextNode(node: ProjectNode | null) {
  return Boolean(node?.kind !== "directory" && node?.isText);
}

function pickActiveTextPath(snapshot: WorkspaceSnapshot, requestedPath: string, previousPath: string) {
  const candidates = [requestedPath, previousPath, snapshot.activeFile, findFirstTextPath(snapshot.tree)];
  return candidates.find((path) => path && isTextNode(getNodeByPath(snapshot.tree, path))) ?? "";
}

function sanitizeOpenTabs(snapshot: WorkspaceSnapshot, openTabs: string[], activePath: string) {
  const nextTabs = Array.from(
    new Set(openTabs.filter((path) => isTextNode(getNodeByPath(snapshot.tree, path)))),
  );

  if (activePath && !nextTabs.includes(activePath)) {
    nextTabs.unshift(activePath);
  }

  return nextTabs;
}

function normalizeProjectPath(path: string) {
  return path.replaceAll("\\", "/");
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

function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [bootstrapError, setBootstrapError] = useState("");
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [openFiles, setOpenFiles] = useState<Record<string, ProjectFile>>({});
  const [dirtyPaths, setDirtyPaths] = useState<string[]>([]);
  const [assetCache, setAssetCache] = useState<Record<string, AssetResource>>({});
  const [activeFilePath, setActiveFilePath] = useState("");
  const [highlightedPage, setHighlightedPage] = useState(1);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("ai");
  const [workspacePaneMode, setWorkspacePaneMode] = useState<WorkspacePaneMode>("files");
  const [cursorLine, setCursorLine] = useState(1);
  const [selectedText, setSelectedText] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [usageRecords, setUsageRecords] = useState<UsageRecord[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<AgentProfileId>("outline");
  const [pendingPatch, setPendingPatch] = useState<{ filePath: string; content: string; summary: string } | null>(null);
  const [selectedBrief, setSelectedBrief] = useState<FigureBriefDraft | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<GeneratedAsset | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [loadingFilePath, setLoadingFilePath] = useState("");
  const [previewSelection, setPreviewSelection] = useState<PreviewSelection>({ kind: "compile" });
  const [outlineHeadings, setOutlineHeadings] = useState<OutlineHeading[]>([]);
  const [outlineTree, setOutlineTree] = useState<OutlineNode[]>([]);
  const [outlineWarnings, setOutlineWarnings] = useState<string[]>([]);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [editorJumpTarget, setEditorJumpTarget] = useState<EditorJumpTarget | null>(null);
  const draftContentRef = useRef<Record<string, string>>({});
  const pendingTextLoadsRef = useRef<Record<string, Promise<ProjectFile | null>>>({});

  const activeFile = (() => {
    if (!activeFilePath) {
      return null;
    }
    const file = openFiles[activeFilePath];
    if (!file) {
      return null;
    }
    const draftContent = draftContentRef.current[activeFilePath];
    if (draftContent === undefined || draftContent === file.content) {
      return file;
    }
    return { ...file, content: draftContent };
  })();

  const activeProfile = useMemo(
    () => snapshot?.profiles.find((profile) => profile.id === activeProfileId) ?? null,
    [activeProfileId, snapshot?.profiles],
  );

  const hasProject = Boolean(snapshot?.projectConfig.rootPath);
  const dirtyPathSet = useMemo(() => new Set(dirtyPaths), [dirtyPaths]);
  const focusedTreePath =
    previewSelection.kind === "compile" ? activeFilePath : previewSelection.path;
  const activeOutlineId = useMemo(
    () => findActiveHeading(outlineHeadings, activeFilePath, cursorLine)?.id,
    [activeFilePath, cursorLine, outlineHeadings],
  );
  const compilePreviewPath = useMemo(
    () => toProjectRelativePath(snapshot?.projectConfig.rootPath ?? "", snapshot?.compileResult.pdfPath),
    [snapshot?.compileResult.pdfPath, snapshot?.projectConfig.rootPath],
  );
  const compilePreviewUrl = useMemo(
    () => snapshot?.compileResult.pdfPath ? desktop.resolveResourceUrl(snapshot.compileResult.pdfPath) : "",
    [snapshot?.compileResult.pdfPath],
  );
  const compilePreviewAsset = compilePreviewPath ? assetCache[compilePreviewPath] : undefined;
  const activeFileSyncPath = activeFile?.path ?? "";
  const workspaceTargetDir = activeFilePath.includes("/")
    ? activeFilePath.slice(0, activeFilePath.lastIndexOf("/"))
    : "";

  const loadTextFile = useEffectEvent(async (path: string) => {
    if (!path) {
      return null;
    }

    const existing = openFiles[path];
    if (existing) {
      const draftContent = draftContentRef.current[path];
      return draftContent === undefined || draftContent === existing.content
        ? existing
        : { ...existing, content: draftContent };
    }

    const pending = pendingTextLoadsRef.current[path];
    if (pending) {
      return pending;
    }

    setLoadingFilePath(path);
    const request = (async () => {
      try {
        const file = await desktop.readFile(path);
        draftContentRef.current[path] = file.content;
        setOpenFiles((current) => ({ ...current, [path]: file }));
        return file;
      } finally {
        delete pendingTextLoadsRef.current[path];
        setLoadingFilePath((current) => (current === path ? "" : current));
      }
    })();

    pendingTextLoadsRef.current[path] = request;
    return request;
  });

  const loadAsset = useEffectEvent(async (path: string) => {
    if (!path || assetCache[path]) {
      return assetCache[path] ?? null;
    }

    try {
      const asset = await desktop.readAsset(path);
      setAssetCache((current) => ({ ...current, [path]: asset }));
      return asset;
    } catch (error) {
      console.warn("failed to load asset", path, error);
      return null;
    }
  });

  const applySnapshot = useEffectEvent((
    nextSnapshot: WorkspaceSnapshot,
    options?: {
      activeFilePath?: string;
      openTabs?: string[];
      previewSelection?: PreviewSelection;
      clearCaches?: boolean;
    },
  ) => {
    const rootChanged =
      options?.clearCaches ||
      nextSnapshot.projectConfig.rootPath !== (snapshot?.projectConfig.rootPath ?? "");
    const nextActivePath = pickActiveTextPath(
      nextSnapshot,
      options?.activeFilePath ?? "",
      activeFilePath,
    );
    const nextTabs = sanitizeOpenTabs(nextSnapshot, options?.openTabs ?? openTabs, nextActivePath);
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
    setOpenTabs(nextTabs);
    setActiveFilePath(nextActivePath);
    setPreviewSelection(nextPreview);
    if (rootChanged) {
      draftContentRef.current = {};
      pendingTextLoadsRef.current = {};
    } else {
      draftContentRef.current = Object.fromEntries(
        nextTabs
          .map((path) => [path, draftContentRef.current[path]] as const)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    }
    setDirtyPaths((current) =>
      rootChanged
        ? []
        : current.filter((path) => nextTabs.includes(path) && isTextNode(getNodeByPath(nextSnapshot.tree, path))),
    );
    setOpenFiles((current) =>
      rootChanged
        ? {}
        : Object.fromEntries(Object.entries(current).filter(([path]) => nextTabs.includes(path))),
    );
    setAssetCache((current) =>
      rootChanged
        ? {}
        : Object.fromEntries(
          Object.entries(current).filter(([path]) => getNodeByPath(nextSnapshot.tree, path)),
        ),
    );
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
    previewSelection?: PreviewSelection;
    clearCaches?: boolean;
  }) => {
    const nextSnapshot = await desktop.openProject();
    applySnapshot(nextSnapshot, options);
    return nextSnapshot;
  });

  useEffect(() => {
    void (async () => {
      try {
        await refreshWorkspace({ clearCaches: true });
        const nextMessages = await desktop.getAgentMessages();
        const nextUsage = await desktop.getUsageStats();
        setMessages(nextMessages);
        setUsageRecords(nextUsage);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setBootstrapError(message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- useEffectEvent refs must not be deps
  }, []);

  useEffect(() => {
    if (!snapshot || !activeFilePath || openFiles[activeFilePath]) {
      return;
    }
    const node = getNodeByPath(snapshot.tree, activeFilePath);
    if (node?.isText) {
      void loadTextFile(activeFilePath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadTextFile is useEffectEvent
  }, [activeFilePath, openFiles, snapshot]);

  useEffect(() => {
    if (previewSelection.kind !== "asset") {
      return;
    }
    if (!assetCache[previewSelection.path]) {
      void loadAsset(previewSelection.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadAsset is useEffectEvent
  }, [assetCache, previewSelection]);

  useEffect(() => {
    if (previewSelection.kind !== "compile" || !compilePreviewPath || assetCache[compilePreviewPath]) {
      return;
    }
    void loadAsset(compilePreviewPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadAsset is useEffectEvent
  }, [assetCache, compilePreviewPath, previewSelection.kind]);

  useEffect(() => {
    if (!snapshot?.projectConfig.rootPath) {
      setOutlineHeadings([]);
      setOutlineTree([]);
      setOutlineWarnings([]);
      setOutlineLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) {
        return;
      }

      setOutlineLoading(true);

      void (async () => {
        try {
          const result = await buildProjectOutline(snapshot.projectConfig.mainTex, async (path) => {
            const draftContent = draftContentRef.current[path];
            if (typeof draftContent === "string") {
              return draftContent;
            }
            const openFile = openFiles[path];
            if (openFile) {
              return openFile.content;
            }
            const file = await desktop.readFile(path);
            return file.content;
          });

          if (cancelled) {
            return;
          }

          if (result.warnings.length > 0) {
            console.warn("outline warnings", result.warnings);
          }
          setOutlineHeadings(result.headings);
          setOutlineTree(result.tree);
          setOutlineWarnings(result.warnings);
        } catch (error) {
          if (!cancelled) {
            console.warn("failed to build outline", error);
            setOutlineHeadings([]);
            setOutlineTree([]);
            setOutlineWarnings([
              error instanceof Error ? error.message : String(error),
            ]);
          }
        } finally {
          if (!cancelled) {
            setOutlineLoading(false);
          }
        }
      })();
    }, 280);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [openFiles, snapshot?.projectConfig.mainTex, snapshot?.projectConfig.rootPath]);

  const runForwardSync = useEffectEvent(async (filePath: string, line: number) => {
    if (!snapshot?.projectConfig.forwardSync || snapshot.compileResult.status !== "success") {
      return;
    }
    try {
      const location = await desktop.forwardSearch(filePath, line);
      setHighlightedPage(location.page);
    } catch (error) {
      console.warn("forward sync failed", error);
    }
  });

  useEffect(() => {
    if (!activeFileSyncPath) {
      return;
    }
    const timer = window.setTimeout(() => {
      void runForwardSync(activeFileSyncPath, cursorLine);
    }, 420);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runForwardSync is useEffectEvent
  }, [activeFileSyncPath, cursorLine, snapshot?.compileResult.status]);


  const runCompile = useEffectEvent(async (filePath: string) => {
    const previousCompilePath = toProjectRelativePath(
      snapshot?.projectConfig.rootPath ?? "",
      snapshot?.compileResult.pdfPath,
    );

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

    const compileResult = await desktop.compileProject(filePath);
    const nextCompilePath = toProjectRelativePath(snapshot?.projectConfig.rootPath ?? "", compileResult.pdfPath);

    if (previousCompilePath || nextCompilePath) {
      setAssetCache((current) => {
        const next = { ...current };
        if (previousCompilePath) {
          delete next[previousCompilePath];
        }
        if (nextCompilePath) {
          delete next[nextCompilePath];
        }
        return next;
      });
    }

    setSnapshot((current) =>
      current
        ? {
          ...current,
          compileResult,
        }
        : current,
    );
    return compileResult;
  });

  const saveOpenFiles = useEffectEvent(async (paths: string[]) => {
    const targets = Array.from(
      new Set(
        paths.filter((path) => {
          const file = openFiles[path];
          return Boolean(file && dirtyPathSet.has(path));
        }),
      ),
    );

    const savedContents: Array<{ path: string; content: string }> = [];

    for (const path of targets) {
      const file = openFiles[path];
      if (!file) {
        continue;
      }
      const content = draftContentRef.current[path] ?? file.content;
      await desktop.saveFile(path, content);
      savedContents.push({ path, content });
    }

    if (savedContents.length > 0) {
      setOpenFiles((current) => {
        let changed = false;
        const next = { ...current };
        for (const { path, content } of savedContents) {
          const file = next[path];
          if (!file || file.content === content) {
            continue;
          }
          next[path] = { ...file, content };
          changed = true;
        }
        return changed ? next : current;
      });
      setDirtyPaths((current) =>
        current.filter((path) => !savedContents.some((saved) => saved.path === path)),
      );
    }

    return savedContents.map((saved) => saved.path);
  });

  function replaceFileContent(filePath: string, content: string) {
    draftContentRef.current[filePath] = content;
    setOpenFiles((current) => {
      const file = current[filePath];
      if (!file) {
        return current;
      }
      return {
        ...current,
        [filePath]: {
          ...file,
          content,
        },
      };
    });
  }

  function handleFileChange(content: string) {
    if (!activeFile) {
      return;
    }
    draftContentRef.current[activeFile.path] = content;
    setDirtyPaths((current) =>
      current.includes(activeFile.path) ? current : [...current, activeFile.path],
    );
  }

  const handleEditorChange = useEffectEvent((content: string) => {
    handleFileChange(content);
  });

  const handleEditorCursorChange = useEffectEvent((line: number, selection: string) => {
    setCursorLine(line);
    setSelectedText(selection);
  });

  const handleSaveCurrentFile = useEffectEvent(async () => {
    if (!snapshot || !activeFile) {
      return;
    }

    if (snapshot.projectConfig.autoCompile) {
      await saveOpenFiles(dirtyPaths);
      await runCompile(activeFile.path);
      return;
    }

    await saveOpenFiles([activeFile.path]);
  });

  const handleManualCompile = useEffectEvent(async () => {
    if (!snapshot) {
      return;
    }

    await saveOpenFiles(dirtyPaths);
    setPreviewSelection({ kind: "compile" });
    await runCompile(activeFilePath || snapshot.projectConfig.mainTex);
  });

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "b") {
        return;
      }
      event.preventDefault();
      void handleManualCompile();
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleManualCompile is useEffectEvent
  }, []);

  const toggleAutoCompile = useEffectEvent(async () => {
    if (!snapshot) {
      return;
    }

    const projectConfig = await desktop.updateProjectConfig({
      ...snapshot.projectConfig,
      autoCompile: !snapshot.projectConfig.autoCompile,
    });

    setSnapshot((current) => (current ? { ...current, projectConfig } : current));
  });

  const handleEditorSave = useEffectEvent(() => {
    void handleSaveCurrentFile();
  });

  const handleEditorCompile = useEffectEvent(() => {
    void handleManualCompile();
  });

  const handleEditorRunAgent = useEffectEvent(() => {
    void handleRunAgent();
  });

  function openTextFile(path: string, line?: number) {
    startTransition(() => {
      setActiveFilePath(path);
      setOpenTabs((current) => (current.includes(path) ? current : [...current, path]));
      setPreviewSelection({ kind: "compile" });
    });
    if (line) {
      setCursorLine(line);
      setEditorJumpTarget((current) => ({
        path,
        line,
        nonce: (current?.nonce ?? 0) + 1,
      }));
    }
    void loadTextFile(path);
  }

  function handleOpenNode(node: ProjectNode) {
    if (node.kind === "directory") {
      return;
    }
    if (node.isText) {
      openTextFile(node.path);
      return;
    }
    if (node.isPreviewable) {
      setPreviewSelection({ kind: "asset", path: node.path });
      setHighlightedPage(1);
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

  async function handleRunAgent() {
    if (!activeFile || isStreaming) {
      return;
    }

    setDrawerTab("ai");
    setIsStreaming(true);
    setStreamText("");
    setPendingPatch(null);

    const unlisten = await desktop.onAgentStream((chunk) => {
      switch (chunk.type) {
        case "text_delta":
          setStreamText((current) => current + chunk.content);
          break;
        case "tool_call_start":
          setStreamText((current) => `${current}\n[Tool: ${chunk.toolId}]\n`);
          break;
        case "tool_call_result":
          setStreamText((current) => `${current}\n[Result: ${chunk.output.slice(0, 240)}]\n`);
          break;
        case "patch":
          setPendingPatch({
            filePath: chunk.filePath,
            content: chunk.newContent,
            summary: `Patch from agent for ${chunk.filePath}`,
          });
          break;
        case "error":
          setStreamText((current) => `${current}\n[Error: ${chunk.message}]\n`);
          setIsStreaming(false);
          break;
        case "done":
          setIsStreaming(false);
          break;
      }
    });

    try {
      const result = await desktop.runAgent(activeProfileId, activeFile.path, selectedText);
      const allMessages = await desktop.getAgentMessages();
      const nextUsage = await desktop.getUsageStats();
      const nextMessages =
        allMessages.length > 0 ? allMessages : await desktop.getAgentMessages(result.sessionId);
      setMessages(nextMessages);
      setUsageRecords(nextUsage);
      if (result.suggestedPatch) {
        setPendingPatch(result.suggestedPatch);
      }
      setStreamText("");
    } finally {
      unlisten();
      setIsStreaming(false);
    }
  }

  async function handleApplyPatch() {
    if (!pendingPatch) {
      return;
    }
    await desktop.applyAgentPatch(pendingPatch.filePath, pendingPatch.content);
    replaceFileContent(pendingPatch.filePath, pendingPatch.content);
    setDirtyPaths((current) => current.filter((path) => path !== pendingPatch.filePath));
    setPendingPatch(null);
  }

  async function handleCreateBrief() {
    if (!activeFile) {
      return;
    }
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
    setDrawerTab("figures");
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
    replaceFileContent(result.filePath, result.content);
    setDirtyPaths((current) => current.filter((path) => path !== result.filePath));
  }

  const handlePageJump = useEffectEvent(async (page: number) => {
    setHighlightedPage(page);
    if (previewSelection.kind !== "compile" || snapshot?.compileResult.status !== "success") {
      return;
    }
    try {
      const location = await desktop.reverseSearch(page);
      openTextFile(location.filePath, location.line);
    } catch (error) {
      console.warn("reverse sync failed", error);
    }
  });

  async function handleAddProvider(provider: ProviderConfig) {
    await desktop.addProvider(provider);
    const providers = await desktop.listProviders();
    setSnapshot((current) => (current ? { ...current, providers } : current));
  }

  async function handleDeleteProvider(providerId: string) {
    await desktop.deleteProvider(providerId);
    const providers = await desktop.listProviders();
    setSnapshot((current) => (current ? { ...current, providers } : current));
  }

  function handleTestProvider(providerId: string): Promise<TestResult> {
    return desktop.testProvider(providerId);
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

  async function handleCreateFile(parentDir: string, fileName: string) {
    const targetPath = parentDir ? `${parentDir}/${fileName}` : fileName;
    await desktop.createFile(targetPath, "");
    await refreshWorkspace({
      activeFilePath: targetPath,
      openTabs: [...openTabs, targetPath],
      previewSelection: { kind: "compile" },
    });
    void loadTextFile(targetPath);
  }

  async function handleCreateFolder(parentDir: string, folderName: string) {
    const targetPath = parentDir ? `${parentDir}/${folderName}` : folderName;
    await desktop.createFolder(targetPath);
    await refreshWorkspace({
      activeFilePath,
      openTabs,
      previewSelection,
    });
  }

  async function handleDeleteFile(path: string) {
    const removedTabs = openTabs.filter((tab) => isSamePathOrChild(tab, path));
    const closed = removedTabs.reduce(
      (current, tab) => closeTextTab(current.openTabs, current.activePath, tab),
      { openTabs, activePath: activeFilePath },
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

    await desktop.deleteFile(path);
    await refreshWorkspace({
      activeFilePath: closed.activePath,
      openTabs: closed.openTabs,
      previewSelection: nextPreview,
    });
  }

  async function handleRenameFile(oldPath: string, newPath: string) {
    const nextTabs = openTabs.map((tab) =>
      isSamePathOrChild(tab, oldPath) ? tab.replace(oldPath, newPath) : tab,
    );
    const nextActive = isSamePathOrChild(activeFilePath, oldPath)
      ? activeFilePath.replace(oldPath, newPath)
      : activeFilePath;
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

    await desktop.renameFile(oldPath, newPath);
    await refreshWorkspace({
      activeFilePath: nextActive,
      openTabs: nextTabs,
      previewSelection: nextPreview,
    });
  }

  async function handleQuickCreateFile() {
    const fileName = window.prompt("输入新文件名", "new-section.tex");
    if (!fileName?.trim()) {
      return;
    }
    await handleCreateFile(workspaceTargetDir, fileName.trim());
  }

  async function handleQuickCreateFolder() {
    const folderName = window.prompt("输入新文件夹名", "new-folder");
    if (!folderName?.trim()) {
      return;
    }
    await handleCreateFolder(workspaceTargetDir, folderName.trim());
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
    if (!selectedDir) {
      return;
    }
    draftContentRef.current = {};
    pendingTextLoadsRef.current = {};
    setOpenFiles({});
    setDirtyPaths([]);
    setAssetCache({});
    setEditorJumpTarget(null);
    const nextSnapshot = await desktop.switchProject(selectedDir);
    applySnapshot(nextSnapshot, { openTabs: [], clearCaches: true, previewSelection: { kind: "compile" } });
  }

  async function handleCreateNewProject() {
    const parentDir = await pickDirectory();
    if (!parentDir) {
      return;
    }
    const projectName = window.prompt("输入项目名称", "MyPaper");
    if (!projectName?.trim()) {
      return;
    }
    draftContentRef.current = {};
    pendingTextLoadsRef.current = {};
    setOpenFiles({});
    setDirtyPaths([]);
    setAssetCache({});
    setEditorJumpTarget(null);
    const nextSnapshot = await desktop.createProject(parentDir, projectName.trim());
    applySnapshot(nextSnapshot, { openTabs: [], clearCaches: true, previewSelection: { kind: "compile" } });
  }

  const previewState = useMemo<PreviewPaneState | null>(() => {
    if (!snapshot) {
      return null;
    }

    if (previewSelection.kind === "asset") {
      const node = getNodeByPath(snapshot.tree, previewSelection.path);
      const asset = assetCache[previewSelection.path];
      if (!node) {
        return {
          kind: "unsupported",
          title: previewSelection.path,
          description: "资源不存在。",
        };
      }
      if (!asset || (node.fileType === "pdf" ? !asset.data : !asset.resourceUrl)) {
        return {
          kind: "unsupported",
          title: node.name,
          description: "正在加载预览资源…",
        };
      }
      if (node.fileType === "pdf") {
        return {
          kind: "pdf",
          title: node.name,
          fileData: asset.data instanceof Uint8Array ? asset.data : undefined,
          fileUrl: asset.resourceUrl ?? desktop.resolveResourceUrl(asset.absolutePath),
          isLoading: false,
          highlightedPage,
          onPageJump: setHighlightedPage,
        };
      }
      if (node.fileType === "image") {
        return {
          kind: "image",
          title: node.name,
          fileUrl: asset.resourceUrl ?? "",
        };
      }
      return {
        kind: "unsupported",
        title: node.name,
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

      return {
        kind: "compile",
        compileResult: snapshot.compileResult,
        fileData: compilePreviewAsset?.data instanceof Uint8Array ? compilePreviewAsset.data : undefined,
        fileUrl: compilePreviewUrl || compilePreviewAsset?.resourceUrl,
        isLoading: Boolean(compilePreviewPath) && !compilePreviewAsset && !compilePreviewUrl,
        highlightedPage,
        onPageJump: handlePageJump,
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlePageJump is useEffectEvent
  }, [assetCache, compilePreviewAsset, compilePreviewPath, compilePreviewUrl, highlightedPage, previewSelection, snapshot]);

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

  if (bootstrapError) {
    return <div className="app-shell loading-shell">ViewerLeaf failed to start: {bootstrapError}</div>;
  }

  if (!snapshot) {
    return <div className="app-shell loading-shell">正在启动 ViewerLeaf…</div>;
  }

  return (
    <div className="app-shell fade-in">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand-title">ViewerLeaf 工作台</span>
          {hasProject && (
            <span className="topbar-metric" style={{ marginLeft: 12 }}>
              项目
              <strong>{snapshot.projectConfig.rootPath.split("/").at(-1) || "未命名"}</strong>
            </span>
          )}
        </div>
        <div className="topbar-center">
          <span className="topbar-metric">排版引擎 <strong>{snapshot.projectConfig.engine}</strong></span>
          <span className="topbar-metric">当前配置 <strong>{activeProfile?.label ?? "未选择"}</strong></span>
          <span className="topbar-metric">
            编译状态
            <strong>
              {snapshot.compileResult.status === "success"
                ? "成功"
                : snapshot.compileResult.status === "failed"
                  ? "失败"
                  : snapshot.compileResult.status === "running"
                    ? "正在编译"
                    : "空闲"}
            </strong>
          </span>
        </div>
        <div className="topbar-right">
          <button className="btn-secondary hover-spring" onClick={() => void handleOpenExistingProject()} type="button">
            打开项目
          </button>
          <button className="btn-secondary hover-spring" onClick={() => void handleCreateNewProject()} type="button">
            新建项目
          </button>
          {hasProject && (
            <>
              <label className="topbar-toggle">
                <input
                  type="checkbox"
                  checked={snapshot.projectConfig.autoCompile}
                  onChange={() => void toggleAutoCompile()}
                />
                <span>自动编译（保存时）</span>
              </label>
              <span className="topbar-metric">诊断结果 <strong>{snapshot.compileResult.diagnostics.length} 项</strong></span>
              <button
                className="btn-secondary hover-spring"
                onClick={() => void handleManualCompile()}
                type="button"
                disabled={snapshot.compileResult.status === "running"}
              >
                {snapshot.compileResult.status === "running" ? "编译中..." : "编译"}
              </button>
              <button className="btn-primary hover-spring" onClick={handleRunAgent} type="button" disabled={isStreaming}>
                {isStreaming ? "执行中..." : `执行 ${activeProfile?.label ?? "当前配置"}`}
              </button>
            </>
          )}
        </div>
      </header>

      {!hasProject && (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 40,
            background:
              "radial-gradient(circle at top left, rgba(184, 164, 125, 0.18), transparent 35%), linear-gradient(180deg, var(--bg-app), var(--bg-sidebar))",
          }}
        >
          <div
            style={{
              width: "min(720px, 100%)",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-light)",
              borderRadius: 24,
              boxShadow: "var(--shadow-lg)",
              padding: 36,
            }}
          >
            <div style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 12 }}>Workspace</div>
            <h1 style={{ margin: "0 0 12px 0", fontSize: 34, color: "var(--text-primary)" }}>打开已有项目，或创建新的论文工程</h1>
            <p style={{ margin: "0 0 24px 0", color: "var(--text-secondary)", lineHeight: 1.6 }}>
              现在不会再强制进入示例项目。先选择你的 LaTeX 工程目录，或者新建一个 ViewerLeaf 项目，再开始编辑、编译和调用 Agent。
            </p>
            <div style={{ display: "flex", gap: 12 }}>
              <button className="btn-primary hover-spring" type="button" onClick={() => void handleOpenExistingProject()}>
                打开已有项目
              </button>
              <button className="btn-secondary hover-spring" type="button" onClick={() => void handleCreateNewProject()}>
                创建项目
              </button>
            </div>
          </div>
        </div>
      )}

      {hasProject && (
        <div className="workspace-container">
          <div className="activity-bar">
            <button
              className={`activity-icon hover-spring ${drawerTab === "ai" ? "is-active" : ""}`}
              onClick={() => setDrawerTab("ai")}
              title="AI 智能体助手"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>
            </button>
            <button
              className={`activity-icon hover-spring ${drawerTab === "figures" ? "is-active" : ""}`}
              onClick={() => setDrawerTab("figures")}
              title="图表工作区 (Figures)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
            </button>
            <button
              className={`activity-icon hover-spring ${drawerTab === "skills" ? "is-active" : ""}`}
              onClick={() => setDrawerTab("skills")}
              title="应用与技能 (App Store)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
            </button>
            <button
              className={`activity-icon hover-spring ${drawerTab === "providers" ? "is-active" : ""}`}
              onClick={() => setDrawerTab("providers")}
              title="API 配置区 (Providers)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            </button>
            <button
              className={`activity-icon hover-spring ${drawerTab === "usage" ? "is-active" : ""}`}
              onClick={() => setDrawerTab("usage")}
              title="模型用量 (Usage)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"></path><path d="M7 14l4-4 3 3 5-7"></path></svg>
            </button>

            <div style={{ flex: 1 }}></div>

            <button
              className={`activity-icon hover-spring ${drawerTab === "logs" ? "is-active" : ""}`}
              onClick={() => setDrawerTab("logs")}
              title="编译日志"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
              {snapshot.compileResult.diagnostics.length > 0 && <span style={{ position: "absolute", top: 2, right: 2, width: 8, height: 8, borderRadius: "50%", background: "var(--danger)" }}></span>}
            </button>
          </div>

          <Sidebar
            tab={drawerTab}
            messages={messages}
            profiles={snapshot.profiles}
            activeProfileId={activeProfileId}
            onSelectProfile={(profileId: string) => setActiveProfileId(profileId as AgentProfileId)}
            onRunAgent={handleRunAgent}
            pendingPatchSummary={pendingPatch?.summary}
            onApplyPatch={handleApplyPatch}
            compileLog={snapshot.compileResult.logOutput}
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
            skills={snapshot.skills}
            usageRecords={usageRecords}
            onAddProvider={handleAddProvider}
            onDeleteProvider={handleDeleteProvider}
            onTestProvider={handleTestProvider}
            onToggleSkill={handleToggleSkill}
            streamText={streamText}
            isStreaming={isStreaming}
          />

          <div className="workspace-main">
            <div className="workspace-left-pane">
              <div className="workspace-pane-header">
                <div>
                  <div className="workspace-pane-title">Project</div>
                  <div className="workspace-pane-subtitle">
                    {snapshot.projectConfig.rootPath.split("/").at(-1) || "未命名项目"}
                  </div>
                </div>
                <div className="workspace-pane-actions">
                  <button className="icon-btn" title="新建文件" type="button" onClick={() => void handleQuickCreateFile()}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>
                  </button>
                  <button className="icon-btn" title="新建文件夹" type="button" onClick={() => void handleQuickCreateFolder()}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h5l2 2h11v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path><path d="M12 12v6"></path><path d="M9 15h6"></path></svg>
                  </button>
                </div>
              </div>
              <div className="workspace-pane-segmented">
                <button
                  type="button"
                  className={`sidebar-segment ${workspacePaneMode === "files" ? "is-active" : ""}`}
                  onClick={() => setWorkspacePaneMode("files")}
                >
                  Files
                </button>
                <button
                  type="button"
                  className={`sidebar-segment ${workspacePaneMode === "outline" ? "is-active" : ""}`}
                  onClick={() => setWorkspacePaneMode("outline")}
                >
                  Outline
                </button>
              </div>
              <div className="workspace-pane-body">
                {workspacePaneMode === "files" ? (
                  <ProjectTree
                    nodes={snapshot.tree}
                    activeFile={focusedTreePath}
                    dirtyPaths={dirtyPathSet}
                    onOpenNode={handleOpenNode}
                    onCreateFile={handleCreateFile}
                    onCreateFolder={handleCreateFolder}
                    onDeleteFile={handleDeleteFile}
                    onRenameFile={handleRenameFile}
                  />
                ) : (
                  outlineNode
                )}
              </div>
            </div>

            <div className="editor-area">
              <div className="editor-tabs">
                {openTabs.map((tab) => (
                  <button
                    key={tab}
                    className={`editor-tab ${tab === activeFilePath ? "is-active" : ""}`}
                    onClick={() => openTextFile(tab)}
                    type="button"
                  >
                    <span style={{ marginRight: 8, display: "inline-flex", alignItems: "center", gap: 6 }}>
                      {tab.split("/").at(-1)}
                      {dirtyPathSet.has(tab) && <span className="editor-tab-dirty-dot" aria-hidden="true"></span>}
                    </span>
                    <span
                      className="icon-btn"
                      style={{ width: 16, height: 16 }}
                      onClick={(event) => {
                        event.stopPropagation();
                        const closed = closeTextTab(openTabs, activeFilePath, tab);
                        setOpenTabs(closed.openTabs);
                        setActiveFilePath(closed.activePath);
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                    </span>
                  </button>
                ))}
              </div>
              <div className="editor-content">
                {activeFile ? (
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
                  />
                ) : (
                  <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)" }}>
                    {loadingFilePath ? "正在加载文件…" : "选择一个文本文件开始编辑"}
                  </div>
                )}
              </div>
            </div>

            <div className="preview-area">
              {previewState ? (
                <PdfPane preview={previewState} />
              ) : (
                <div className="pdf-placeholder">暂无预览内容</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
