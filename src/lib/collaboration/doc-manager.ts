import { Awareness } from "y-protocols/awareness.js";
import * as Y from "yjs";

import type { FileAdapter } from "../adapters";
import type { CloudBlobSummary, CloudDocumentSummary, CollabFileSyncState, CollabMember, WorkspaceSnapshot } from "../../types";
import {
  ensureCloudDocument,
  fetchDocumentSnapshot,
  listCloudDocuments,
  uploadDocumentSnapshot,
} from "./cloud-api";
import { buildCollabWebSocketUrl } from "./auth";
import { ViewerLeafProvider } from "./yjs-provider";

const LOCAL_PERSISTENCE_ORIGIN = Symbol("viewerleaf-collab-persist");
const REMOTE_SYNC_ORIGIN = Symbol("viewerleaf-collab-remote-sync");
const LOCAL_MIRROR_FLUSH_MS = 1000;
const LOCAL_STATE_FLUSH_MS = 600;

function collectTextPaths(nodes: WorkspaceSnapshot["tree"]) {
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

function toBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function persistencePath(projectId: string, docPath: string) {
  const safe = encodeURIComponent(docPath);
  return `.viewerleaf/collab/${projectId}/${safe}.json`;
}

function pendingSyncManifestPath(projectId: string) {
  return `.viewerleaf/collab/${projectId}/pending-sync.json`;
}

function syncedVersionManifestPath(projectId: string) {
  return `.viewerleaf/collab/${projectId}/synced-versions.json`;
}

function blobVersionManifestPath(projectId: string) {
  return `.viewerleaf/collab/${projectId}/blob-versions.json`;
}

async function ensureCollabPersistenceDirectories(fileAdapter: FileAdapter, projectId: string) {
  const folders = [
    ".viewerleaf",
    ".viewerleaf/collab",
    `.viewerleaf/collab/${projectId}`,
  ];
  for (const folder of folders) {
    try {
      await fileAdapter.createFolder(folder);
    } catch {
      // Folder may already exist. Persist writes should still proceed.
    }
  }
}

export async function seedCollabSyncBaseline(
  fileAdapter: FileAdapter,
  projectId: string,
  documents: CloudDocumentSummary[],
  options?: {
    additionalSyncedPaths?: Iterable<string>;
  },
) {
  await ensureCollabPersistenceDirectories(fileAdapter, projectId);
  const versionEntries = new Map<string, number>(
    documents
      .filter((document) => document.kind === "text" || document.kind === "tex" || document.kind === "bib")
      .map((document) => [document.path, document.latestVersion] as const),
  );
  for (const path of options?.additionalSyncedPaths ?? []) {
    const normalizedPath = path.trim();
    if (!normalizedPath || versionEntries.has(normalizedPath)) {
      continue;
    }
    versionEntries.set(normalizedPath, 0);
  }
  const versions = Object.fromEntries(
    Array.from(versionEntries.entries()).sort(([left], [right]) => left.localeCompare(right)),
  );
  await Promise.all([
    fileAdapter.saveFile(
      pendingSyncManifestPath(projectId),
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        paths: [],
      }),
    ),
    fileAdapter.saveFile(
      syncedVersionManifestPath(projectId),
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        versions,
      }),
    ),
  ]);
}

function isEmptyDocSnapshot(update: Uint8Array | null | undefined) {
  return Boolean(update && update.length === 2 && update[0] === 0 && update[1] === 0);
}

export interface BlobSyncBaseline {
  versions: Map<string, number>;
  hashes: Map<string, string>;
}

