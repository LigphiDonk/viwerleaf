import {
  escapeRegExp,
  normalizeLineEndings,
  normalizeRelativePath,
  pathExists,
  readTextFile,
  resolveUserPath,
  walkDirectory,
  matchesGlobPath,
} from "./common.mjs";

const MAX_MATCHES = 100;

function buildMatcher(pattern, caseSensitive) {
  const flags = caseSensitive ? "" : "i";
  try {
    return new RegExp(pattern, flags);
  } catch {
    return new RegExp(escapeRegExp(pattern), flags);
  }
}

export const grepTool = {
  id: "grep",
  description: "Search file contents by regex or keyword across the workspace.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern or plain text keyword to search for.",
      },
      path: {
        type: "string",
        description: "Optional relative or absolute directory path to search from. Defaults to the project root.",
      },
      include: {
        type: "string",
        description: 'Optional glob filter like "*.tex" or "*.{tex,bib}".',
      },
      caseSensitive: {
        type: "boolean",
        description: "Whether the search should be case-sensitive. Defaults to false.",
      },
    },
    required: ["pattern"],
  },
  async execute(args, ctx) {
    const pattern = String(args.pattern || "").trim();
    if (!pattern) {
      throw new Error("pattern is required");
    }

    const matcher = buildMatcher(pattern, Boolean(args.caseSensitive));
    const searchPath = resolveUserPath(ctx.projectRoot, args.path || ".");
    if (!pathExists(searchPath)) {
      throw new Error(`Path not found: ${searchPath}`);
    }

    const matches = [];
    walkDirectory(
      searchPath,
      {
        includeHidden: false,
        maxDepth: Number.POSITIVE_INFINITY,
        maxEntries: 2000,
      },
      (entry) => {
        if (matches.length >= MAX_MATCHES) {
          return;
        }

        const relativeToSearchRoot = normalizeRelativePath(searchPath, entry.fullPath);
        if (args.include && !matchesGlobPath(relativeToSearchRoot, args.include)) {
          return;
        }

        const relativeToProject = normalizeRelativePath(ctx.projectRoot, entry.fullPath);
        let lines;
        try {
          lines = normalizeLineEndings(readTextFile(entry.fullPath)).split("\n");
        } catch {
          return;
        }
        for (let index = 0; index < lines.length; index += 1) {
          matcher.lastIndex = 0;
          if (!matcher.test(lines[index])) {
            continue;
          }
          matches.push(`${relativeToProject}:${index + 1}: ${lines[index]}`);
          if (matches.length >= MAX_MATCHES) {
            return;
          }
        }
      },
    );

    if (matches.length === 0) {
      return {
        output: "No matches found",
        metadata: {
          count: 0,
          truncated: false,
        },
      };
    }

    const lines = [`Found ${matches.length}${matches.length >= MAX_MATCHES ? "+" : ""} matches`, ...matches];
    if (matches.length >= MAX_MATCHES) {
      lines.push(`(Results truncated to ${MAX_MATCHES} matches)`);
    }

    return {
      output: lines.join("\n"),
      metadata: {
        count: matches.length,
        truncated: matches.length >= MAX_MATCHES,
      },
    };
  },
};
