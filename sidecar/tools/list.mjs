import { readdirSync, statSync } from "node:fs";

import { isIgnoredPath, normalizeRelativePath, resolveUserPath, shouldSkipEntry } from "./common.mjs";

const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 8;
const DEFAULT_MAX_ENTRIES = 200;
const MAX_MAX_ENTRIES = 500;

function clampDepth(value) {
  const parsed = Number.isFinite(value) ? Number(value) : DEFAULT_DEPTH;
  return Math.max(1, Math.min(MAX_DEPTH, parsed));
}

function clampMaxEntries(value) {
  const parsed = Number.isFinite(value) ? Number(value) : DEFAULT_MAX_ENTRIES;
  return Math.max(20, Math.min(MAX_MAX_ENTRIES, parsed));
}

function sortEntries(left, right) {
  if (left.isDirectory() !== right.isDirectory()) {
    return left.isDirectory() ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function shouldIgnore(relativePath, ignorePatterns) {
  return isIgnoredPath(relativePath, ignorePatterns);
}

export const listTool = {
  id: "list",
  description: "List files and folders under the workspace. Use this first to understand project structure.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Optional relative or absolute path inside the project. Defaults to the project root.",
      },
      depth: {
        type: "number",
        description: "Optional maximum directory depth to expand. Defaults to 3.",
      },
      includeHidden: {
        type: "boolean",
        description: "Whether to include hidden files and folders. Defaults to false.",
      },
      ignore: {
        type: "array",
        items: { type: "string" },
        description: "Optional glob patterns to ignore while listing files.",
      },
      maxEntries: {
        type: "number",
        description: "Optional maximum number of rendered entries. Defaults to 200.",
      },
    },
  },
  async execute(args, ctx) {
    const targetPath = resolveUserPath(ctx.projectRoot, args.path || ".");
    const stats = statSync(targetPath);
    if (!stats.isDirectory()) {
      throw new Error("list only supports directories. Use read for files.");
    }

    const maxDepth = clampDepth(args.depth);
    const maxEntries = clampMaxEntries(args.maxEntries);
    const includeHidden = Boolean(args.includeHidden);
    const ignorePatterns = Array.isArray(args.ignore) ? args.ignore : [];
    const rootLabel = normalizeRelativePath(ctx.projectRoot, targetPath);
    const lines = [`${rootLabel === "." ? "." : rootLabel}/`];
    const state = { count: 0, truncated: false };

    function walk(currentPath, level) {
      if (state.truncated || level > maxDepth) {
        return;
      }

      const entries = readdirSync(currentPath, { withFileTypes: true }).sort(sortEntries);
      for (const entry of entries) {
        if (shouldSkipEntry(entry.name, includeHidden)) {
          continue;
        }

        const fullPath = resolveUserPath(currentPath, entry.name);
        const relativePath = normalizeRelativePath(ctx.projectRoot, fullPath);
        if (shouldIgnore(relativePath, ignorePatterns)) {
          continue;
        }

        if (state.count >= maxEntries) {
          state.truncated = true;
          return;
        }

        const indent = "  ".repeat(level + 1);
        const suffix = entry.isDirectory() ? "/" : "";
        lines.push(`${indent}${entry.name}${suffix}`);
        state.count += 1;

        if (entry.isDirectory() && level + 1 < maxDepth) {
          walk(fullPath, level + 1);
        }
      }
    }

    walk(targetPath, 0);

    if (state.truncated) {
      lines.push(`... truncated after ${maxEntries} entries`);
    }

    return {
      output: lines.join("\n"),
      metadata: {
        count: state.count,
        truncated: state.truncated,
        path: rootLabel,
      },
    };
  },
};
