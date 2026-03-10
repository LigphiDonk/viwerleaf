import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const readSection = {
  id: "read_section",
  description: "Read the content of a .tex file, optionally a specific line range.",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Relative path to .tex file from project root" },
      startLine: { type: "number", description: "Start line (1-based, inclusive)." },
      endLine: { type: "number", description: "End line (1-based, inclusive)." },
    },
    required: ["filePath"],
  },
  async execute(args, ctx) {
    const fullPath = resolve(ctx.projectRoot, args.filePath);
    const lines = readFileSync(fullPath, "utf-8").split("\n");
    const start = (args.startLine || 1) - 1;
    const end = args.endLine || lines.length;
    const slice = lines.slice(start, end);
    return {
      output: slice.map((line, index) => `${start + index + 1}: ${line}`).join("\n"),
      metadata: { lineCount: slice.length },
    };
  },
};
