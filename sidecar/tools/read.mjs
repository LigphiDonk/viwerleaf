import { readdirSync, statSync } from "node:fs";

import {
  normalizeLineEndings,
  normalizeRelativePath,
  readTextFile,
  resolveUserPath,
} from "./common.mjs";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;

function clampLimit(value) {
  const parsed = Number.isFinite(value) ? Number(value) : DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, parsed));
}

function clampOffset(value) {
  const parsed = Number.isFinite(value) ? Number(value) : 1;
  return Math.max(1, parsed);
}

function sortEntries(left, right) {
  if (left.isDirectory() !== right.isDirectory()) {
    return left.isDirectory() ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

export const readTool = {
  id: "read",
  description: "Read a file or directory inside the workspace. Supports line ranges for files.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Relative or absolute path to a file or directory inside the project.",
      },
      offset: {
        type: "number",
        description: "Optional 1-based line offset for files or entry offset for directories. Defaults to 1.",
      },
      limit: {
        type: "number",
        description: "Optional maximum number of lines or entries to read. Defaults to 200.",
      },
    },
    required: ["filePath"],
  },
  async execute(args, ctx) {
    const targetPath = resolveUserPath(ctx.projectRoot, args.filePath);
    const stats = statSync(targetPath);
    const offset = clampOffset(args.offset);
    const limit = clampLimit(args.limit);
    const relativePath = normalizeRelativePath(ctx.projectRoot, targetPath);

    if (stats.isDirectory()) {
      const entries = readdirSync(targetPath, { withFileTypes: true })
        .sort(sortEntries)
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
      const start = offset - 1;
      if (start >= entries.length && !(entries.length === 0 && offset === 1)) {
        throw new Error(`Offset ${offset} is out of range for directory ${relativePath}`);
      }
      const slice = entries.slice(start, start + limit);
      const truncated = start + slice.length < entries.length;
      const output = [
        `Directory: ${relativePath}`,
        ...slice.map((entry, index) => `${offset + index}: ${entry}`),
        truncated
          ? `(Showing ${slice.length} of ${entries.length} entries. Use offset=${offset + slice.length} to continue.)`
          : `(Total ${entries.length} entries)`,
      ];
      return {
        output: output.join("\n"),
        metadata: {
          kind: "directory",
          count: slice.length,
          truncated,
          path: relativePath,
        },
      };
    }

    const normalized = normalizeLineEndings(readTextFile(targetPath));
    const lines = normalized.length === 0 ? [] : normalized.split("\n");
    const start = offset - 1;
    if (start >= lines.length && !(lines.length === 0 && offset === 1)) {
      throw new Error(`Offset ${offset} is out of range for file ${relativePath}`);
    }

    const slice = lines.slice(start, start + limit);
    const truncated = start + slice.length < lines.length;
    const output = [
      `File: ${relativePath}`,
      ...slice.map((line, index) => `${offset + index}: ${line}`),
      truncated
        ? `(Showing lines ${offset}-${offset + slice.length - 1} of ${lines.length}. Use offset=${offset + slice.length} to continue.)`
        : `(End of file - total ${lines.length} lines)`,
    ];

    return {
      output: output.join("\n"),
      metadata: {
        kind: "file",
        count: slice.length,
        truncated,
        path: relativePath,
      },
    };
  },
};
