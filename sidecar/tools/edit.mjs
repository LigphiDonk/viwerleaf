import { statSync } from "node:fs";

import {
  convertLineEnding,
  countOccurrences,
  detectLineEnding,
  normalizeLineEndings,
  normalizeRelativePath,
  pathExists,
  readTextFile,
  resolveUserPath,
  writeTextFile,
} from "./common.mjs";

function normalizeForFile(content, lineEnding) {
  return convertLineEnding(normalizeLineEndings(String(content ?? "")), lineEnding);
}

export const editTool = {
  id: "edit",
  description: "Replace text inside an existing text file. Use write for full-file creation or overwrite.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Relative or absolute path to the target file inside the project.",
      },
      oldString: {
        type: "string",
        description: "Exact text to replace. Use an empty string only when creating a brand-new file.",
      },
      newString: {
        type: "string",
        description: "Replacement text.",
      },
      replaceAll: {
        type: "boolean",
        description: "Replace all occurrences of oldString. Defaults to false.",
      },
    },
    required: ["filePath", "oldString", "newString"],
  },
  async execute(args, ctx) {
    const filePath = resolveUserPath(ctx.projectRoot, args.filePath);
    const exists = pathExists(filePath);
    if (exists) {
      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        throw new Error(`Cannot edit directory: ${args.filePath}`);
      }
    }

    const currentContent = exists ? readTextFile(filePath) : "";
    const lineEnding = detectLineEnding(currentContent);
    const oldString = normalizeForFile(args.oldString, lineEnding);
    const newString = normalizeForFile(args.newString, lineEnding);

    if (oldString === newString) {
      throw new Error("oldString and newString are identical");
    }

    let nextContent = currentContent;
    let replacedCount = 0;

    if (!exists && oldString !== "") {
      throw new Error(`File not found: ${args.filePath}`);
    }

    if (oldString === "") {
      if (exists && currentContent.length > 0) {
        throw new Error("oldString cannot be empty when editing an existing non-empty file");
      }
      nextContent = newString;
      replacedCount = 1;
    } else {
      replacedCount = countOccurrences(currentContent, oldString);
      if (replacedCount === 0) {
        throw new Error("oldString was not found in the target file");
      }
      if (!args.replaceAll && replacedCount > 1) {
        throw new Error(`oldString matched ${replacedCount} times. Use replaceAll=true or provide a more specific oldString.`);
      }

      nextContent = args.replaceAll
        ? currentContent.split(oldString).join(newString)
        : currentContent.replace(oldString, newString);
      replacedCount = args.replaceAll ? replacedCount : 1;
    }

    writeTextFile(filePath, nextContent);
    const relativePath = normalizeRelativePath(ctx.projectRoot, filePath);

    return {
      output: `Updated ${relativePath} (${replacedCount} replacement${replacedCount === 1 ? "" : "s"})`,
      metadata: {
        path: relativePath,
        replacements: replacedCount,
      },
      sideEffects: [
        {
          type: "file_changed",
          filePath: relativePath,
          content: nextContent,
        },
      ],
    };
  },
};
