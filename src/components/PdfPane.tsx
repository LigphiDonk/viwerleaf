import { memo } from "react";

import PdfJsViewer, { toPdfSource } from "./pdf-preview/PdfJsViewer";
import type { CompileResult } from "../types";

export type PreviewPaneState =
  | {
      kind: "compile";
      compileResult: CompileResult;
      fileData?: Uint8Array;
      fileUrl?: string;
      isLoading?: boolean;
      highlightedPage: number;
      onPageJump: (page: number) => void;
    }
  | {
      kind: "pdf";
      title: string;
      fileData?: Uint8Array;
      fileUrl?: string;
      isLoading?: boolean;
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

function PdfPaneInner({ preview }: { preview: PreviewPaneState }) {
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
      <PdfJsViewer
        source={toPdfSource(preview.fileData, preview.fileUrl)}
        reloadKey={preview.fileUrl ?? preview.title}
        isLoading={preview.isLoading}
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
    <PdfJsViewer
      source={toPdfSource(preview.fileData ?? preview.compileResult.pdfData, preview.fileUrl)}
      reloadKey={`${preview.compileResult.timestamp}:${preview.compileResult.pdfPath ?? preview.fileUrl ?? ""}`}
      isLoading={preview.isLoading}
      highlightedPage={preview.highlightedPage}
      onPageJump={preview.onPageJump}
      statusLabel={statusLabel}
    />
  );
}

function arePreviewPaneStatesEqual(previous: PreviewPaneState, next: PreviewPaneState) {
  if (previous.kind !== next.kind) {
    return false;
  }

  if (previous.kind === "image" && next.kind === "image") {
    return previous.title === next.title && previous.fileUrl === next.fileUrl;
  }

  if (previous.kind === "unsupported" && next.kind === "unsupported") {
    return previous.title === next.title && previous.description === next.description;
  }

  if (previous.kind === "pdf" && next.kind === "pdf") {
    return (
      previous.title === next.title &&
      previous.fileData === next.fileData &&
      previous.fileUrl === next.fileUrl &&
      previous.isLoading === next.isLoading &&
      previous.highlightedPage === next.highlightedPage &&
      previous.onPageJump === next.onPageJump
    );
  }

  if (previous.kind === "compile" && next.kind === "compile") {
    return (
      previous.compileResult.status === next.compileResult.status &&
      previous.compileResult.timestamp === next.compileResult.timestamp &&
      previous.compileResult.pdfPath === next.compileResult.pdfPath &&
      previous.fileData === next.fileData &&
      previous.fileUrl === next.fileUrl &&
      previous.isLoading === next.isLoading &&
      previous.highlightedPage === next.highlightedPage &&
      previous.onPageJump === next.onPageJump
    );
  }

  return false;
}

export const PdfPane = memo(
  PdfPaneInner,
  (previous, next) => arePreviewPaneStatesEqual(previous.preview, next.preview),
);
