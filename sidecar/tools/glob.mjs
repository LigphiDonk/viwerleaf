import { normalizeRelativePath, resolveUserPath, walkDirectory, matchesGlobPath } from "./common.mjs";

const MAX_RESULTS = 200;

export const globTool = {
  id: "glob",
  description: "Find files by glob pattern inside the workspace.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Glob pattern such as "*.tex", "**/*.bib", or "chapters/*.tex".',
      },
      path: {
        type: "string",
        description: "Optional relative or absolute directory path to search from. Defaults to the project root.",
      },
      includeHidden: {
        type: "boolean",
        description: "Whether to include hidden files and directories. Defaults to false.",
      },
    },
    required: ["pattern"],
  },
  async execute(args, ctx) {
    const pattern = String(args.pattern || "").trim();
    if (!pattern) {
      throw new Error("pattern is required");
    }

    const searchPath = resolveUserPath(ctx.projectRoot, args.path || ".");
    const includeHidden = Boolean(args.includeHidden);
    const matches = [];
    const state = { count: 0, truncated: false };

    walkDirectory(
      searchPath,
      {
        includeHidden,
        maxDepth: Number.POSITIVE_INFINITY,
        maxEntries: 5000,
        state,
      },
      (entry) => {
        const searchRelativePath = normalizeRelativePath(searchPath, entry.fullPath);
        if (!matchesGlobPath(searchRelativePath, pattern)) {
          return;
        }
        matches.push(normalizeRelativePath(ctx.projectRoot, entry.fullPath));
      },
    );

    const truncated = matches.length > MAX_RESULTS || state.truncated;
    const outputMatches = truncated ? matches.slice(0, MAX_RESULTS) : matches;
    if (outputMatches.length === 0) {
      return {
        output: "No files found",
        metadata: {
          count: 0,
          truncated: false,
        },
      };
    }

    const lines = [...outputMatches];
    if (truncated) {
      lines.push(`(Results truncated to ${MAX_RESULTS} files)`);
    }

    return {
      output: lines.join("\n"),
      metadata: {
        count: matches.length,
        truncated,
      },
    };
  },
};
