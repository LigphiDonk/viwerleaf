import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import { EventBus, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";

import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";

GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

export type PdfScaleValue = number | "page-width" | "page-fit";

export class PDFJSWrapper {
  readonly container: HTMLDivElement;
  readonly viewerElement: HTMLDivElement;
  readonly eventBus: EventBus;

  private readonly linkService: PDFLinkService;
  private readonly viewer: PDFViewer;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private document: PDFDocumentProxy | null = null;
  private loadVersion = 0;

  constructor(container: HTMLDivElement) {
    this.container = container;
    this.container.style.position = "absolute";
    this.container.style.inset = "0";

    const existingViewer = this.container.querySelector(".pdfViewer");
    if (existingViewer instanceof HTMLDivElement) {
      this.viewerElement = existingViewer;
    } else {
      this.viewerElement = document.createElement("div");
      this.viewerElement.className = "pdfViewer";
      this.container.replaceChildren(this.viewerElement);
    }

    this.eventBus = new EventBus();
    this.linkService = new PDFLinkService({ eventBus: this.eventBus });
    this.viewer = new PDFViewer({
      container: this.container,
      viewer: this.viewerElement,
      eventBus: this.eventBus,
      linkService: this.linkService,
      textLayerMode: 1,
      annotationMode: 2,
      removePageBorders: false,
    });

    this.linkService.setViewer(this.viewer);
  }

  private async toPdfData(source: Uint8Array | string) {
    if (source instanceof Uint8Array) {
      return source;
    }

    const response = await fetch(source, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`PDF request failed: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async loadDocument(source: Uint8Array | string): Promise<PDFDocumentProxy | null> {
    const version = ++this.loadVersion;
    await this.disposeTaskAndDoc();

    const data = await this.toPdfData(source);
    if (version !== this.loadVersion) {
      return null;
    }

    const loadingTask = getDocument({ data });
    this.loadingTask = loadingTask;

    const document = await loadingTask.promise;
    if (version !== this.loadVersion) {
      await document.destroy();
      return null;
    }

    this.document = document;
    this.viewer.setDocument(document);
    this.linkService.setDocument(document, null);

    await this.viewer.firstPagePromise;
    if (version !== this.loadVersion) {
      return null;
    }

    if (this.viewer.currentScaleValue === "1") {
      this.viewer.currentScaleValue = "page-width";
    }

    return document;
  }

  async clearDocument() {
    this.loadVersion += 1;
    await this.disposeTaskAndDoc();
    this.viewer.setDocument(null as never);
    this.linkService.setDocument(null as never, null);
  }

  private async disposeTaskAndDoc() {
    if (this.loadingTask) {
      await this.loadingTask.destroy();
      this.loadingTask = null;
    }

    if (this.document) {
      await this.document.destroy();
      this.document = null;
    }
  }

  updateOnResize() {
    if (!this.isVisible()) {
      return;
    }

    window.requestAnimationFrame(() => {
      const currentScaleValue = this.viewer.currentScaleValue;
      if (
        currentScaleValue === "auto" ||
        currentScaleValue === "page-fit" ||
        currentScaleValue === "page-height" ||
        currentScaleValue === "page-width"
      ) {
        this.viewer.currentScaleValue = currentScaleValue;
      }
      this.viewer.update();
    });
  }

  setScale(scale: PdfScaleValue) {
    if (typeof scale === "number") {
      this.viewer.currentScale = scale;
      return;
    }
    this.viewer.currentScaleValue = scale;
  }

  get currentScale() {
    return this.viewer.currentScale;
  }

  get currentScaleValue() {
    return this.viewer.currentScaleValue;
  }

  get currentPage() {
    return this.viewer.currentPageNumber;
  }

  get pagesCount() {
    return this.viewer.pagesCount;
  }

  scrollToPage(page: number) {
    const pagesCount = this.pagesCount;
    if (!pagesCount) {
      return;
    }

    const target = Math.max(1, Math.min(page, pagesCount));
    this.viewer.currentPageNumber = target;
    this.viewer.scrollPageIntoView({ pageNumber: target });
  }

  onPageChange(callback: (page: number) => void) {
    const handler = (event: { pageNumber: number }) => {
      callback(event.pageNumber);
    };

    this.eventBus.on("pagechanging", handler);
    return () => {
      this.eventBus.off("pagechanging", handler);
    };
  }

  onScaleChange(callback: (scale: number) => void) {
    const handler = (event: { scale: number }) => {
      callback(event.scale);
    };

    this.eventBus.on("scalechanging", handler);
    return () => {
      this.eventBus.off("scalechanging", handler);
    };
  }

  isVisible() {
    return this.container.offsetParent !== null;
  }

  async destroy() {
    await this.clearDocument();
  }
}
