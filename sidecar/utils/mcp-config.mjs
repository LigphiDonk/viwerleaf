import { resolveExecutable } from "./resolve-cli.mjs";

function isStringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}

export function normalizeStdioMcpServers(mcpServers) {
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    return {};
  }

  const normalized = {};
  for (const [name, rawConfig] of Object.entries(mcpServers)) {
    if (!name.trim() || !rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
      continue;
    }

    const transport = typeof rawConfig.type === "string" ? rawConfig.type : "stdio";
    const command = typeof rawConfig.command === "string" ? rawConfig.command.trim() : "";
    if (transport !== "stdio" || !command) {
      continue;
    }

    const args = Array.isArray(rawConfig.args)
      ? rawConfig.args.filter((entry) => typeof entry === "string")
      : undefined;
    const env = isStringRecord(rawConfig.env) ? rawConfig.env : undefined;

    normalized[name] = {
      type: "stdio",
      command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  return normalized;
}

export function buildCodexMcpConfig(mcpServers) {
  const normalized = normalizeStdioMcpServers(mcpServers);
  const entries = Object.entries(normalized).map(([name, config]) => [
    name,
    {
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(config.env ? { env: config.env } : {}),
    },
  ]);

  if (entries.length === 0) {
    return undefined;
  }

  return {
    mcp_servers: Object.fromEntries(entries),
  };
}

export async function buildEffectiveMcpServers(mcpServers) {
  const normalized = normalizeStdioMcpServers(mcpServers);

  if (!normalized.zotero) {
    const zoteroCommand = await resolveExecutable("zotero-mcp");
    if (zoteroCommand) {
      normalized.zotero = {
        type: "stdio",
        command: zoteroCommand,
        env: {
          ZOTERO_LOCAL: "true",
        },
      };
    }
  }

  return normalized;
}