export async function readBlobSyncBaseline(
  fileAdapter: FileAdapter,
  projectId: string,
): Promise<BlobSyncBaseline> {
  try {
    const file = await fileAdapter.readFile(blobVersionManifestPath(projectId));
    const parsed = JSON.parse(file.content) as {
      versions?: Record<string, unknown>;
      hashes?: Record<string, unknown>;
    };
    const versions = new Map(
      Object.entries(parsed.versions ?? {})
        .filter(([, v]) => typeof v === "number")
        .map(([k, v]) => [k.replaceAll("\\", "/"), v]) as [string, number][],
    );
    const hashes = new Map(
      Object.entries(parsed.hashes ?? {})
        .filter(([, v]) => typeof v === "string")
        .map(([k, v]) => [k.replaceAll("\\", "/"), v]) as [string, string][],
    );
    return { versions, hashes };
  } catch {
    return { versions: new Map(), hashes: new Map() };
  }
}

export async function writeBlobSyncBaseline(
  fileAdapter: FileAdapter,
  projectId: string,
  baseline: BlobSyncBaseline,
): Promise<void> {
  const sortedVersions = Object.fromEntries(
    Array.from(baseline.versions.entries()).sort(([a], [b]) => a.localeCompare(b)),
  );
  const sortedHashes = Object.fromEntries(
    Array.from(baseline.hashes.entries()).sort(([a], [b]) => a.localeCompare(b)),
  );
  await fileAdapter.saveFile(
    blobVersionManifestPath(projectId),
    JSON.stringify({ updatedAt: new Date().toISOString(), versions: sortedVersions, hashes: sortedHashes }),
  );
}

export async function seedBlobBaseline(
  fileAdapter: FileAdapter,
  projectId: string,
  blobs: CloudBlobSummary[],
): Promise<void> {
  const baseline: BlobSyncBaseline = {
    versions: new Map(blobs.map((b) => [b.path, b.latestVersion])),
    hashes: new Map(),
  };
  await writeBlobSyncBaseline(fileAdapter, projectId, baseline);
}

export interface ManagedCollabDocHandle {
  path: string;
  yDoc: Y.Doc;
  yText: Y.Text;
  awareness: Awareness;
  provider: ViewerLeafProvider | null;
  connected: boolean;
  synced: boolean;
  connectionError: string;
  members: CollabMember[];
  flushLocalMirror(): Promise<void>;
  destroy(): void;
  subscribe(listener: () => void): () => void;
}

export interface CollabManagerEvent {
  kind: "content" | "connection" | "presence";
  path: string;
  source?: "local" | "remote";
}

export interface CollabWorkspaceSyncSummary {
  byPath: Record<string, CollabFileSyncState>;
  pendingPushCount: number;
  pendingPullCount: number;
  conflictCount: number;
}

interface ManagedDocInternal extends ManagedCollabDocHandle {
  mirrorFlushTimer: number | null;
  stateFlushTimer: number | null;
  subscribers: Set<() => void>;
}

interface CollabDocManagerOptions {
  enabled: boolean;
  projectId: string | null;
  authToken: string;
  user: { userId: string; name: string; color: string };
  fileAdapter: FileAdapter;
  realtimeSyncEnabled?: boolean;
  debugLog?: (message: string, details?: unknown) => void;
}

export class CollabDocManager {
  private readonly options: CollabDocManagerOptions;
  private readonly docs = new Map<string, ManagedDocInternal>();
  private readonly openingDocs = new Map<string, Promise<ManagedDocInternal | null>>();
  private readonly listeners = new Set<(event: CollabManagerEvent) => void>();
  private pendingSyncPaths: Set<string> | null = null;
  private pendingSyncPathsPromise: Promise<Set<string>> | null = null;
  private syncedVersions: Map<string, number> | null = null;
  private syncedVersionsPromise: Promise<Map<string, number>> | null = null;
  private remoteDocumentsByPath: Map<string, CloudDocumentSummary> | null = null;

  constructor(options: CollabDocManagerOptions) {
    this.options = options;
  }

  private get realtimeSyncEnabled() {
    return this.options.realtimeSyncEnabled ?? true;
  }

