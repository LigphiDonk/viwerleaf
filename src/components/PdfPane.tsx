import { pdfjs, Document, Page } from "react-pdf";
import { useMemo, useState } from "react";

import type { CompileResult } from "../types";

import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

export type PreviewPaneState =
  | {
      kind: "compile";
      compileResult: CompileResult;
      fileUrl?: string;
      highlightedPage: number;
      onPageJump: (page: number) => void;
    }
  | {
      kind: "pdf";
      title: string;
      fileUrl: string;
      highlightedPage: number;
      onPageJump: (page: number) => void;
    }
  | {
      kind: "image";
      title: string;
      fileUrl: string;
    }
  | {
      kind: "unsupported";
      title: string;
      description: string;
    };

function PdfPreview({
  file,
  highlightedPage,
  onPageJump,
  statusLabel,
}: {
  file?: { data: Uint8Array } | string;
  highlightedPage: number;
  onPageJump: (page: number) => void;
  statusLabel: string;
}) {
  const [pageCount, setPageCount] = useState(0);

  return (
    <>
      <div className="preview-header">
        <span style={{ fontWeight: 500 }}>PDF 预览</span>
        <div style={{ display: "flex", gap: "12px", color: "var(--text-secondary)" }}>
          <span>{statusLabel}</span>
          <span>{pageCount ? `共 ${pageCount} 页` : "暂无页面"}</span>
        </div>
      </div>

      {pageCount > 0 && (
        <div
          style={{
            padding: "8px 16px",
            borderBottom: "1px solid var(--border-light)",
            display: "flex",
            gap: "6px",
            overflowX: "auto",
            background: "var(--bg-sidebar)",
          }}
        >
          {Array.from({ length: Math.max(pageCount, 1) }, (_, index) => (
            <button
              key={`jump-${index + 1}`}
              className={highlightedPage === index + 1 ? "btn-primary" : "btn-secondary"}
              style={{ padding: "4px 10px", borderRadius: "4px", fontSize: "11px", minWidth: "32px" }}
              onClick={() => onPageJump(index + 1)}
            >
              {index + 1}
            </button>
          ))}
        </div>
      )}

      <div className="preview-content">
        {file ? (
          <Document
            file={file}
            onLoadSuccess={({ numPages }) => setPageCount(numPages)}
            loading={<div className="pdf-placeholder">正在加载 PDF 文件...</div>}
            error={<div className="pdf-placeholder">无法加载预览文档</div>}
          >
            {Array.from({ length: pageCount || 1 }, (_, index) => {
              const page = index + 1;
              return (
                <div key={page} className={`pdf-page-frame ${highlightedPage === page ? "is-highlighted" : ""}`}>
                  <button className="pdf-page-hitbox" onClick={() => onPageJump(page)} type="button">
                    <Page pageNumber={page} width={430} renderTextLayer={false} renderAnnotationLayer={false} />
                  </button>
                </div>
              );
            })}
          </Document>
        ) : (
          <div className="pdf-placeholder">暂无可预览的 PDF</div>
        )}
      </div>
    </>
  );
}

export function PdfPane({ preview }: { preview: PreviewPaneState }) {
  const compilePdfData = preview.kind === "compile" ? preview.compileResult.pdfData : undefined;
  const compileFileUrl = preview.kind === "compile" ? preview.fileUrl : undefined;
  const directPdfUrl = preview.kind === "pdf" ? preview.fileUrl : undefined;

  const compilePdfFile = useMemo(() => {
    if (!compilePdfData) {
      return compileFileUrl;
    }
    return { data: compilePdfData };
  }, [compileFileUrl, compilePdfData]);

  const pdfFile = preview.kind === "compile" ? compilePdfFile : directPdfUrl;

  if (preview.kind === "image") {
    return (
      <>
        <div className="preview-header">
          <span style={{ fontWeight: 500 }}>图片预览</span>
          <div style={{ color: "var(--text-secondary)" }}>{preview.title}</div>
        </div>
        <div className="preview-content" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <img
            src={preview.fileUrl}
            alt={preview.title}
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 12 }}
          />
        </div>
      </>
    );
  }

  if (preview.kind === "unsupported") {
    return (
      <>
        <div className="preview-header">
          <span style={{ fontWeight: 500 }}>预览不可用</span>
          <div style={{ color: "var(--text-secondary)" }}>{preview.title}</div>
        </div>
        <div className="preview-content">
          <div className="pdf-placeholder">{preview.description}</div>
        </div>
      </>
    );
  }

  if (preview.kind === "pdf") {
    return (
      <PdfPreview
        file={pdfFile}
        highlightedPage={preview.highlightedPage}
        onPageJump={preview.onPageJump}
        statusLabel={preview.title}
      />
    );
  }

  const statusLabel =
    preview.compileResult.status === "success"
      ? "编译成功"
      : preview.compileResult.status === "failed"
        ? "编译失败"
        : preview.compileResult.status;

  return (
    <PdfPreview
      file={pdfFile}
      highlightedPage={preview.highlightedPage}
      onPageJump={preview.onPageJump}
      statusLabel={statusLabel}
    />
  );
}
