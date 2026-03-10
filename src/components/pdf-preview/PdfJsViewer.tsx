import { memo, useCallback, useEffect, useRef, useState } from "react";

import { PDFJSWrapper, type PdfScaleValue } from "../../lib/pdf-js-wrapper";

type PdfSource = Uint8Array | string | undefined;

export interface PdfJsViewerProps {
  source: PdfSource;
  reloadKey?: string;
  isLoading?: boolean;
  highlightedPage: number;
  onPageJump: (page: number) => void;
  statusLabel: string;
}

function PdfJsViewerInner({
  source,
  reloadKey,
  isLoading,
  highlightedPage,
  onPageJump,
  statusLabel,
}: PdfJsViewerProps) {
  const [pdfJsWrapper, setPdfJsWrapper] = useState<PDFJSWrapper | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [scale, setScale] = useState(1);
  const [errorMessage, setErrorMessage] = useState("");
  const scalePreferenceRef = useRef<PdfScaleValue>("page-width");

  const handleContainer = useCallback((parent: HTMLDivElement | null) => {
    if (!parent || pdfJsWrapper) {
      return;
    }

    const inner = parent.firstElementChild;
    if (!(inner instanceof HTMLDivElement)) {
      return;
    }

    setPdfJsWrapper(new PDFJSWrapper(inner));
  }, [pdfJsWrapper]);

  useEffect(() => {
    return () => {
      if (pdfJsWrapper) {
        void pdfJsWrapper.destroy();
      }
    };
  }, [pdfJsWrapper]);

  useEffect(() => {
    if (!pdfJsWrapper) {
      return;
    }

    const stopPageChange = pdfJsWrapper.onPageChange((page) => {
      setCurrentPage(page);
      setPageInput(String(page));
    });
    const stopScaleChange = pdfJsWrapper.onScaleChange((nextScale) => {
      setScale(nextScale);
    });

    return () => {
      stopPageChange();
      stopScaleChange();
    };
  }, [pdfJsWrapper]);

  useEffect(() => {
    if (!pdfJsWrapper) {
      return;
    }

    if (!source) {
      setPageCount(0);
      setCurrentPage(1);
      setPageInput("1");
      setErrorMessage("");
      void pdfJsWrapper.clearDocument();
      return;
    }

    let cancelled = false;
    setErrorMessage("");

    void pdfJsWrapper
      .loadDocument(source)
      .then((document) => {
        if (cancelled || !document) {
          return;
        }

        pdfJsWrapper.setScale(scalePreferenceRef.current);
        setPageCount(document.numPages);
        setCurrentPage(pdfJsWrapper.currentPage);
        setPageInput(String(pdfJsWrapper.currentPage));
        setScale(pdfJsWrapper.currentScale);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message || "加载 PDF 失败");
        setPageCount(0);
      });

    return () => {
      cancelled = true;
    };
  }, [pdfJsWrapper, reloadKey, source]);

  useEffect(() => {
    if (!pdfJsWrapper || !pageCount || highlightedPage <= 0) {
      return;
    }

    if (highlightedPage !== pdfJsWrapper.currentPage) {
      pdfJsWrapper.scrollToPage(highlightedPage);
      setCurrentPage(pdfJsWrapper.currentPage);
      setPageInput(String(pdfJsWrapper.currentPage));
    }
  }, [highlightedPage, pageCount, pdfJsWrapper]);

  useEffect(() => {
    if (!pdfJsWrapper || !("ResizeObserver" in window)) {
      return;
    }

    let timeoutId = 0;
    const resizeListener = () => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        pdfJsWrapper.updateOnResize();
      }, 120);
    };

    const resizeObserver = new ResizeObserver(resizeListener);
    resizeObserver.observe(pdfJsWrapper.container);
    window.addEventListener("resize", resizeListener);

    return () => {
      window.clearTimeout(timeoutId);
      resizeObserver.disconnect();
      window.removeEventListener("resize", resizeListener);
    };
  }, [pdfJsWrapper]);

  const jumpToPage = useCallback(
    (page: number) => {
      if (!pdfJsWrapper || !pageCount) {
        return;
      }

      const target = Math.max(1, Math.min(page, pageCount));
      pdfJsWrapper.scrollToPage(target);
      setCurrentPage(pdfJsWrapper.currentPage);
      setPageInput(String(pdfJsWrapper.currentPage));
      onPageJump(target);
    },
    [onPageJump, pageCount, pdfJsWrapper],
  );

  const applyScale = useCallback(
    (next: PdfScaleValue) => {
      if (!pdfJsWrapper) {
        return;
      }

      scalePreferenceRef.current = next;
      pdfJsWrapper.setScale(next);
      setScale(pdfJsWrapper.currentScale);
    },
    [pdfJsWrapper],
  );

  const handlePageInputCommit = useCallback(() => {
    const parsed = Number.parseInt(pageInput, 10);
    if (!Number.isFinite(parsed)) {
      setPageInput(String(currentPage));
      return;
    }
    jumpToPage(parsed);
  }, [currentPage, jumpToPage, pageInput]);

  const noDocument = !source && !errorMessage;

  return (
    <>
      <div className="preview-header">
        <span style={{ fontWeight: 500 }}>PDF 预览</span>
        <div style={{ display: "flex", gap: "12px", color: "var(--text-secondary)" }}>
          <span>{statusLabel}</span>
          <span>{pageCount ? `共 ${pageCount} 页` : "暂无页面"}</span>
        </div>
      </div>

      <div className="preview-content preview-content-pdf">
        <div className="pdf-toolbar">
          <button
            className="btn-secondary"
            type="button"
            onClick={() => jumpToPage(currentPage - 1)}
            disabled={pageCount <= 0 || currentPage <= 1}
          >
            上一页
          </button>
          <input
            value={pageInput}
            className="pdf-page-input"
            onChange={(event) => setPageInput(event.target.value)}
            onBlur={handlePageInputCommit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handlePageInputCommit();
              }
            }}
            aria-label="页码"
          />
          <span className="text-subtle">/ {Math.max(pageCount, 1)}</span>
          <button
            className="btn-secondary"
            type="button"
            onClick={() => jumpToPage(currentPage + 1)}
            disabled={pageCount <= 0 || currentPage >= pageCount}
          >
            下一页
          </button>

          <div style={{ width: 1, height: 20, background: "var(--border-light)", margin: "0 4px" }} />

          <button className="btn-secondary" type="button" onClick={() => applyScale(Math.max(0.4, scale - 0.1))}>
            -
          </button>
          <span className="text-subtle" style={{ minWidth: 56, textAlign: "center" }}>
            {Math.round(scale * 100)}%
          </span>
          <button className="btn-secondary" type="button" onClick={() => applyScale(Math.min(4, scale + 0.1))}>
            +
          </button>
          <button className="btn-secondary" type="button" onClick={() => applyScale("page-width")}>
            适应宽度
          </button>
          <button className="btn-secondary" type="button" onClick={() => applyScale("page-fit")}>
            适应页面
          </button>
        </div>

        {errorMessage ? (
          <div className="pdf-placeholder">PDF 加载失败：{errorMessage}</div>
        ) : noDocument ? (
          <div className="pdf-placeholder">{isLoading ? "正在加载 PDF 文件..." : "暂无可预览的 PDF"}</div>
        ) : (
          <div className="pdfjs-viewer pdfjs-viewer-outer" ref={handleContainer}>
            <div className="pdfjs-viewer-inner" tabIndex={0} role="tabpanel">
              <div className="pdfViewer" />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function arePdfJsViewerPropsEqual(previous: PdfJsViewerProps, next: PdfJsViewerProps) {
  return (
    previous.source === next.source &&
    previous.reloadKey === next.reloadKey &&
    previous.isLoading === next.isLoading &&
    previous.highlightedPage === next.highlightedPage &&
    previous.onPageJump === next.onPageJump &&
    previous.statusLabel === next.statusLabel
  );
}

const PdfJsViewer = memo(PdfJsViewerInner, arePdfJsViewerPropsEqual);

export function toPdfSource(fileData?: Uint8Array, fileUrl?: string): PdfSource {
  if (fileData && fileData.length > 0) {
    return fileData;
  }
  if (fileUrl) {
    return fileUrl;
  }
  return undefined;
}

export default PdfJsViewer;
