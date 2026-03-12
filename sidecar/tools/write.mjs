import { statSync } from "node:fs";

import {
  normalizeRelativePath,
  pathExists,
  readTextFile,
  resolveUserPath,
  writeTextFile,
} from "./common.mjs";

export const writeTool = {
  id: "write",
  description: "Create or overwrite a text file inside the workspace.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Relative or absolute path to the target file inside the project.",
      },
      content: {
        type: "string",
        description: "Full file content to write.",
      },
    },
    required: ["filePath", "content"],
  },
  async execute(args, ctx) {
    const filePath = resolveUserPath(ctx.projectRoot, args.filePath);
    if (pathExists(filePath)) {
      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        throw new Error(`Cannot write to directory: ${args.filePath}`);
      }
      readTextFile(filePath);
    }

    writeTextFile(filePath, String(args.content ?? ""));
    const relativePath = normalizeRelativePath(ctx.projectRoot, filePath);

    return {
      output: `Wrote file ${relativePath}`,
      metadata: {
        path: relativePath,
      },
      sideEffects: [
        {
          type: "file_changed",
          filePath: relativePath,
          content: String(args.content ?? ""),
        },
      ],
    };
  },
};
