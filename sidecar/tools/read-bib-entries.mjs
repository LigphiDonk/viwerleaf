import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export const readBibEntries = {
  id: "read_bib_entries",
  description: "Read bibliography entries from .bib files. Optionally filter by keyword.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Optional keyword to filter entries" },
    },
  },
  async execute(args, ctx) {
    const entries = [];
    const entryPattern = /@(\w+)\{([^,]+),\s*([\s\S]*?)(?=\n@|\n*$)/g;

    function scanBib(fullPath) {
      const content = readFileSync(fullPath, "utf-8");
      let match;
      while ((match = entryPattern.exec(content)) !== null) {
        const type = match[1];
        const key = match[2].trim();
        const body = match[3];
        const title = body.match(/title\s*=\s*\{([^}]+)\}/i)?.[1] || "";
        const author = body.match(/author\s*=\s*\{([^}]+)\}/i)?.[1] || "";
        const year = body.match(/year\s*=\s*\{?(\d{4})\}?/i)?.[1] || "";

        if (
          !args.query ||
          [key, title, author].some((field) =>
            field.toLowerCase().includes(String(args.query).toLowerCase()),
          )
        ) {
          entries.push({ key, type, title, author, year, file: relative(ctx.projectRoot, fullPath) });
        }
      }
    }

    function walk(dir) {
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory() && !entry.startsWith(".")) {
          walk(full);
        } else if (entry.endsWith(".bib")) {
          scanBib(full);
        }
      }
    }

    walk(ctx.projectRoot);
    return { output: JSON.stringify(entries, null, 2) };
  },
};
