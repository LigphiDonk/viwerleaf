import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

function clampDepth(value) {
  const parsed = Number.isFinite(value) ? Number(value) : 2;
  return Math.max(1, Math.min(6, parsed));
}

export const listFiles = {
  id: "list_files",
  description:
    "List files and folders in the project. Use this first when you need to inspect project structure before reading content.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Optional relative path to inspect from project root. Defaults to the project root.",
      },
      depth: {
        type: "number",
        description: "Optional max folder depth to expand. Defaults to 2.",
      },
      includeHidden: {
        type: "boolean",
        description: "Whether to include hidden files and folders. Defaults to false.",
      },
    },
  },
  async execute(args, ctx) {
    const rootPath = resolve(ctx.projectRoot, args.path || ".");
    const maxDepth = clampDepth(args.depth);
    const includeHidden = Boolean(args.includeHidden);
    const lines = [];
    let totalEntries = 0;
    const maxEntries = 250;

    function walk(currentPath, level) {
      if (totalEntries >= maxEntries || level > maxDepth) {
        return;
      }

      const entries = readdirSync(currentPath, { withFileTypes: true }).sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      for (const entry of entries) {
        if (!includeHidden && entry.name.startsWith(".")) {
          continue;
        }
        if (totalEntries >= maxEntries) {
          break;
        }

        const fullPath = join(currentPath, entry.name);
        const relPath = relative(ctx.projectRoot, fullPath) || ".";
        const indent = "  ".repeat(level);
        const kind = entry.isDirectory() ? "dir" : "file";
        lines.push(`${indent}- ${entry.name} [${kind}] ${relPath}`);
        totalEntries += 1;

        if (entry.isDirectory()) {
          walk(fullPath, level + 1);
        }
      }
    }

    const stat = statSync(rootPath);
    if (stat.isDirectory()) {
      const relRoot = relative(ctx.projectRoot, rootPath) || ".";
      lines.push(`${relRoot}/`);
      walk(rootPath, 0);
    } else {
      const relPath = relative(ctx.projectRoot, rootPath) || ".";
      lines.push(`- ${relPath} [file] ${relPath}`);
    }

    if (totalEntries >= maxEntries) {
      lines.push(`... truncated after ${maxEntries} entries`);
    }

    return {
      output: lines.join("\n"),
      metadata: {
        entryCount: totalEntries,
        truncated: totalEntries >= maxEntries,
      },
    };
  },
};
