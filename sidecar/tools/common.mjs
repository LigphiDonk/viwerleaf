import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  ".viewerleaf",
  ".claude",
  ".agent",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".class",
  ".jar",
  ".bin",
]);

export function toPosixPath(filePath) {
  return filePath.split(sep).join("/");
}

export function normalizeRelativePath(projectRoot, targetPath) {
  const rel = relative(projectRoot, targetPath) || ".";
  return toPosixPath(rel);
}

export function ensureInsideProject(projectRoot, targetPath) {
  const root = resolve(projectRoot);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && rel !== "..")) {
    return target;
  }
  throw new Error(`Path is outside project root: ${target}`);
}

export function resolveProjectPath(projectRoot, inputPath = ".") {
  const root = resolve(projectRoot);
  const target = resolve(root, inputPath);
  return ensureInsideProject(root, target);
}

export function resolveUserPath(projectRoot, inputPath = ".") {
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    return resolveProjectPath(projectRoot, ".");
  }
  if (inputPath.startsWith("~")) {
    throw new Error("Home-relative paths are not supported. Use a project-relative path instead.");
  }
  return inputPath.startsWith("/") ? ensureInsideProject(projectRoot, inputPath) : resolveProjectPath(projectRoot, inputPath);
}

export function ensureParentDirectory(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function pathExists(filePath) {
  return existsSync(filePath);
}

export function splitLines(content) {
  return content.split("\n");
}

export function joinLines(lines) {
  return lines.join("\n");
}

export function detectLineEnding(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

export function convertLineEnding(content, lineEnding) {
  return lineEnding === "\n" ? content.replace(/\r\n/g, "\n") : content.replace(/\r?\n/g, "\r\n");
}

export function normalizeLineEndings(content) {
  return content.replace(/\r\n/g, "\n");
}

export function isBinaryExtension(filePath) {
  return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export function isProbablyBinary(filePath) {
  if (isBinaryExtension(filePath)) {
    return true;
  }
  const sample = readFileSync(filePath);
  const limit = Math.min(sample.length, 2048);
  for (let index = 0; index < limit; index += 1) {
    if (sample[index] === 0) {
      return true;
    }
  }
  return false;
}

export function readTextFile(filePath) {
  if (isProbablyBinary(filePath)) {
    throw new Error(`Cannot read binary file: ${filePath}`);
  }
  return readFileSync(filePath, "utf8");
}

export function writeTextFile(filePath, content) {
  ensureParentDirectory(filePath);
  writeFileSync(filePath, content, "utf8");
}

export function shouldSkipEntry(name, includeHidden = false) {
  if (!includeHidden && name.startsWith(".")) {
    return true;
  }
  return DEFAULT_IGNORED_DIRS.has(name);
}

export function isIgnoredPath(relativePath, patterns = []) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }
  return patterns.some((pattern) => {
    if (typeof pattern !== "string" || !pattern.trim()) {
      return false;
    }
    const normalizedPattern = toPosixPath(pattern.trim()).replace(/\/+$/, "");
    const normalizedPath = toPosixPath(relativePath).replace(/\/+$/, "");
    return (
      matchesGlobPath(normalizedPath, normalizedPattern) ||
      matchesGlobPath(`${normalizedPath}/`, normalizedPattern) ||
      normalizedPath === normalizedPattern
    );
  });
}

export function walkDirectory(startPath, options, visitor, depth = 0) {
  const {
    includeHidden = false,
    maxDepth = Number.POSITIVE_INFINITY,
    includeDirectories = false,
    maxEntries = Number.POSITIVE_INFINITY,
    state = { count: 0, truncated: false },
  } = options || {};

  if (depth > maxDepth || state.truncated) {
    return state;
  }

  const entries = readdirSync(startPath, { withFileTypes: true }).sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) {
      return left.isDirectory() ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  for (const entry of entries) {
    if (shouldSkipEntry(entry.name, includeHidden)) {
      continue;
    }

    if (state.count >= maxEntries) {
      state.truncated = true;
      break;
    }

    const fullPath = resolve(startPath, entry.name);
    const stats = statSync(fullPath);
    const isDirectory = stats.isDirectory();

    if (includeDirectories || !isDirectory) {
      visitor({ name: entry.name, fullPath, stats, depth, isDirectory });
      state.count += 1;
    }

    if (isDirectory) {
      walkDirectory(
        fullPath,
        {
          includeHidden,
          maxDepth,
          includeDirectories,
          maxEntries,
          state,
        },
        visitor,
        depth + 1,
      );
    }
  }

  return state;
}

function escapeRegex(text) {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function findClosingBrace(pattern, startIndex) {
  for (let index = startIndex; index < pattern.length; index += 1) {
    if (pattern[index] === "}") {
      return index;
    }
  }
  return -1;
}

function globFragmentToRegex(pattern) {
  let output = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === "*") {
      const next = pattern[index + 1];
      const afterNext = pattern[index + 2];
      if (next === "*") {
        if (afterNext === "/") {
          output += "(?:.*\\/)?";
          index += 2;
        } else {
          output += ".*";
          index += 1;
        }
        continue;
      }
      output += "[^/]*";
      continue;
    }

    if (char === "?") {
      output += "[^/]";
      continue;
    }

    if (char === "{") {
      const closeIndex = findClosingBrace(pattern, index + 1);
      if (closeIndex > index) {
        const parts = pattern
          .slice(index + 1, closeIndex)
          .split(",")
          .map((part) => globFragmentToRegex(part));
        output += `(?:${parts.join("|")})`;
        index = closeIndex;
        continue;
      }
    }

    output += escapeRegex(char === "\\" ? "/" : char);
  }

  return output;
}

export function globToRegExp(pattern) {
  const normalized = toPosixPath(pattern || "");
  return new RegExp(`^${globFragmentToRegex(normalized)}$`);
}

export function matchesGlobPath(relativePath, pattern) {
  const normalizedPath = toPosixPath(relativePath);
  const normalizedPattern = toPosixPath(pattern || "");
  const regex = globToRegExp(normalizedPattern);
  if (regex.test(normalizedPath)) {
    return true;
  }
  if (!normalizedPattern.includes("/")) {
    return globToRegExp(normalizedPattern).test(basename(normalizedPath));
  }
  return false;
}

export function countOccurrences(content, searchText) {
  if (!searchText) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(searchText, offset);
    if (index === -1) {
      return count;
    }
    count += 1;
    offset = index + searchText.length;
  }
}

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