  async syncProject(snapshot: WorkspaceSnapshot | null) {
    const nextPaths =
      snapshot && this.options.enabled && this.options.projectId
        ? new Set(collectTextPaths(snapshot.tree))
        : new Set<string>();

    for (const path of Array.from(this.docs.keys())) {
      if (!nextPaths.has(path)) {
        this.closeDoc(path);
      }
    }

    await this.prunePendingSyncPaths(nextPaths);
    await this.pruneSyncedVersions(nextPaths);
  }

  async openDoc(path: string) {
    const existing = this.docs.get(path);
    if (existing) {
      this.options.debugLog?.("[collab.doc] reusing existing collaborative doc", {
        projectId: this.options.projectId,
        path,
      });
      return existing;
    }

    const pending = this.openingDocs.get(path);
    if (pending) {
      this.options.debugLog?.("[collab.doc] awaiting pending collaborative doc open", {
        projectId: this.options.projectId,
        path,
      });
      return pending;
    }

    const task = this.openDocInternal(path);
    this.openingDocs.set(path, task);
    try {
      return await task;
    } finally {
      if (this.openingDocs.get(path) === task) {
        this.openingDocs.delete(path);
      }
    }
  }

  private async openDocInternal(path: string) {
    const existing = this.docs.get(path);
    if (existing) {
      return existing;
    }

    if (!this.options.enabled || !this.options.projectId) {
      this.options.debugLog?.("[collab.doc] openDoc skipped because collaboration is disabled", {
        projectId: this.options.projectId,
        path,
      });
      return null;
    }

    this.options.debugLog?.("[collab.doc] opening collaborative doc", {
      projectId: this.options.projectId,
      path,
    });

    const yDoc = new Y.Doc();
    const yText = yDoc.getText("content");
    const awareness = new Awareness(yDoc);
    let shouldUploadLocalSeed = false;
    const pendingSyncPaths = await this.getPendingSyncPaths();
    const hasPendingUpload = pendingSyncPaths.has(path);

    const persistedUpdate = await this.readPersistedState(path);
    let loadedFromRemote = false;
    if (persistedUpdate?.length) {
      this.options.debugLog?.("[collab.doc] loaded persisted local state", {
        projectId: this.options.projectId,
        path,
        bytes: persistedUpdate.byteLength,
      });
      Y.applyUpdate(yDoc, persistedUpdate, LOCAL_PERSISTENCE_ORIGIN);
    } else {
      const remoteSnapshot = await this.fetchRemoteSnapshot(path);
      if (remoteSnapshot?.length && !isEmptyDocSnapshot(remoteSnapshot)) {
        loadedFromRemote = true;
        this.options.debugLog?.("[collab.doc] loaded remote snapshot", {
          projectId: this.options.projectId,
          path,
          bytes: remoteSnapshot.byteLength,
        });
        Y.applyUpdate(yDoc, remoteSnapshot, LOCAL_PERSISTENCE_ORIGIN);
      } else {
        this.options.debugLog?.("[collab.doc] remote snapshot empty, seeding from local file", {
          projectId: this.options.projectId,
          path,
        });
        try {
          const localFile = await this.options.fileAdapter.readFile(path);
          if (localFile.content) {
            yDoc.transact(() => {
              yText.insert(0, localFile.content);
            }, LOCAL_PERSISTENCE_ORIGIN);
            shouldUploadLocalSeed = true;
          }
        } catch (error) {
          console.warn("failed to seed collaborative doc from local content", path, error);
        }
      }
    }

    const provider = this.realtimeSyncEnabled
      ? new ViewerLeafProvider(
        buildCollabWebSocketUrl(this.options.projectId, path, this.options.authToken),
        yDoc,
        awareness,
        this.options.authToken,
        this.options.user,
        path,
        this.options.debugLog,
      )
      : null;

    const managed: ManagedDocInternal = {
      path,
      yDoc,
      yText,
      awareness,
      provider,
      connected: false,
      synced: loadedFromRemote && !hasPendingUpload,
      connectionError: "",
      members: [],
      mirrorFlushTimer: null,
      stateFlushTimer: null,
      subscribers: new Set(),
      flushLocalMirror: async () => {
        await this.options.fileAdapter.saveFile(path, yText.toString());
      },
      destroy: () => {
        if (managed.mirrorFlushTimer !== null) {
          window.clearTimeout(managed.mirrorFlushTimer);
        }
        if (managed.stateFlushTimer !== null) {
          window.clearTimeout(managed.stateFlushTimer);
        }
        provider?.destroy();
        yDoc.destroy();
      },
      subscribe: (listener: () => void) => {
        managed.subscribers.add(listener);
        return () => {
          managed.subscribers.delete(listener);
        };
      },
    };

    const notify = (kind: CollabManagerEvent["kind"], source?: CollabManagerEvent["source"]) => {
      const states = Array.from(awareness.getStates().entries());
      managed.members = states
        .filter(([clientId, state]) => clientId !== awareness.clientID && state?.user)
        .map(([clientId, state]) => ({
          clientId,
          userId: state.user.userId || String(clientId),
          name: state.user.name || "Anonymous",
          color: state.user.color || "#7a8cff",
          openFile: state.user.openFile,
        }));
      for (const listener of managed.subscribers) {
        listener();
      }
      for (const listener of this.listeners) {
        listener({ kind, path, source });
      }
    };

    provider?.on("sync", () => {
      if (shouldUploadLocalSeed) {
        provider?.sendDocumentUpdate(Y.encodeStateAsUpdate(yDoc));
        shouldUploadLocalSeed = false;
      }
      managed.synced = true;
      managed.connectionError = "";
      notify("connection");
    });
    provider?.on("reconnecting", (attempt, delay) => {
      this.options.debugLog?.("[collab.ws] reconnect event emitted", {
        path,
        attempt,
        delayMs: delay,
      });
    });
    provider?.on("status", (connected) => {
      managed.connected = connected;
      if (!connected) {
        managed.synced = false;
      }
      notify("connection");
    });
    provider?.on("connection-error", (error) => {
      managed.connectionError = error.message;
      managed.synced = false;
      notify("connection");
    });

    awareness.on("change", () => {
      notify("presence");
    });

    yDoc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL_PERSISTENCE_ORIGIN) {
        return;
      }

