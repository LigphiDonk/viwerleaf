import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export const listSections = {
  id: "list_sections",
  description: "List all section, subsection, and subsubsection headings in the project.",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Optional: limit to a specific .tex file" },
    },
  },
  async execute(args, ctx) {
    const sectionPattern = /\\(section|subsection|subsubsection)\{([^}]+)\}/g;
    const sections = [];

    function scanFile(fullPath) {
      const content = readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        sectionPattern.lastIndex = 0;
        let match;
        while ((match = sectionPattern.exec(lines[index])) !== null) {
          sections.push({
            level: match[1] === "section" ? 1 : match[1] === "subsection" ? 2 : 3,
            title: match[2],
            file: relative(ctx.projectRoot, fullPath),
            line: index + 1,
          });
        }
      }
    }

    if (args.filePath) {
      scanFile(resolve(ctx.projectRoot, args.filePath));
    } else {
      function walk(dir) {
        for (const entry of readdirSync(dir)) {
          const full = resolve(dir, entry);
          if (statSync(full).isDirectory() && !entry.startsWith(".")) {
            walk(full);
          } else if (entry.endsWith(".tex")) {
            scanFile(full);
          }
        }
      }
      walk(ctx.projectRoot);
    }

    return { output: JSON.stringify(sections, null, 2) };
  },
};
