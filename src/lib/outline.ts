export type SectionCommand =
  | "part"
  | "chapter"
  | "section"
  | "subsection"
  | "subsubsection"
  | "paragraph"
  | "subparagraph";

export interface OutlineHeading {
  id: string;
  filePath: string;
  line: number;
  level: number;
  command: SectionCommand;
  title: string;
}

export interface OutlineNode {
  id: string;
  heading: OutlineHeading;
  children: OutlineNode[];
}

export interface OutlineBuildResult {
  headings: OutlineHeading[];
  tree: OutlineNode[];
  warnings: string[];
}

interface ParsedLatexFile {
  headings: OutlineHeading[];
  includes: string[];
}

const SECTION_COMMANDS: SectionCommand[] = [
  "part",
  "chapter",
  "section",
  "subsection",
  "subsubsection",
  "paragraph",
  "subparagraph",
];

const SECTION_LEVELS = new Map<SectionCommand, number>(
  SECTION_COMMANDS.map((command, index) => [command, index + 1]),
);

function stripLatexComment(line: string) {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "%" && line[index - 1] !== "\\") {
      return line.slice(0, index);
    }
  }
  return line;
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizePath(path: string) {
  const parts = path.replace(/\\/g, "/").split("/");
  const normalized: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }

  return normalized.join("/");
}

function dirname(path: string) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : "";
}

function joinPath(baseDir: string, target: string) {
  return normalizePath(baseDir ? `${baseDir}/${target}` : target);
}

export function resolveIncludePath(parentPath: string, includeTarget: string) {
  const trimmed = normalizeWhitespace(includeTarget);
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.endsWith(".tex") ? trimmed : `${trimmed}.tex`;
  return joinPath(dirname(parentPath), normalized);
}

export function parseLatexStructure(filePath: string, content: string): ParsedLatexFile {
  const headings: OutlineHeading[] = [];
  const includes: string[] = [];
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripLatexComment(lines[index]);
    const headingMatch = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*)?\s*\{([^}]*)\}/g.exec(line);
    if (headingMatch) {
      const command = headingMatch[1] as SectionCommand;
      const title = normalizeWhitespace(headingMatch[3]);
      headings.push({
        id: `${filePath}:${lineNumber}:${command}:${title}`,
        filePath,
        line: lineNumber,
        level: SECTION_LEVELS.get(command) ?? SECTION_COMMANDS.length,
        command,
        title: title || command,
      });
    }

      const includePattern = /\\(input|include)\s*\{([^}]+)\}/g;
      let includeMatch = includePattern.exec(line);
      while (includeMatch) {
        const includeTarget = normalizeWhitespace(includeMatch[2]);
        if (includeTarget) {
          includes.push(includeTarget);
        }
      includeMatch = includePattern.exec(line);
    }
  }

  return { headings, includes };
}

export function buildOutlineTree(headings: OutlineHeading[]) {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];

  for (const heading of headings) {
    const node: OutlineNode = {
      id: heading.id,
      heading,
      children: [],
    };

    while (stack.length && stack[stack.length - 1].heading.level >= heading.level) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }

    stack.push(node);
  }

  return roots;
}

export async function buildProjectOutline(
  mainTexPath: string,
  readFile: (path: string) => Promise<string>,
): Promise<OutlineBuildResult> {
  const headings: OutlineHeading[] = [];
  const warnings: string[] = [];
  const visited = new Set<string>();
  const rootDir = dirname(mainTexPath);

  function includeCandidates(parentPath: string, includeTarget: string) {
    const normalized = includeTarget.endsWith(".tex") ? includeTarget : `${includeTarget}.tex`;
    const candidates = includeTarget.startsWith(".")
      ? [joinPath(dirname(parentPath), normalized), joinPath(rootDir, normalized)]
      : [joinPath(rootDir, normalized), joinPath(dirname(parentPath), normalized)];

    return Array.from(new Set(candidates.filter(Boolean)));
  }

  async function visit(path: string, options?: { silent?: boolean }) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath || visited.has(normalizedPath)) {
      return true;
    }

    let content: string;
    try {
      content = await readFile(normalizedPath);
    } catch (error) {
      if (!options?.silent) {
        warnings.push(
          `Unable to read included file "${normalizedPath}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return false;
    }
    visited.add(normalizedPath);

    const parsed = parseLatexStructure(normalizedPath, content);
    headings.push(...parsed.headings);

    for (const includeTarget of parsed.includes) {
      let resolved = false;
      for (const candidate of includeCandidates(normalizedPath, includeTarget)) {
        if (await visit(candidate, { silent: true })) {
          resolved = true;
          break;
        }
      }

      if (!resolved) {
        warnings.push(`Unable to read included file "${includeTarget}" from "${normalizedPath}"`);
      }
    }

    return true;
  }

  await visit(mainTexPath);

  return {
    headings,
    tree: buildOutlineTree(headings),
    warnings,
  };
}

export function findActiveHeading(
  headings: OutlineHeading[],
  filePath: string,
  line: number,
) {
  let active: OutlineHeading | null = null;

  for (const heading of headings) {
    if (heading.filePath !== filePath) {
      continue;
    }
    if (heading.line > line) {
      break;
    }
    active = heading;
  }

  return active;
}

export function buildFoldRanges(filePath: string, content: string) {
  const parsed = parseLatexStructure(filePath, content);
  const lines = content.split("\n");

  return parsed.headings
    .map((heading, index) => {
      const nextHeading = parsed.headings
        .slice(index + 1)
        .find((candidate) => candidate.level <= heading.level);
      const endLine = (nextHeading?.line ?? lines.length + 1) - 1;
      if (endLine <= heading.line) {
        return null;
      }

      return {
        heading,
        fromLine: heading.line,
        toLine: endLine,
      };
    })
    .filter((item): item is { heading: OutlineHeading; fromLine: number; toLine: number } => Boolean(item));
}
