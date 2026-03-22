/**
 * literature_ingest.mjs - PDF text extraction, OCR fallback, Markdown normalization, chunking.
 *
 * Called by the Tauri sidecar with:
 *   node index.mjs ingest-literature '{"literatureId":"...","pdfPath":"...","projectRoot":"..."}'
 *
 * Output: JSON to stdout with { literatureId, chunks[], markdownPath, ocrUsed, ocrStatus }
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

const CHUNK_TARGET_CHARS = 2000;
const CHUNK_OVERLAP_CHARS = 200;
const MIN_CHARS_PER_PAGE = 50;
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;

const PDFTOTEXT_BIN = resolveBinary("pdftotext", [
  "/opt/homebrew/bin/pdftotext",
  "/usr/local/bin/pdftotext",
  "/usr/bin/pdftotext",
]);
const PDFTOPPM_BIN = resolveBinary("pdftoppm", [
  "/opt/homebrew/bin/pdftoppm",
  "/usr/local/bin/pdftoppm",
  "/usr/bin/pdftoppm",
]);
const PDFINFO_BIN = resolveBinary("pdfinfo", [
  "/opt/homebrew/bin/pdfinfo",
  "/usr/local/bin/pdfinfo",
  "/usr/bin/pdfinfo",
]);
const SWIFT_BIN = resolveBinary("swift", [
  "/usr/bin/swift",
]);

const VISION_SWIFT_SOURCE = String.raw`
import AppKit
import Foundation
import Vision

let separatorIndex = CommandLine.arguments.firstIndex(of: "--") ?? CommandLine.arguments.count
let imagePaths = Array(CommandLine.arguments.dropFirst(separatorIndex + (separatorIndex < CommandLine.arguments.count ? 1 : 0)))

func recognizeImage(at path: String) -> String {
    let url = URL(fileURLWithPath: path)
    guard let image = NSImage(contentsOf: url) else { return "" }
    var rect = CGRect(origin: .zero, size: image.size)
    guard let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return "" }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if #available(macOS 13.0, *) {
        request.automaticallyDetectsLanguage = true
    }
    request.recognitionLanguages = ["zh-Hans", "en-US"]

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return ""
    }

    let observations = request.results as? [VNRecognizedTextObservation] ?? []
    return observations
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n")
}

let pageTexts = imagePaths.map { recognizeImage(at: $0) }
print(pageTexts.joined(separator: "\n\n\f\n\n"))
`;

function resolveBinary(name, candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  const result = spawnSync("which", [name], {
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER_BYTES,
  });
  if (result.status === 0) {
    const resolved = result.stdout.trim().split(/\r?\n/)[0];
    if (resolved) {
      return resolved;
    }
  }

  return name;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER_BYTES,
    ...options,
  });

  if (result.error) {
    return {
      ok: false,
      stdout: result.stdout ?? "",
      stderr: result.error.message,
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  return {
    ok: true,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function extractTextFromPdfBuffer(buffer) {
  const raw = buffer.toString("latin1");
  const textParts = [];
  const btEtRegex = /BT\s([\s\S]*?)ET/g;
  let match;

  while ((match = btEtRegex.exec(raw)) !== null) {
    const block = match[1];
    const tjRegex = /\(([^)]*)\)\s*Tj/g;
    let innerMatch;
    while ((innerMatch = tjRegex.exec(block)) !== null) {
      textParts.push(innerMatch[1]);
    }

    const tjArrayRegex = /\[([^\]]*)\]\s*TJ/g;
    while ((innerMatch = tjArrayRegex.exec(block)) !== null) {
      const pieces = innerMatch[1].match(/\(([^)]*)\)/g) || [];
      for (const piece of pieces) {
        textParts.push(piece.slice(1, -1));
      }
    }
  }

  return textParts
    .join(" ")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

function countPdfPages(pdfAbsolutePath) {
  const result = runCommand(PDFINFO_BIN, [pdfAbsolutePath]);
  if (!result.ok) {
    return 1;
  }

  const match = result.stdout.match(/^Pages:\s+(\d+)/m);
  return match ? Number.parseInt(match[1], 10) : 1;
}

function extractTextWithPdfToText(pdfAbsolutePath) {
  const result = runCommand(PDFTOTEXT_BIN, [
    "-enc",
    "UTF-8",
    "-layout",
    "-nopgbrk",
    pdfAbsolutePath,
    "-",
  ]);
  return result.ok ? result.stdout : "";
}

function isTextSufficient(text, pageCount) {
  const avgCharsPerPage = text.trim().length / Math.max(1, pageCount);
  return avgCharsPerPage >= MIN_CHARS_PER_PAGE;
}

function normalizePageText(pageText) {
  const lines = pageText.replace(/\r/g, "\n").split("\n");
  const normalized = [];
  let previousEmpty = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (!previousEmpty) {
        normalized.push("");
        previousEmpty = true;
      }
      continue;
    }

    previousEmpty = false;
    normalized.push(trimmed);
  }

  return normalized.join("\n").trim();
}

function normalizeToMarkdown(rawText, title) {
  const header = `# ${title}\n\n`;
  const pages = rawText
    .replace(/\r/g, "\n")
    .split(/\f+/)
    .map((page) => normalizePageText(page))
    .filter((page) => page.length > 0);

  if (pages.length === 0) {
    return header;
  }

  if (pages.length === 1) {
    return `${header}${pages[0]}\n`;
  }

  const body = pages
    .map((page, index) => `## Page ${index + 1}\n\n${page}`)
    .join("\n\n");
  return `${header}${body}\n`;
}

function chunkText(text) {
  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const paragraph of paragraphs) {
    if (current.length + paragraph.length + 2 > CHUNK_TARGET_CHARS && current.length > 0) {
      chunks.push(current.trim());
      const overlapStart = Math.max(0, current.length - CHUNK_OVERLAP_CHARS);
      current = `${current.slice(overlapStart).trim()}\n\n${paragraph}`;
    } else {
      current += `${current ? "\n\n" : ""}${paragraph}`;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  if (chunks.length === 0 && text.trim().length > 0) {
    let position = 0;
    while (position < text.length) {
      const end = Math.min(position + CHUNK_TARGET_CHARS, text.length);
      chunks.push(text.slice(position, end).trim());
      if (end >= text.length) {
        break;
      }
      position = Math.max(0, end - CHUNK_OVERLAP_CHARS);
    }
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function renderPdfPages(pdfAbsolutePath) {
  const tempDir = mkdtempSync(join(tmpdir(), "viewerleaf-ocr-"));
  const prefix = join(tempDir, "page");
  const result = runCommand(PDFTOPPM_BIN, [
    "-png",
    "-r",
    "220",
    pdfAbsolutePath,
    prefix,
  ]);

  if (!result.ok) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(result.stderr || "failed to render PDF pages");
  }

  const imagePaths = readdirSync(tempDir)
    .filter((name) => name.startsWith("page-") && name.endsWith(".png"))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((name) => join(tempDir, name));

  if (imagePaths.length === 0) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error("no rendered PDF pages found");
  }

  return { tempDir, imagePaths };
}

function recognizeImagesWithVision(imagePaths) {
  if (process.platform !== "darwin" || !existsSync(SWIFT_BIN)) {
    return "";
  }

  const result = runCommand(
    SWIFT_BIN,
    ["-e", VISION_SWIFT_SOURCE, "--", ...imagePaths],
    { timeout: 180_000 },
  );

  return result.ok ? result.stdout : "";
}

export async function ingestLiteraturePdf(payload) {
  const { literatureId, pdfPath, projectRoot, title } = payload;

  if (!literatureId || !pdfPath) {
    throw new Error("literatureId and pdfPath are required");
  }

  const absolutePdfPath = pdfPath.startsWith("/")
    ? pdfPath
    : resolve(projectRoot || ".", pdfPath);

  if (!existsSync(absolutePdfPath)) {
    throw new Error(`PDF not found: ${absolutePdfPath}`);
  }

  const pageCount = countPdfPages(absolutePdfPath);
  let extractedText = extractTextWithPdfToText(absolutePdfPath);
  if (!extractedText.trim()) {
    extractedText = extractTextFromPdfBuffer(readFileSync(absolutePdfPath));
  }

  let ocrUsed = false;
  if (!isTextSufficient(extractedText, pageCount)) {
    let renderedPages = null;
    try {
      renderedPages = renderPdfPages(absolutePdfPath);
      const ocrText = recognizeImagesWithVision(renderedPages.imagePaths);
      if (ocrText.trim().length > extractedText.trim().length) {
        extractedText = ocrText;
        ocrUsed = ocrText.trim().length > 0;
      }
    } finally {
      if (renderedPages) {
        rmSync(renderedPages.tempDir, { recursive: true, force: true });
      }
    }
  }

  const paperTitle =
    title ||
    basename(absolutePdfPath, extname(absolutePdfPath)).replace(/[-_]/g, " ");
  const markdown = normalizeToMarkdown(extractedText, paperTitle);

  const markdownDir = resolve(projectRoot || ".", ".viewerleaf", "literature", "markdown");
  mkdirSync(markdownDir, { recursive: true });
  const markdownFileName = `${literatureId}.md`;
  const markdownAbsolutePath = join(markdownDir, markdownFileName);
  writeFileSync(markdownAbsolutePath, markdown, "utf-8");

  const chunks = chunkText(markdown);
  const hasUsefulText = extractedText.trim().length > 0;
  const ocrStatus = ocrUsed ? "done" : hasUsefulText ? "none" : "failed";

  return {
    literatureId,
    markdownPath: `.viewerleaf/literature/markdown/${markdownFileName}`,
    chunks: chunks.map((content, index) => ({ chunkIndex: index, content })),
    ocrUsed,
    ocrStatus,
    pageCount,
    extractedChars: extractedText.trim().length,
  };
}
