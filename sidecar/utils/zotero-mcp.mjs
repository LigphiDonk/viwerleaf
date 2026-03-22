import { McpStdioClient } from "./mcp-stdio-client.mjs";
import { buildEffectiveMcpServers } from "./mcp-config.mjs";

function selectZoteroServer(mcpServers) {
  if (mcpServers.zotero) {
    return mcpServers.zotero;
  }

  const first = Object.values(mcpServers)[0];
  if (!first) {
    throw new Error("zotero-mcp is not configured or installed");
  }
  return first;
}

function findTool(tools, preferredName) {
  return tools.find((tool) => tool.name === preferredName) || null;
}

function buildArgsFromSchema(tool, patch) {
  const schema = tool?.inputSchema;
  const properties = schema?.properties && typeof schema.properties === "object"
    ? schema.properties
    : {};
  const result = {};

  for (const [canonical, value] of Object.entries(patch)) {
    if (value == null || value === "") {
      continue;
    }

    const aliases = {
      query: ["query", "q", "text", "keyword", "keywords", "search", "searchText"],
      limit: ["limit", "maxResults", "max_results", "n", "count"],
      itemKey: ["itemKey", "item_key", "key", "id", "itemId", "item_id"],
      libraryId: ["libraryId", "library_id"],
    }[canonical] || [canonical];

    const resolvedKey = aliases.find((alias) => alias in properties) || aliases[0];
    result[resolvedKey] = value;
  }

  return result;
}

function parseJsonText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractPayload(result) {
  if (result?.structuredContent != null) {
    return result.structuredContent;
  }
  if (result?.structured_content != null) {
    return result.structured_content;
  }

  const content = Array.isArray(result?.content) ? result.content : [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      const parsed = parseJsonText(block.text);
      if (parsed != null) {
        return parsed;
      }
    }
  }

  const textBlocks = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean);

  if (textBlocks.length === 1) {
    return textBlocks[0];
  }
  if (textBlocks.length > 1) {
    return textBlocks;
  }

  return result ?? null;
}

function asArray(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }
  if (Array.isArray(payload?.results)) {
    return payload.results;
  }
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }
  return [];
}

function parseAuthors(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }
        if (!entry || typeof entry !== "object") {
          return "";
        }
        if (typeof entry.name === "string") {
          return entry.name.trim();
        }
        const first = typeof entry.firstName === "string" ? entry.firstName.trim() : "";
        const last = typeof entry.lastName === "string" ? entry.lastName.trim() : "";
        return [first, last].filter(Boolean).join(" ").trim();
      })
      .filter(Boolean);
  }
  return [];
}

function parseYear(rawYear, fallbackDate) {
  if (typeof rawYear === "number" && Number.isFinite(rawYear)) {
    return rawYear;
  }
  if (typeof rawYear === "string") {
    const match = rawYear.match(/\b(19|20)\d{2}\b/);
    if (match) {
      return Number.parseInt(match[0], 10);
    }
  }
  if (typeof fallbackDate === "string") {
    const match = fallbackDate.match(/\b(19|20)\d{2}\b/);
    if (match) {
      return Number.parseInt(match[0], 10);
    }
  }
  return 0;
}

function parseTags(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (entry && typeof entry === "object" && typeof entry.tag === "string") {
        return entry.tag.trim();
      }
      return "";
    })
    .filter(Boolean);
}

function normalizeSearchItem(raw) {
  const record = raw && typeof raw === "object" ? raw : {};
  const data = record.data && typeof record.data === "object" ? record.data : record;
  const itemKey = String(record.key || record.itemKey || data.key || data.itemKey || "").trim();
  const title = String(data.title || record.title || "").trim();
  const abstractText = String(data.abstractNote || data.abstract || record.abstract || "").trim();
  const doi = String(data.DOI || data.doi || record.doi || "").trim();
  const year = parseYear(data.year || record.year, data.date || record.date);
  const journal = String(
    data.publicationTitle || data.journal || data.bookTitle || record.journal || "",
  ).trim();
  const tags = parseTags(data.tags || record.tags);
  const snippet = String(record.snippet || abstractText || journal || "").trim();

  return {
    itemKey,
    title,
    authors: parseAuthors(data.creators || data.authors || record.authors),
    year,
    journal,
    doi,
    abstract: abstractText,
    tags,
    itemType: String(data.itemType || record.itemType || "").trim(),
    libraryId: String(record.libraryId || record.library_id || "").trim(),
    zoteroVersion: Number.parseInt(String(record.version || record.zoteroVersion || 0), 10) || 0,
    snippet,
  };
}

