import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const applyTextPatch = {
  id: "apply_text_patch",
  description: "Replace a range of lines in a .tex file with new content.",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Relative path to .tex file" },
      startLine: { type: "number", description: "Start line to replace (1-based, inclusive)" },
      endLine: { type: "number", description: "End line to replace (1-based, inclusive)" },
      newContent: { type: "string", description: "Replacement text (can be multiple lines)" },
    },
    required: ["filePath", "startLine", "endLine", "newContent"],
  },
  async execute(args, ctx) {
    const fullPath = resolve(ctx.projectRoot, args.filePath);
    const lines = readFileSync(fullPath, "utf-8").split("\n");
    const before = lines.slice(0, args.startLine - 1);
    const after = lines.slice(args.endLine);
    const newLines = args.newContent.split("\n");
    const result = [...before, ...newLines, ...after].join("\n");
    writeFileSync(fullPath, result, "utf-8");
    return {
      output: `Replaced lines ${args.startLine}-${args.endLine} with ${newLines.length} new lines.`,
      sideEffects: [{ type: "file_changed", filePath: args.filePath, content: result }],
    };
  },
};
