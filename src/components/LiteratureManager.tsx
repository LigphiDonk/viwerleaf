import { useState, useEffect, useCallback, useMemo } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import type {
  CliAgentStatus,
  LiteratureItem,
  LiteratureCandidate,
  LiteratureSearchResult,
  ZoteroSearchResult,
} from "../types";
import { desktop } from "../lib/desktop";

/* ── tiny helpers ── */
const isZhLocale = (locale: string) => locale.startsWith("zh");
const t = (locale: string, zh: string, en: string) =>
  isZhLocale(locale) ? zh : en;

function generateId() {
  return crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

/* ── Types ── */
type LiteratureTab = "inbox" | "library" | "search";
type LiteratureSearchSource = "local" | "zotero";

interface Props {
  locale: string;
  filterTaskId?: string | null;
  onClearTaskFilter?: () => void;
}

export function LiteratureManager({ locale, filterTaskId = null, onClearTaskFilter }: Props) {

  /* ── State ── */
  const [tab, setTab] = useState<LiteratureTab>("library");
  const [items, setItems] = useState<LiteratureItem[]>([]);
  const [inbox, setInbox] = useState<LiteratureCandidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<LiteratureSearchResult[]>(
    [],
  );
  const [zoteroResults, setZoteroResults] = useState<ZoteroSearchResult[]>([]);
  const [searchSource, setSearchSource] = useState<LiteratureSearchSource>("local");
  const [selectedZoteroKey, setSelectedZoteroKey] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [zoteroStatus, setZoteroStatus] = useState<CliAgentStatus | null>(null);

  const selectedItem = items.find((i) => i.id === selectedId) ?? null;
  const selectedZoteroResult = zoteroResults.find((item) => item.itemKey === selectedZoteroKey) ?? null;
  const visibleLibraryItems = useMemo(
    () =>
      filterTaskId
        ? items.filter((item) => item.linkedTaskIds.includes(filterTaskId))
        : items,
    [filterTaskId, items],
  );

  /* ── Data loading ── */
  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const [litItems, litInbox] = await Promise.all([
        desktop.listLiterature(),
        desktop.listLiteratureInbox(),
      ]);
      setItems(litItems);
      setInbox(litInbox);
    } catch (err) {
      console.error("Failed to load literature:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!filterTaskId) {
      return;
    }

    setTab("library");
    if (!visibleLibraryItems.some((item) => item.id === selectedId)) {
      setSelectedId(visibleLibraryItems[0]?.id ?? null);
    }
  }, [filterTaskId, selectedId, visibleLibraryItems]);

  useEffect(() => {
    desktop
      .detectZoteroMcp()
      .then((status) => setZoteroStatus(status))
      .catch((error) => {
        console.warn("failed to detect zotero-mcp", error);
        setZoteroStatus({ name: "zotero-mcp", available: false });
      });
  }, []);

  /* ── Handlers ── */
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setZoteroResults([]);
      setSelectedZoteroKey(null);
      setSearchError("");
      return;
    }

    setIsSearching(true);
    setSearchError("");
    try {
      if (searchSource === "zotero") {
        const results = await desktop.searchZoteroLiterature(searchQuery);
        setZoteroResults(results);
        setSearchResults([]);
        setSelectedZoteroKey(results[0]?.itemKey ?? null);
      } else {
        const results = await desktop.searchLiterature(searchQuery);
        setSearchResults(results);
        setZoteroResults([]);
        setSelectedZoteroKey(null);
        if (results[0]) {
          setSelectedId(results[0].item.id);
        }
      }
      setTab("search");
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err));
      console.error("Search failed:", err);
    } finally {
      setIsSearching(false);
    }
  }, [searchQuery, searchSource]);

  const handleAddManual = useCallback(async () => {
    const title = prompt(t(locale, "输入文献标题", "Enter paper title"));
    if (!title) return;
    const item: LiteratureItem = {
      id: generateId(),
      title,
      authors: [],
      year: new Date().getFullYear(),
      journal: "",
      doi: "",
      abstract: "",
      tags: [],
      notes: "",
      dedupHash: "",
      linkedTaskIds: [],
      addedAt: "",
      updatedAt: "",
    };
    try {
      await desktop.addLiterature(item);
      setSelectedId(item.id);
      setTab("library");
      await refresh();
    } catch (err) {
      console.error("Failed to add item:", err);
    }
  }, [locale, refresh]);

  const handleImportPdf = useCallback(async () => {
    let filePath: string | null = null;
    if (desktop.isTauriRuntime()) {
      const selected = await openDialog({
        title: t(locale, "选择 PDF 文件", "Select PDF file"),
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      filePath = typeof selected === "string" ? selected : null;
    } else {
      const mockTitle = prompt(
        t(locale, "输入一个 PDF 文件名", "Enter a PDF filename"),
        "paper.pdf",
      );
      filePath = mockTitle?.trim() || null;
    }
    if (!filePath) return;

    const itemId = generateId();
    const item: LiteratureItem = {
      id: itemId,
      title: typeof filePath === "string"
        ? filePath.split("/").pop()?.replace(".pdf", "") ?? "Untitled"
        : "Untitled",
      authors: [],
      year: new Date().getFullYear(),
      journal: "",
      doi: "",
      abstract: "",
      tags: [],
      notes: "",
      dedupHash: "",
      linkedTaskIds: [],
      addedAt: "",
      updatedAt: "",
    };

    try {
      const addedItem = await desktop.addLiteratureWithPdf(item, filePath);
      const attachments = await desktop.listLiteratureAttachments(addedItem.id);
      const managedPdfPath =
        attachments.find((attachment) => attachment.kind === "pdf")?.filePath ?? filePath;
      setSelectedId(addedItem.id);
      setTab("library");
      await refresh();
      // Trigger background ingestion (extract text, chunk, index for FTS)
      desktop.ingestLiterature(addedItem.id, managedPdfPath, addedItem.title).catch((err) =>
        console.warn("Background ingestion failed:", err),
      );
    } catch (err) {
      console.error("Failed to import PDF:", err);
    }
  }, [locale, refresh]);

  const handleApproveCandidate = useCallback(
    async (inboxId: string) => {
      try {
        const item = await desktop.approveLiteratureCandidate(inboxId);
        setSelectedId(item.id);
        setTab("library");
        await refresh();
      } catch (err) {
        console.error("Failed to approve candidate:", err);
      }
    },
    [refresh],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm(t(locale, "确认删除？", "Confirm delete?"))) return;
      try {
        await desktop.deleteLiterature(id);
        if (selectedId === id) setSelectedId(null);
        await refresh();
      } catch (err) {
        console.error("Failed to delete:", err);
      }
    },
    [locale, selectedId, refresh],
  );

  const handleUpdateNotes = useCallback(
    async (id: string, notes: string) => {
      try {
        await desktop.updateLiteratureNotes(id, notes);
        setItems((prev) =>
          prev.map((item) => (item.id === id ? { ...item, notes } : item)),
        );
      } catch (err) {
        console.error("Failed to update notes:", err);
      }
    },
    [],
  );

  const handleImportZotero = useCallback(
    async (itemKey: string, libraryId: string) => {
      try {
        const item = await desktop.importZoteroLiterature(itemKey, libraryId || undefined);
        setSelectedId(item.id);
        setTab("library");
        await refresh();
      } catch (err) {
        setSearchError(err instanceof Error ? err.message : String(err));
        console.error("Failed to import Zotero item:", err);
      }
    },
    [refresh],
  );

  /* ── Render ── */
  return (
    <div className="literature-manager">
      {/* ── Toolbar ── */}
      <div className="literature-toolbar">
        <div className="literature-toolbar__tabs">
          <button
            className={`literature-tab ${tab === "library" ? "is-active" : ""}`}
            onClick={() => setTab("library")}
          >
            {t(locale, "文献库", "Library")}
            <span className="literature-tab__count">{items.length}</span>
          </button>
          <button
            className={`literature-tab ${tab === "inbox" ? "is-active" : ""}`}
            onClick={() => setTab("inbox")}
          >
            {t(locale, "收件箱", "Inbox")}
            {inbox.length > 0 && (
              <span className="literature-tab__badge">{inbox.length}</span>
            )}
          </button>
          <button
            className={`literature-tab ${tab === "search" ? "is-active" : ""}`}
            onClick={() => setTab("search")}
          >
            {t(locale, "搜索", "Search")}
          </button>
        </div>

        <div className="literature-toolbar__search">
          <div className="agent-model-chips" style={{ marginRight: 8 }}>
            <button
              type="button"
              className={`model-chip ${searchSource === "local" ? "model-chip--active" : ""}`}
              onClick={() => setSearchSource("local")}
            >
              {t(locale, "本地库", "Local")}
            </button>
            <button
              type="button"
              className={`model-chip ${searchSource === "zotero" ? "model-chip--active" : ""}`}
              onClick={() => setSearchSource("zotero")}
            >
              Zotero
            </button>
          </div>
          <div
            className="literature-badge"
            style={{
              marginRight: 8,
              borderColor: zoteroStatus?.available ? "rgba(22, 163, 74, 0.28)" : "rgba(185, 28, 28, 0.22)",
              background: zoteroStatus?.available ? "rgba(22, 163, 74, 0.12)" : "rgba(239, 68, 68, 0.08)",
              color: zoteroStatus?.available ? "#166534" : "#991b1b",
            }}
            title={zoteroStatus?.path || (zoteroStatus?.available ? "zotero-mcp detected" : "zotero-mcp not found")}
          >
            {zoteroStatus == null
              ? t(locale, "Zotero 检测中…", "Checking Zotero…")
              : zoteroStatus.available
                ? t(locale, "Zotero 已连接", "Zotero Connected")
                : t(locale, "Zotero 未安装", "Zotero Not Installed")}
          </div>
          <input
            type="text"
            className="literature-search-input"
            placeholder={
              searchSource === "zotero"
                ? t(locale, "搜索 Zotero 文献库…", "Search Zotero library…")
                : t(locale, "搜索文献…", "Search literature…")
            }
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
          />
          <button
            className="literature-toolbar__btn"
            onClick={() => void handleSearch()}
            title={t(locale, "搜索", "Search")}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
        </div>
        {searchSource === "zotero" && zoteroStatus && !zoteroStatus.available && (
          <div
            className="literature-empty__hint"
            style={{ marginLeft: 12, maxWidth: 320 }}
          >
            {t(
              locale,
              "未检测到 `zotero-mcp`。先在本机安装并执行 `zotero-mcp setup`，然后重启应用。",
              "No `zotero-mcp` detected. Install it locally, run `zotero-mcp setup`, then restart the app.",
            )}
          </div>
        )}

        <div className="literature-toolbar__actions">
          <button
            className="literature-toolbar__btn"
            onClick={() => void handleImportPdf()}
            title={t(locale, "导入 PDF", "Import PDF")}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <span>{t(locale, "上传 PDF", "Upload PDF")}</span>
          </button>
          <button
            className="literature-toolbar__btn"
            onClick={() => void handleAddManual()}
            title={t(locale, "手动添加", "Add manually")}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            <span>{t(locale, "手动添加", "Add")}</span>
          </button>
        </div>
      </div>

      {/* ── Body split ── */}
      <div className="literature-body">
        {/* Left: list */}
        <div className="literature-list">
          {filterTaskId && tab === "library" && (
            <div className="literature-empty">
              <p>{t(locale, "正在查看该研究任务关联的文献", "Showing literature linked to this research task")}</p>
              {onClearTaskFilter && (
                <button
                  className="literature-toolbar__btn"
                  onClick={() => onClearTaskFilter()}
                  type="button"
                >
                  {t(locale, "查看全部文献", "Show all literature")}
                </button>
              )}
            </div>
          )}

          {isLoading && (
            <div className="literature-empty">
              {t(locale, "加载中…", "Loading…")}
            </div>
          )}

          {tab === "search" && isSearching && (
            <div className="literature-empty">
              {t(locale, "搜索中…", "Searching…")}
            </div>
          )}

          {tab === "search" && searchError && !isSearching && (
            <div className="literature-empty">
              <p>{t(locale, "搜索失败", "Search failed")}</p>
              <p className="literature-empty__hint">{searchError}</p>
            </div>
          )}

          {/* Library tab */}
          {tab === "library" &&
            !isLoading &&
            (visibleLibraryItems.length === 0 ? (
              <div className="literature-empty">
                <p>
                  {filterTaskId
                    ? t(locale, "该任务下还没有关联文献", "No literature linked to this task yet")
                    : t(locale, "文献库为空", "Library is empty")}
                </p>
                <p className="literature-empty__hint">
                  {t(
                    locale,
                    "点击上方「上传 PDF」或「手动添加」来添加文献",
                    "Click 'Upload PDF' or 'Add' above to get started",
                  )}
                </p>
              </div>
            ) : (
              visibleLibraryItems.map((item) => (
                <button
                  key={item.id}
                  className={`literature-card ${selectedId === item.id ? "is-selected" : ""}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  <div className="literature-card__title">{item.title}</div>
                  <div className="literature-card__meta">
                    {item.authors.length > 0 && (
                      <span>{item.authors.slice(0, 3).join(", ")}</span>
                    )}
                    {item.year > 0 && <span>{item.year}</span>}
                    {item.journal && <span>{item.journal}</span>}
                  </div>
                  {item.tags.length > 0 && (
                    <div className="literature-card__tags">
                      {item.tags.map((tag) => (
                        <span key={tag} className="literature-tag">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              ))
            ))}

          {/* Inbox tab */}
          {tab === "inbox" &&
            !isLoading &&
            (inbox.length === 0 ? (
              <div className="literature-empty">
                <p>{t(locale, "收件箱为空", "Inbox is empty")}</p>
              </div>
            ) : (
              inbox.map((candidate) => (
                <div key={candidate.id} className="literature-card literature-card--inbox">
                  <div className="literature-card__title">
                    {candidate.title || t(locale, "无标题", "Untitled")}
                  </div>
                  <div className="literature-card__meta">
                    {candidate.authors.length > 0 && (
                      <span>{candidate.authors.slice(0, 2).join(", ")}</span>
                    )}
                    {candidate.year > 0 && <span>{candidate.year}</span>}
                    {candidate.dedupStatus === "duplicate" && (
                      <span className="literature-badge literature-badge--warn">
                        {t(locale, "疑似重复", "Duplicate")}
                      </span>
                    )}
                  </div>
                  {candidate.sourceContext && (
                    <div className="literature-card__source">
                      {candidate.sourceContext}
                    </div>
                  )}
                  <div className="literature-card__actions">
                    <button
                      className="literature-card__action-btn"
                      onClick={() => void handleApproveCandidate(candidate.id)}
                    >
                      {t(locale, "✓ 入库", "✓ Approve")}
                    </button>
                  </div>
                </div>
              ))
            ))}

          {/* Search tab */}
          {tab === "search" &&
            !isLoading &&
            !isSearching &&
            !searchError &&
            (searchSource === "zotero" ? (
              zoteroResults.length === 0 ? (
                <div className="literature-empty">
                  <p>
                    {searchQuery
                      ? t(locale, "Zotero 中未找到结果", "No Zotero results found")
                      : t(locale, "输入关键词搜索 Zotero", "Enter keywords to search Zotero")}
                  </p>
                </div>
              ) : (
                zoteroResults.map((result) => (
                  <button
                    key={result.itemKey}
                    className={`literature-card ${selectedZoteroKey === result.itemKey ? "is-selected" : ""}`}
                    onClick={() => setSelectedZoteroKey(result.itemKey)}
                  >
                    <div className="literature-card__title">
                      {result.title}
                    </div>
                    <div className="literature-card__meta">
                      <span className="literature-badge">Zotero</span>
                      {result.authors.length > 0 && (
                        <span>{result.authors.slice(0, 2).join(", ")}</span>
                      )}
                      {result.year > 0 && <span>{result.year}</span>}
                    </div>
                    {result.snippet && (
                      <div className="literature-card__snippet">
                        {result.snippet}
                      </div>
                    )}
                    <div className="literature-card__actions">
                      <button
                        className="literature-card__action-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleImportZotero(result.itemKey, result.libraryId);
                        }}
                      >
                        {t(locale, "导入到文献库", "Import")}
                      </button>
                    </div>
                  </button>
                ))
              )
            ) : searchResults.length === 0 ? (
              <div className="literature-empty">
                <p>
                  {searchQuery
                    ? t(locale, "未找到结果", "No results found")
                    : t(locale, "输入关键词搜索", "Enter keywords to search")}
                </p>
              </div>
            ) : (
              searchResults.map((result) => (
                <button
                  key={`${result.item.id}-${result.rank}`}
                  className={`literature-card ${selectedId === result.item.id ? "is-selected" : ""}`}
                  onClick={() => setSelectedId(result.item.id)}
                >
                  <div className="literature-card__title">
                    {result.item.title}
                  </div>
                  <div className="literature-card__meta">
                    <span className="literature-badge">
                      {result.matchField}
                    </span>
                    {result.chunkIndex != null && (
                      <span>chunk #{result.chunkIndex}</span>
                    )}
                  </div>
                  {result.snippet && (
                    <div className="literature-card__snippet">
                      {result.snippet}
                    </div>
                  )}
                </button>
              ))
            ))}
        </div>

        {/* Right: detail */}
        <div className="literature-detail">
          {tab === "search" && searchSource === "zotero" && selectedZoteroResult ? (
            <>
              <h2 className="literature-detail__title">{selectedZoteroResult.title}</h2>
              <div className="literature-detail__meta-grid">
                {selectedZoteroResult.authors.length > 0 && (
                  <div className="literature-detail__field">
                    <label>{t(locale, "作者", "Authors")}</label>
                    <span>{selectedZoteroResult.authors.join(", ")}</span>
                  </div>
                )}
                {selectedZoteroResult.year > 0 && (
                  <div className="literature-detail__field">
                    <label>{t(locale, "年份", "Year")}</label>
                    <span>{selectedZoteroResult.year}</span>
                  </div>
                )}
                {selectedZoteroResult.journal && (
                  <div className="literature-detail__field">
                    <label>{t(locale, "期刊", "Journal")}</label>
                    <span>{selectedZoteroResult.journal}</span>
                  </div>
                )}
                {selectedZoteroResult.doi && (
                  <div className="literature-detail__field">
                    <label>DOI</label>
                    <a
                      href={`https://doi.org/${selectedZoteroResult.doi}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {selectedZoteroResult.doi}
                    </a>
                  </div>
                )}
                {selectedZoteroResult.itemType && (
                  <div className="literature-detail__field">
                    <label>{t(locale, "类型", "Type")}</label>
                    <span>{selectedZoteroResult.itemType}</span>
                  </div>
                )}
              </div>

              {selectedZoteroResult.abstract && (
                <div className="literature-detail__section">
                  <h3>{t(locale, "摘要", "Abstract")}</h3>
                  <p>{selectedZoteroResult.abstract}</p>
                </div>
              )}

              {selectedZoteroResult.tags.length > 0 && (
                <div className="literature-detail__section">
                  <h3>{t(locale, "标签", "Tags")}</h3>
                  <div className="literature-card__tags">
                    {selectedZoteroResult.tags.map((tag) => (
                      <span key={tag} className="literature-tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="literature-detail__footer">
                <button
                  className="literature-detail__delete-btn"
                  onClick={() =>
                    void handleImportZotero(
                      selectedZoteroResult.itemKey,
                      selectedZoteroResult.libraryId,
                    )
                  }
                >
                  {t(locale, "导入到文献库", "Import into library")}
                </button>
              </div>
            </>
          ) : selectedItem ? (
            <>
              <h2 className="literature-detail__title">
                {selectedItem.title}
              </h2>
              <div className="literature-detail__meta-grid">
                {selectedItem.authors.length > 0 && (
                  <div className="literature-detail__field">
                    <label>{t(locale, "作者", "Authors")}</label>
                    <span>{selectedItem.authors.join(", ")}</span>
                  </div>
                )}
                {selectedItem.year > 0 && (
                  <div className="literature-detail__field">
                    <label>{t(locale, "年份", "Year")}</label>
                    <span>{selectedItem.year}</span>
                  </div>
                )}
                {selectedItem.journal && (
                  <div className="literature-detail__field">
                    <label>{t(locale, "期刊", "Journal")}</label>
                    <span>{selectedItem.journal}</span>
                  </div>
                )}
                {selectedItem.doi && (
                  <div className="literature-detail__field">
                    <label>DOI</label>
                    <a
                      href={`https://doi.org/${selectedItem.doi}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {selectedItem.doi}
                    </a>
                  </div>
                )}
              </div>

              {selectedItem.abstract && (
                <div className="literature-detail__section">
                  <h3>{t(locale, "摘要", "Abstract")}</h3>
                  <p>{selectedItem.abstract}</p>
                </div>
              )}

              <div className="literature-detail__section">
                <h3>{t(locale, "笔记", "Notes")}</h3>
                <textarea
                  className="literature-detail__notes"
                  value={selectedItem.notes}
                  placeholder={t(
                    locale,
                    "输入笔记…",
                    "Write notes here…",
                  )}
                  onChange={(e) =>
                    setItems((prev) =>
                      prev.map((i) =>
                        i.id === selectedItem.id
                          ? { ...i, notes: e.target.value }
                          : i,
                      ),
                    )
                  }
                  onBlur={() =>
                    void handleUpdateNotes(
                      selectedItem.id,
                      selectedItem.notes,
                    )
                  }
                />
              </div>

              {selectedItem.linkedTaskIds.length > 0 && (
                <div className="literature-detail__section">
                  <h3>
                    {t(locale, "关联研究任务", "Linked Research Tasks")}
                  </h3>
                  <div className="literature-detail__tasks">
                    {selectedItem.linkedTaskIds.map((taskId) => (
                      <span key={taskId} className="literature-task-link">
                        {taskId}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="literature-detail__footer">
                <button
                  className="literature-detail__delete-btn"
                  onClick={() => void handleDelete(selectedItem.id)}
                >
                  {t(locale, "删除文献", "Delete")}
                </button>
              </div>
            </>
          ) : (
            <div className="literature-empty">
              <p>
                {t(
                  locale,
                  "选择一篇文献查看详情",
                  "Select a paper to view details",
                )}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
