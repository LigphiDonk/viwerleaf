import { describe, expect, it } from "vitest";

import {
  normalizeProviderMcpServers,
  readProviderMcpServers,
  writeProviderMcpServers,
} from "./agentCatalog";

describe("provider MCP helpers", () => {
  it("keeps only valid stdio MCP servers", () => {
    expect(
      normalizeProviderMcpServers({
        zotero: {
          type: "stdio",
          command: "zotero-mcp",
          args: ["serve"],
          env: { ZOTERO_LOCAL: "true" },
        },
        remote: {
          type: "http",
          url: "https://example.com/mcp",
        },
        broken: {
          type: "stdio",
          command: "",
        },
      }),
    ).toEqual({
      zotero: {
        type: "stdio",
        command: "zotero-mcp",
        args: ["serve"],
        env: { ZOTERO_LOCAL: "true" },
      },
    });
  });

  it("reads MCP servers from provider metaJson", () => {
    expect(
      readProviderMcpServers({
        metaJson: JSON.stringify({
          runtime: { effort: "high" },
          mcpServers: {
            zotero: {
              command: "zotero-mcp",
              env: { ZOTERO_LOCAL: "true" },
            },
          },
        }),
      }),
    ).toEqual({
      zotero: {
        type: "stdio",
        command: "zotero-mcp",
        env: { ZOTERO_LOCAL: "true" },
      },
    });
  });

  it("writes MCP servers without dropping existing runtime metadata", () => {
    const metaJson = writeProviderMcpServers(
      {
        metaJson: JSON.stringify({
          runtime: { effort: "medium" },
        }),
      },
      {
        zotero: {
          command: "zotero-mcp",
          env: { ZOTERO_LOCAL: "true" },
        },
      },
    );

    expect(JSON.parse(metaJson)).toEqual({
      runtime: { effort: "medium" },
      mcpServers: {
        zotero: {
          type: "stdio",
          command: "zotero-mcp",
          env: { ZOTERO_LOCAL: "true" },
        },
      },
    });
  });
});
