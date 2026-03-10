import { applyTextPatch } from "./apply-text-patch.mjs";
import { insertAtLine } from "./insert-at-line.mjs";
import { listSections } from "./list-sections.mjs";
import { readBibEntries } from "./read-bib-entries.mjs";
import { readSection } from "./read-section.mjs";
import { searchProject } from "./search-project.mjs";

const ALL_TOOLS = [
  readSection,
  applyTextPatch,
  searchProject,
  insertAtLine,
  listSections,
  readBibEntries,
];

const TOOL_MAP = Object.fromEntries(ALL_TOOLS.map((tool) => [tool.id, tool]));

export function getTools(toolIds) {
  return toolIds.map((id) => TOOL_MAP[id]).filter(Boolean);
}

export function getAllTools() {
  return ALL_TOOLS;
}
