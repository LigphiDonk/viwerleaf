import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

import {
  ensureParentDirectory,
  normalizeLineEndings,
  normalizeRelativePath,
  pathExists,
  resolveUserPath,
} from "./common.mjs";

function parsePatchText(patchText) {
  const lines = normalizeLineEndings(String(patchText ?? "")).split("\n");
  if (lines[0] !== "*** Begin Patch") {
    throw new Error("Patch must start with *** Begin Patch");
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines[lines.length - 1] !== "*** End Patch") {
    throw new Error("Patch must end with *** End Patch");
  }

  const actions = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index];
    if (!line) {
      index += 1;
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      const filePath = line.slice("*** Add File: ".length).trim();
      index += 1;
      const contentLines = [];
      while (index < lines.length - 1 && !lines[index].startsWith("*** ")) {
        if (!lines[index].startsWith("+")) {
          throw new Error(`Invalid add-file line: ${lines[index]}`);
        }
        contentLines.push(lines[index].slice(1));
        index += 1;
      }
      actions.push({ type: "add", filePath, content: contentLines.join("\n") });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      actions.push({
        type: "delete",
        filePath: line.slice("*** Delete File: ".length).trim(),
      });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const filePath = line.slice("*** Update File: ".length).trim();
      index += 1;
      let moveTo = null;
      if (lines[index]?.startsWith("*** Move to: ")) {
        moveTo = lines[index].slice("*** Move to: ".length).trim();
        index += 1;
      }

      const patchLines = [];
      while (index < lines.length - 1 && !lines[index].startsWith("*** ")) {
        patchLines.push(lines[index]);
        index += 1;
      }
      actions.push({ type: "update", filePath, moveTo, patchLines });
      continue;
    }

    throw new Error(`Unexpected patch directive: ${line}`);
  }

  if (actions.length === 0) {
    throw new Error("Patch is empty");
  }

  return actions;
}

function parseUpdateBlocks(patchLines) {
  const blocks = [];
  let current = [];
  for (const line of patchLines) {
    if (!line) {
      throw new Error("Patch update lines cannot be empty. Prefix blank lines with a single marker character.");
    }
    if (line.startsWith("@@")) {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
      continue;
    }
    if (line === "\\ No newline at end of file") {
      continue;
    }
    const marker = line[0];
    if (![" ", "+", "-"].includes(marker)) {
      throw new Error(`Invalid patch line: ${line}`);
    }
    current.push({ marker, text: line.slice(1) });
  }
  if (current.length > 0) {
    blocks.push(current);
  }
  if (blocks.length === 0) {
    throw new Error("Update patch has no hunks");
  }
  return blocks;
}

function findBlock(lines, searchLines, startIndex) {
  if (searchLines.length === 0) {
    return { start: startIndex, end: startIndex };
  }

  for (let index = startIndex; index <= lines.length - searchLines.length; index += 1) {
    let matches = true;
    for (let inner = 0; inner < searchLines.length; inner += 1) {
      if (lines[index + inner] !== searchLines[inner]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return { start: index, end: index + searchLines.length };
    }
  }

  for (let index = startIndex; index <= lines.length - searchLines.length; index += 1) {
    let matches = true;
    for (let inner = 0; inner < searchLines.length; inner += 1) {
      if (lines[index + inner].trim() !== searchLines[inner].trim()) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return { start: index, end: index + searchLines.length };
    }
  }

  return null;
}

function applyUpdatePatch(originalContent, patchLines) {
  const originalLines = normalizeLineEndings(originalContent).split("\n");
  const blocks = parseUpdateBlocks(patchLines);
  const output = [];
  let cursor = 0;

  for (const block of blocks) {
    const searchLines = [];
    const replacementLines = [];

    for (const line of block) {
      if (line.marker !== "+") {
        searchLines.push(line.text);
      }
      if (line.marker !== "-") {
        replacementLines.push(line.text);
      }
    }

    const match = findBlock(originalLines, searchLines, cursor) ?? findBlock(originalLines, searchLines, 0);
    if (!match) {
      throw new Error("Could not match update hunk against file content");
    }

    output.push(...originalLines.slice(cursor, match.start));
    output.push(...replacementLines);
    cursor = match.end;
  }

  output.push(...originalLines.slice(cursor));
  return output.join("\n");
}

export const applyPatchTool = {
  id: "apply_patch",
  description: "Apply a structured multi-file patch using the same Begin/End Patch format as Codex-style tools.",
  parameters: {
    type: "object",
    properties: {
      patchText: {
        type: "string",
        description: "Full patch text in Begin Patch / End Patch format.",
      },
    },
    required: ["patchText"],
  },
  async execute(args, ctx) {
    const actions = parsePatchText(args.patchText);
    const sideEffects = [];
    const summary = [];

    for (const action of actions) {
      if (action.type === "add") {
        const filePath = resolveUserPath(ctx.projectRoot, action.filePath);
        if (pathExists(filePath)) {
          throw new Error(`File already exists: ${action.filePath}`);
        }
        ensureParentDirectory(filePath);
        writeFileSync(filePath, action.content, "utf8");
        const relativePath = normalizeRelativePath(ctx.projectRoot, filePath);
        summary.push(`A ${relativePath}`);
        sideEffects.push({
          type: "file_changed",
          filePath: relativePath,
          content: action.content,
        });
        continue;
      }

      if (action.type === "delete") {
        const filePath = resolveUserPath(ctx.projectRoot, action.filePath);
        if (!pathExists(filePath)) {
          throw new Error(`File not found: ${action.filePath}`);
        }
        unlinkSync(filePath);
        summary.push(`D ${normalizeRelativePath(ctx.projectRoot, filePath)}`);
        continue;
      }

      const sourcePath = resolveUserPath(ctx.projectRoot, action.filePath);
      if (!pathExists(sourcePath)) {
        throw new Error(`File not found: ${action.filePath}`);
      }

      const originalContent = readFileSync(sourcePath, "utf8");
      const updatedContent = applyUpdatePatch(originalContent, action.patchLines);
      const targetPath = action.moveTo ? resolveUserPath(ctx.projectRoot, action.moveTo) : sourcePath;
      ensureParentDirectory(targetPath);
      writeFileSync(targetPath, updatedContent, "utf8");
      if (action.moveTo && targetPath !== sourcePath) {
        unlinkSync(sourcePath);
      }

      const relativePath = normalizeRelativePath(ctx.projectRoot, targetPath);
      summary.push(`${action.moveTo ? "R" : "M"} ${relativePath}`);
      sideEffects.push({
        type: "file_changed",
        filePath: relativePath,
        content: updatedContent,
      });
    }

    return {
      output: `Applied patch:\n${summary.join("\n")}`,
      metadata: {
        files: summary.length,
      },
      sideEffects,
    };
  },
};