      const source: CollabManagerEvent["source"] =
        origin === REMOTE_SYNC_ORIGIN || origin === provider ? "remote" : "local";
      if (source === "local") {
        managed.synced = false;
        void this.setPathPendingSync(path, true).catch((error) => {
          console.warn("failed to mark collaborative doc as pending sync", path, error);
        });
      }

      if (managed.mirrorFlushTimer !== null) {
        window.clearTimeout(managed.mirrorFlushTimer);
      }
      managed.mirrorFlushTimer = window.setTimeout(() => {
        managed.mirrorFlushTimer = null;
        void managed.flushLocalMirror().catch((error) => {
          console.warn("failed to flush collaborative mirror", path, error);
        });
      }, LOCAL_MIRROR_FLUSH_MS);

      if (managed.stateFlushTimer !== null) {
        window.clearTimeout(managed.stateFlushTimer);
      }
      managed.stateFlushTimer = window.setTimeout(() => {
        managed.stateFlushTimer = null;
        void this.persistState(path, yDoc).catch((error) => {
          console.warn("failed to persist collaborative state", path, error);
        });
      }, LOCAL_STATE_FLUSH_MS);

      notify("content", source);
    });

    this.docs.set(path, managed);
    if (this.realtimeSyncEnabled) {
      this.options.debugLog?.("[collab.doc] connecting provider", {
        projectId: this.options.projectId,
        path,
      });
      provider?.connect();
    } else {
      this.options.debugLog?.("[collab.doc] realtime provider disabled; manual sync mode active", {
        projectId: this.options.projectId,
        path,
      });
    }
    notify("connection");
    return managed;
  }

  closeDoc(path: string) {
    const doc = this.docs.get(path);
    if (!doc) {
      return;
    }
    doc.destroy();
    this.docs.delete(path);
    for (const listener of this.listeners) {
      listener({ kind: "connection", path });
    }
  }

  getDoc(path: string) {
    return this.docs.get(path) ?? null;
  }

  getAllConnectedPaths() {
    return Array.from(this.docs.keys());
  }

  subscribe(listener: (event: CollabManagerEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async flushAll() {
    await Promise.all(
      Array.from(this.docs.values()).map(async (doc) => {
        await doc.flushLocalMirror();
        await this.persistState(doc.path, doc.yDoc);
      }),
    );
  }

  async hasPendingSyncPaths() {
    const pendingPaths = await this.getPendingSyncPaths();
    return pendingPaths.size > 0;
  }

  async getWorkspaceSyncSummary(
    snapshot: WorkspaceSnapshot | null,
    options?: { refreshRemote?: boolean },
  ): Promise<CollabWorkspaceSyncSummary> {
    if (!snapshot || !this.options.enabled || !this.options.projectId) {
      return {
        byPath: {},
        pendingPushCount: 0,
        pendingPullCount: 0,
        conflictCount: 0,
      };
    }

    const remoteDocuments = options?.refreshRemote
      ? await this.refreshRemoteDocuments()
      : await this.getRemoteDocumentsByPath();
    return this.buildWorkspaceSyncSummary(snapshot, remoteDocuments);
  }

  async refreshRemoteDocuments() {
    this.remoteDocumentsByPath = await this.fetchRemoteDocumentsByPath();
    return this.remoteDocumentsByPath;
  }

  async markAllTextFilesPending(snapshot: WorkspaceSnapshot | null) {
    if (!snapshot || !this.options.enabled || !this.options.projectId) {
      return;
    }

    const pendingPaths = await this.getPendingSyncPaths();
    let changed = false;
    for (const path of collectTextPaths(snapshot.tree)) {
      if (!pendingPaths.has(path)) {
        pendingPaths.add(path);
        changed = true;
      }
    }
    if (changed) {
      await this.persistPendingSyncPaths(pendingPaths);
    }
  }

  async syncWorkspaceNow(snapshot: WorkspaceSnapshot | null) {
    return this.runWorkspaceSync(snapshot, "push");
  }

  async pullWorkspace(snapshot: WorkspaceSnapshot | null) {
    return this.runWorkspaceSync(snapshot, "pull");
  }

  destroy() {
    for (const path of Array.from(this.docs.keys())) {
      this.closeDoc(path);
    }
  }

  private async fetchRemoteSnapshot(path: string) {
    if (!this.options.projectId) {
      return null;
    }

    try {
      this.options.debugLog?.("[collab.doc] ensuring remote document", {
        projectId: this.options.projectId,
        path,
      });
      await ensureCloudDocument(this.options.authToken, this.options.projectId, path);
      this.options.debugLog?.("[collab.doc] fetching remote snapshot", {
        projectId: this.options.projectId,
        path,
      });
      return await fetchDocumentSnapshot(this.options.authToken, this.options.projectId, path);
    } catch (error) {
      console.warn("failed to fetch remote snapshot", path, error);
      this.options.debugLog?.("[collab.doc] failed to fetch remote snapshot", {
        projectId: this.options.projectId,
        path,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async runWorkspaceSync(snapshot: WorkspaceSnapshot | null, mode: "push" | "pull") {
    if (!snapshot || !this.options.enabled || !this.options.projectId) {
      return { syncedCount: 0 };
    }

    const remoteDocuments = await this.refreshRemoteDocuments();
    const summary = await this.buildWorkspaceSyncSummary(snapshot, remoteDocuments);
    const textPaths =
      mode === "push"
        ? Object.entries(summary.byPath)
          .filter(([, state]) => state === "pending-push")
          .map(([path]) => path)
        : Object.entries(summary.byPath)
          .filter(([, state]) => state === "pending-pull")
          .map(([path]) => path);
    const existingPaths = new Set(this.docs.keys());
    let syncedCount = 0;

    try {
      for (const path of textPaths) {
        const doc = await this.openDoc(path);
        if (!doc) {
          continue;
        }

        if (mode === "push") {
          const latestVersion = await this.pushDocSnapshot(path, doc);
          await this.setSyncedVersion(path, latestVersion);
          await this.setPathPendingSync(path, false);
          this.upsertRemoteDocumentVersion(path, latestVersion);
          doc.synced = true;
          doc.connectionError = "";
          await doc.flushLocalMirror();
          await this.persistState(path, doc.yDoc);
          for (const listener of doc.subscribers) {
            listener();
          }
          for (const listener of this.listeners) {
            listener({ kind: "connection", path });
          }
        }
        if (mode === "pull") {
          const remoteDoc = remoteDocuments.get(path);
          await this.pullDocSnapshot(path, doc, { remoteVersion: remoteDoc?.latestVersion ?? 0 });
        }
        syncedCount += 1;
      }
    } finally {
      for (const path of Array.from(this.docs.keys())) {
        if (!existingPaths.has(path)) {
          this.closeDoc(path);
        }
      }
    }

    return { syncedCount };
  }

  private async readPersistedState(path: string) {
    if (!this.options.projectId) {
      return null;
    }

    try {
      const file = await this.options.fileAdapter.readFile(persistencePath(this.options.projectId, path));
      const parsed = JSON.parse(file.content) as { updateBase64?: string };
      return parsed.updateBase64 ? fromBase64(parsed.updateBase64) : null;
    } catch {
      return null;
    }
  }

  private async persistState(path: string, yDoc: Y.Doc) {
    if (!this.options.projectId) {
      return;
    }

    await this.ensurePersistenceDirectories();
    const payload = JSON.stringify({
      updatedAt: new Date().toISOString(),
      updateBase64: toBase64(Y.encodeStateAsUpdate(yDoc)),
    });
    await this.options.fileAdapter.saveFile(persistencePath(this.options.projectId, path), payload);
  }

  private async pushDocSnapshot(path: string, doc: ManagedDocInternal) {
    if (!this.options.projectId) {
      return 0;
    }

    const update = Y.encodeStateAsUpdate(doc.yDoc);
    this.options.debugLog?.("[collab.doc] uploading manual snapshot", {
      projectId: this.options.projectId,
      path,
      bytes: update.byteLength,
    });
    await ensureCloudDocument(this.options.authToken, this.options.projectId, path);
    return uploadDocumentSnapshot(this.options.authToken, this.options.projectId, path, update);
  }

  private async pullDocSnapshot(path: string, doc: ManagedDocInternal, options?: { remoteVersion?: number }) {
    const remoteSnapshot = await this.fetchRemoteSnapshot(path);
    if (!remoteSnapshot?.length || isEmptyDocSnapshot(remoteSnapshot)) {
      doc.synced = !(await this.isPathPendingSync(path));
      doc.connectionError = "";
      if (typeof options?.remoteVersion === "number") {
        await this.setSyncedVersion(path, options.remoteVersion);
      }
      for (const listener of doc.subscribers) {
        listener();
      }
      return;
    }

    Y.applyUpdate(doc.yDoc, remoteSnapshot, REMOTE_SYNC_ORIGIN);
    doc.synced = !(await this.isPathPendingSync(path));
    doc.connectionError = "";
    if (typeof options?.remoteVersion === "number") {
      await this.setSyncedVersion(path, options.remoteVersion);
    }
    await doc.flushLocalMirror();
    await this.persistState(path, doc.yDoc);
    for (const listener of doc.subscribers) {
      listener();
    }
    for (const listener of this.listeners) {
      listener({ kind: "connection", path });
    }
  }

  private async ensurePersistenceDirectories() {
    if (!this.options.projectId) {
      return;
    }
    await ensureCollabPersistenceDirectories(this.options.fileAdapter, this.options.projectId);
  }

  private async buildWorkspaceSyncSummary(
    snapshot: WorkspaceSnapshot,
    remoteDocuments: Map<string, CloudDocumentSummary>,
  ) {
    const localTextPaths = new Set(collectTextPaths(snapshot.tree));
    const pendingSyncPaths = await this.getPendingSyncPaths();
    const syncedVersions = await this.getSyncedVersions();
    const allPaths = new Set<string>([
      ...localTextPaths,
      ...remoteDocuments.keys(),
    ]);

    const byPath: Record<string, CollabFileSyncState> = {};
    let pendingPushCount = 0;
    let pendingPullCount = 0;
    let conflictCount = 0;

    for (const path of Array.from(allPaths).sort()) {
      const remoteVersion = remoteDocuments.get(path)?.latestVersion ?? 0;
      const syncedVersion = syncedVersions.get(path) ?? 0;
      const hasSyncedBaseline = syncedVersions.has(path);
      const hasLocalPending =
        pendingSyncPaths.has(path) || (localTextPaths.has(path) && !hasSyncedBaseline && remoteVersion === 0);
      const hasRemotePending = remoteVersion > syncedVersion;
      const state: CollabFileSyncState =
        hasLocalPending && hasRemotePending
          ? "conflict"
          : hasLocalPending
            ? "pending-push"
            : hasRemotePending
              ? "pending-pull"
              : "synced";
      byPath[path] = state;
      if (state === "pending-push") {
        pendingPushCount += 1;
      } else if (state === "pending-pull") {
        pendingPullCount += 1;
      } else if (state === "conflict") {
        conflictCount += 1;
      }
    }

    return {
      byPath,
      pendingPushCount,
      pendingPullCount,
      conflictCount,
    } satisfies CollabWorkspaceSyncSummary;
  }

  private async getRemoteDocumentsByPath() {
    if (this.remoteDocumentsByPath) {
      return this.remoteDocumentsByPath;
    }

    return this.refreshRemoteDocuments();
  }

  private async fetchRemoteDocumentsByPath() {
    if (!this.options.projectId) {
      return new Map<string, CloudDocumentSummary>();
    }

    const documents = await listCloudDocuments(this.options.authToken, this.options.projectId);
    return new Map(
      documents
        .filter((document) => document.kind === "text" || document.kind === "tex" || document.kind === "bib")
        .map((document) => [document.path, document]),
    );
  }

  private async getPendingSyncPaths() {
    if (this.pendingSyncPaths) {
      return this.pendingSyncPaths;
    }
    if (this.pendingSyncPathsPromise) {
      return this.pendingSyncPathsPromise;
    }

    this.pendingSyncPathsPromise = this.readPendingSyncPaths()
      .then((paths) => {
        this.pendingSyncPaths = paths;
        return paths;
      })
      .finally(() => {
        this.pendingSyncPathsPromise = null;
      });

    return this.pendingSyncPathsPromise;
  }

  private async isPathPendingSync(path: string) {
    const pendingPaths = await this.getPendingSyncPaths();
    return pendingPaths.has(path);
  }

  private async setPathPendingSync(path: string, pending: boolean) {
    const pendingPaths = await this.getPendingSyncPaths();
    const hadPath = pendingPaths.has(path);
    if (pending) {
      if (hadPath) {
        return;
      }
      pendingPaths.add(path);
    } else {
      if (!hadPath) {
        return;
      }
      pendingPaths.delete(path);
    }

    await this.persistPendingSyncPaths(pendingPaths);
  }

  private async readPendingSyncPaths() {
    if (!this.options.projectId) {
      return new Set<string>();
    }

    try {
      const file = await this.options.fileAdapter.readFile(pendingSyncManifestPath(this.options.projectId));
      const parsed = JSON.parse(file.content) as { paths?: unknown };
      if (!Array.isArray(parsed.paths)) {
        return new Set<string>();
      }
      return new Set(parsed.paths.filter((value): value is string => typeof value === "string" && value.trim().length > 0));
    } catch {
      return new Set<string>();
    }
  }

  private async persistPendingSyncPaths(paths: Set<string>) {
    if (!this.options.projectId) {
      return;
    }

    await this.ensurePersistenceDirectories();
    const payload = JSON.stringify({
      updatedAt: new Date().toISOString(),
      paths: Array.from(paths).sort(),
    });
    await this.options.fileAdapter.saveFile(pendingSyncManifestPath(this.options.projectId), payload);
  }

  private async prunePendingSyncPaths(validPaths: Set<string>) {
    const pendingPaths = await this.getPendingSyncPaths();
    let changed = false;
    for (const path of Array.from(pendingPaths)) {
      if (!validPaths.has(path)) {
        pendingPaths.delete(path);
        changed = true;
      }
    }

    if (changed) {
      await this.persistPendingSyncPaths(pendingPaths);
    }
  }

  private async getSyncedVersions() {
    if (this.syncedVersions) {
      return this.syncedVersions;
    }
    if (this.syncedVersionsPromise) {
      return this.syncedVersionsPromise;
    }

    this.syncedVersionsPromise = this.readSyncedVersions()
      .then((versions) => {
        this.syncedVersions = versions;
        return versions;
      })
      .finally(() => {
        this.syncedVersionsPromise = null;
      });

    return this.syncedVersionsPromise;
  }

  private async setSyncedVersion(path: string, version: number) {
    const syncedVersions = await this.getSyncedVersions();
    const currentVersion = syncedVersions.get(path);
    if (currentVersion === version) {
      return;
    }
    syncedVersions.set(path, version);
    await this.persistSyncedVersions(syncedVersions);
  }

  private async readSyncedVersions() {
    if (!this.options.projectId) {
      return new Map<string, number>();
    }

    try {
      const file = await this.options.fileAdapter.readFile(syncedVersionManifestPath(this.options.projectId));
      const parsed = JSON.parse(file.content) as { versions?: Record<string, unknown> };
      if (!parsed.versions || typeof parsed.versions !== "object") {
        return new Map<string, number>();
      }
      const entries = Object.entries(parsed.versions)
        .filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0)
        .map(([path, value]) => [path, value as number] as const);
      return new Map(entries);
    } catch {
      return new Map<string, number>();
    }
  }

  private async persistSyncedVersions(versions: Map<string, number>) {
    if (!this.options.projectId) {
      return;
    }

    await this.ensurePersistenceDirectories();
    const payload = JSON.stringify({
      updatedAt: new Date().toISOString(),
      versions: Object.fromEntries(Array.from(versions.entries()).sort(([left], [right]) => left.localeCompare(right))),
    });
    await this.options.fileAdapter.saveFile(syncedVersionManifestPath(this.options.projectId), payload);
  }

  private upsertRemoteDocumentVersion(path: string, latestVersion: number) {
    if (!this.options.projectId) {
      return;
    }

    if (!this.remoteDocumentsByPath) {
      this.remoteDocumentsByPath = new Map();
    }

    const existing = this.remoteDocumentsByPath.get(path);
    this.remoteDocumentsByPath.set(path, {
      id: existing?.id ?? `${this.options.projectId}:${path}`,
      projectId: this.options.projectId,
      path,
      kind: existing?.kind ?? "text",
      latestVersion,
      updatedAt: new Date().toISOString(),
    });
  }

  private async pruneSyncedVersions(validPaths: Set<string>) {
    const syncedVersions = await this.getSyncedVersions();
    let changed = false;
    for (const path of Array.from(syncedVersions.keys())) {
      if (!validPaths.has(path)) {
        syncedVersions.delete(path);
        changed = true;
      }
    }

    if (changed) {
      await this.persistSyncedVersions(syncedVersions);
    }
  }
}