function normalizeMetadata(payload) {
  const record = payload && typeof payload === "object" ? payload : {};
  const item = normalizeSearchItem(record);
  return {
    ...item,
    notes: [],
    fulltext: "",
  };
}

function normalizeNotes(payload) {
  const items = asArray(payload);
  if (items.length === 0 && typeof payload === "string") {
    return [payload.trim()].filter(Boolean);
  }

  return items
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      const data = entry?.data && typeof entry.data === "object" ? entry.data : entry;
      return String(
        data.note || data.content || data.text || entry.note || entry.content || entry.text || "",
      ).trim();
    })
    .filter(Boolean);
}

function normalizeFulltext(payload) {
  if (typeof payload === "string") {
    return payload.trim();
  }

  const record = payload && typeof payload === "object" ? payload : {};
  const candidates = [
    record.fulltext,
    record.content,
    record.text,
    record.body,
    record.extractedText,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  if (Array.isArray(record.pages)) {
    return record.pages
      .map((page) => (typeof page?.text === "string" ? page.text.trim() : ""))
      .filter(Boolean)
      .join("\n\n");
  }

  return "";
}

async function withZoteroClient(run, explicitServers) {
  const mcpServers = await buildEffectiveMcpServers(explicitServers);
  const server = selectZoteroServer(mcpServers);
  const client = new McpStdioClient(server.command, server.args ?? [], server.env ?? {});

  try {
    await client.initialize();
    const tools = await client.listTools();
    return await run(client, tools);
  } finally {
    await client.close();
  }
}

export async function searchZoteroLiterature(payload = {}) {
  return withZoteroClient(async (client, tools) => {
    const tool = findTool(tools, "zotero_search_items");
    if (!tool) {
      throw new Error("zotero_search_items tool is not available");
    }

    const args = buildArgsFromSchema(tool, {
      query: payload.query || "",
      limit: payload.limit || 12,
    });
    const result = await client.callTool(tool.name, args);
    return asArray(extractPayload(result))
      .map(normalizeSearchItem)
      .filter((item) => item.itemKey && item.title);
  }, payload.mcpServers);
}

export async function importZoteroLiterature(payload = {}) {
  return withZoteroClient(async (client, tools) => {
    const metadataTool = findTool(tools, "zotero_get_item_metadata");
    if (!metadataTool) {
      throw new Error("zotero_get_item_metadata tool is not available");
    }

    const metadataResult = await client.callTool(
      metadataTool.name,
      buildArgsFromSchema(metadataTool, {
        itemKey: payload.itemKey || "",
        libraryId: payload.libraryId || "",
      }),
    );

    const normalized = normalizeMetadata(extractPayload(metadataResult));

    const fulltextTool = findTool(tools, "zotero_get_item_fulltext");
    if (fulltextTool) {
      try {
        const fulltextResult = await client.callTool(
          fulltextTool.name,
          buildArgsFromSchema(fulltextTool, {
            itemKey: payload.itemKey || "",
            libraryId: payload.libraryId || "",
          }),
        );
        normalized.fulltext = normalizeFulltext(extractPayload(fulltextResult));
      } catch {
        // Full text is optional.
      }
    }

    const notesTool = findTool(tools, "zotero_get_notes");
    if (notesTool) {
      try {
        const notesResult = await client.callTool(
          notesTool.name,
          buildArgsFromSchema(notesTool, {
            itemKey: payload.itemKey || "",
            libraryId: payload.libraryId || "",
          }),
        );
        normalized.notes = normalizeNotes(extractPayload(notesResult));
      } catch {
        // Notes are optional.
      }
    }

    return normalized;
  }, payload.mcpServers);
}
