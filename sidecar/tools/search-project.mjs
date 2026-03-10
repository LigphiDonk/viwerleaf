import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

export const searchProject = {
  id: "search_project",
  description: "Search for a keyword across all .tex and .bib files in the project.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search keyword or regex pattern" },
      fileGlob: { type: "string", description: "Optional file extension filter like .tex or .bib" },
    },
    required: ["query"],
  },
  async execute(args, ctx) {
    const matches = [];
    const pattern = new RegExp(args.query, "i");
    const allowedExts = args.fileGlob ? [args.fileGlob] : [".tex", ".bib"];

    function walk(dir) {
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory() && !entry.startsWith(".")) {
          walk(full);
          continue;
        }

        if (!allowedExts.includes(extname(entry))) {
          continue;
        }

        const content = readFileSync(full, "utf-8");
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          if (pattern.test(lines[index])) {
            matches.push({
              file: relative(ctx.projectRoot, full),
              line: index + 1,
              text: lines[index].trim(),
            });
          }
        }
      }
    }

    walk(ctx.projectRoot);
    return { output: JSON.stringify(matches.slice(0, 50), null, 2) };
  },
};
