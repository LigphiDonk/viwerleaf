import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const insertAtLine = {
  id: "insert_at_line",
  description: "Insert new content at a specific line in a .tex file.",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Relative path to .tex file" },
      line: { type: "number", description: "Line number to insert before (1-based)" },
      content: { type: "string", description: "Content to insert" },
    },
    required: ["filePath", "line", "content"],
  },
  async execute(args, ctx) {
    const fullPath = resolve(ctx.projectRoot, args.filePath);
    const lines = readFileSync(fullPath, "utf-8").split("\n");
    const newLines = args.content.split("\n");
    lines.splice(args.line - 1, 0, ...newLines);
    const result = lines.join("\n");
    writeFileSync(fullPath, result, "utf-8");
    return {
      output: `Inserted ${newLines.length} lines at line ${args.line}.`,
      sideEffects: [{ type: "file_changed", filePath: args.filePath, content: result }],
    };
  },
};
