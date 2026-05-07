#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const PLUGIN_NAME = "oh-my-paper-codex";
const DISPLAY_NAME = "Oh My Paper";
const DEFAULT_MARKETPLACE_NAME = "local-codex-plugins";
const DEFAULT_MARKETPLACE_DISPLAY_NAME = "Local Codex Plugins";
const CLIENT_INFO = {
  name: "oh-my-paper-installer",
  version: "1.0.0",
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const homeDir = path.resolve(args.home ?? os.homedir());
  const sourceDir = path.resolve(
    args.source ?? path.join(repoRoot, "plugins", PLUGIN_NAME),
  );
  const pluginDir = path.resolve(
    args.pluginDir ?? path.join(homeDir, "plugins", PLUGIN_NAME),
  );
  const marketplacePath = path.resolve(
    args.marketplace ?? path.join(homeDir, ".agents", "plugins", "marketplace.json"),
  );

  if (args.command === "install") {
    await installPlugin({ sourceDir, pluginDir, marketplacePath, skipAppServer: args.skipAppServer });
    return;
  }

  if (args.command === "status") {
    await printStatus({
      sourceDir,
      pluginDir,
      marketplacePath,
      cwd: path.resolve(args.cwd ?? repoRoot),
      skipAppServer: args.skipAppServer,
    });
    return;
  }

  if (args.command === "uninstall") {
    await uninstallPlugin({ pluginDir, marketplacePath, skipAppServer: args.skipAppServer });
    return;
  }

  throw new Error(`Unsupported command: ${args.command}`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || !["install", "status", "uninstall"].includes(command)) {
    throw new Error(
      "Usage: node scripts/manage-codex-plugin.mjs <install|status|uninstall> [--home <dir>] [--source <dir>] [--plugin-dir <dir>] [--marketplace <path>] [--cwd <dir>] [--skip-app-server]",
    );
  }

  const parsed = {
    command,
    home: null,
    source: null,
    pluginDir: null,
    marketplace: null,
    cwd: null,
    skipAppServer: false,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--home") {
      parsed.home = requireValue(rest, ++i, "--home");
      continue;
    }
    if (arg === "--source") {
      parsed.source = requireValue(rest, ++i, "--source");
      continue;
    }
    if (arg === "--plugin-dir") {
      parsed.pluginDir = requireValue(rest, ++i, "--plugin-dir");
      continue;
    }
    if (arg === "--marketplace") {
      parsed.marketplace = requireValue(rest, ++i, "--marketplace");
      continue;
    }
    if (arg === "--cwd") {
      parsed.cwd = requireValue(rest, ++i, "--cwd");
      continue;
    }
    if (arg === "--skip-app-server") {
      parsed.skipAppServer = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function installPlugin({ sourceDir, pluginDir, marketplacePath, skipAppServer }) {
  const sourceManifestPath = path.join(sourceDir, ".codex-plugin", "plugin.json");
  await readFile(sourceManifestPath, "utf8");

  await rm(pluginDir, { recursive: true, force: true });
  await mkdir(path.dirname(pluginDir), { recursive: true });
  await cp(sourceDir, pluginDir, { recursive: true, force: true, dereference: true });

  const { marketplace } = await loadMarketplace(marketplacePath);
  marketplace.plugins = upsertPluginEntry(marketplace.plugins);
  await writeMarketplace(marketplacePath, marketplace);

  console.log(`Copied ${DISPLAY_NAME} to ${pluginDir}`);
  console.log(`Updated marketplace: ${marketplacePath}`);

  if (skipAppServer) {
    console.log('Skipped Codex app-server install. Open Codex > Plugins and install "Oh My Paper".');
    return;
  }

  const installResult = await tryInstallViaCodex(marketplacePath);
  if (installResult.ok) {
    console.log(`Installed and enabled "${DISPLAY_NAME}" in Codex.`);
    return;
  }

  console.log(`Codex auto-install skipped: ${installResult.reason}`);
  console.log('The plugin is registered. If Codex does not show it immediately, restart Codex and install "Oh My Paper" from the Plugins page.');
}

async function uninstallPlugin({ pluginDir, marketplacePath, skipAppServer }) {
  let uninstallMessage = null;
  if (!skipAppServer) {
    const uninstallResult = await tryUninstallViaCodex();
    if (uninstallResult.ok) {
      uninstallMessage = `Uninstalled "${DISPLAY_NAME}" from Codex.`;
    } else {
      uninstallMessage = `Codex uninstall skipped: ${uninstallResult.reason}`;
    }
  }

  await rm(pluginDir, { recursive: true, force: true });

  const { marketplace, exists } = await loadMarketplace(marketplacePath);
  if (exists) {
    marketplace.plugins = marketplace.plugins.filter((plugin) => plugin?.name !== PLUGIN_NAME);
    await writeMarketplace(marketplacePath, marketplace);
  }

  if (uninstallMessage) {
    console.log(uninstallMessage);
  }
  console.log(`Removed plugin files from ${pluginDir}`);
  if (exists) {
    console.log(`Updated marketplace: ${marketplacePath}`);
  }
}

async function printStatus({ sourceDir, pluginDir, marketplacePath, cwd, skipAppServer }) {
  const sourceManifestPath = path.join(sourceDir, ".codex-plugin", "plugin.json");
  const [sourceDirExists, sourceManifestExists, pluginDirExists, marketplaceFileExists] = await Promise.all([
    pathExists(sourceDir),
    pathExists(sourceManifestPath),
    pathExists(pluginDir),
    pathExists(marketplacePath),
  ]);

  const { marketplace, exists } = await loadMarketplace(marketplacePath);
  const fileStatus = {
    sourceDir,
    sourceDirExists,
    sourceManifestPath,
    sourceManifestExists,
    pluginDir,
    pluginDirExists,
    marketplacePath,
    marketplaceExists: exists,
    marketplaceName: marketplace.name,
    marketplaceDisplayName: marketplace.interface.displayName,
    marketplaceHasEntry: marketplace.plugins.some((plugin) => plugin?.name === PLUGIN_NAME),
    cwd,
  };

  if (skipAppServer) {
    console.log(
      JSON.stringify(
        {
          fileStatus,
          codexStatus: null,
          note: "Skipped Codex app-server checks.",
        },
        null,
        2,
      ),
    );
    return;
  }

  let codexStatus;
  try {
    codexStatus = await withCodexAppServer(async (client) => {
      const [homeList, cwdList] = await Promise.all([
        client.request("plugin/list", { forceRemoteSync: false }),
        client.request("plugin/list", { cwds: [cwd], forceRemoteSync: false }),
      ]);
      return {
        homeOnly: summarizePluginEntries(homeList),
        withCwd: summarizePluginEntries(cwdList),
      };
    });
  } catch (error) {
    codexStatus = {
      error: formatError(error),
    };
  }

  console.log(
    JSON.stringify(
      {
        fileStatus,
        codexStatus,
      },
      null,
      2,
    ),
  );
}

async function loadMarketplace(marketplacePath) {
  try {
    const raw = await readFile(marketplacePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Marketplace file must contain a JSON object.");
    }
    return {
      exists: true,
      marketplace: {
        name: typeof parsed.name === "string" && parsed.name ? parsed.name : DEFAULT_MARKETPLACE_NAME,
        interface:
          parsed.interface && typeof parsed.interface === "object" && !Array.isArray(parsed.interface)
            ? {
                ...parsed.interface,
                displayName:
                  typeof parsed.interface.displayName === "string" && parsed.interface.displayName
                    ? parsed.interface.displayName
                    : DEFAULT_MARKETPLACE_DISPLAY_NAME,
              }
            : { displayName: DEFAULT_MARKETPLACE_DISPLAY_NAME },
        plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [],
      },
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return {
      exists: false,
      marketplace: {
        name: DEFAULT_MARKETPLACE_NAME,
        interface: { displayName: DEFAULT_MARKETPLACE_DISPLAY_NAME },
        plugins: [],
      },
    };
  }
}

function summarizePluginEntries(listing) {
  const matches = [];
  for (const marketplace of listing?.marketplaces ?? []) {
    for (const plugin of marketplace?.plugins ?? []) {
      if (plugin?.name !== PLUGIN_NAME) {
        continue;
      }
      matches.push({
        marketplaceName: marketplace.name,
        marketplacePath: marketplace.path,
        pluginId: plugin.id,
        sourcePath: plugin.source?.path ?? null,
        installed: Boolean(plugin.installed),
        enabled: Boolean(plugin.enabled),
        installPolicy: plugin.installPolicy ?? null,
        authPolicy: plugin.authPolicy ?? null,
      });
    }
  }
  return matches;
}

function upsertPluginEntry(plugins) {
  const nextPlugins = Array.isArray(plugins) ? plugins.filter((plugin) => plugin?.name !== PLUGIN_NAME) : [];
  nextPlugins.push({
    name: PLUGIN_NAME,
    source: {
      source: "local",
      path: `./plugins/${PLUGIN_NAME}`,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  });
  return nextPlugins;
}

async function writeMarketplace(marketplacePath, marketplace) {
  await mkdir(path.dirname(marketplacePath), { recursive: true });
  const tempPath = `${marketplacePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
  await rename(tempPath, marketplacePath);
}

async function tryInstallViaCodex(marketplacePath) {
  try {
    await withCodexAppServer(async (client) => {
      await client.request("plugin/install", {
        marketplacePath,
        pluginName: PLUGIN_NAME,
        forceRemoteSync: false,
      });
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: formatError(error) };
  }
}

async function tryUninstallViaCodex() {
  try {
    const pluginId = await withCodexAppServer(async (client) => {
      const listing = await client.request("plugin/list", { forceRemoteSync: false });
      const installedPlugin = findInstalledPlugin(listing);
      if (!installedPlugin?.id) {
        return null;
      }
      await client.request("plugin/uninstall", {
        pluginId: installedPlugin.id,
        forceRemoteSync: false,
      });
      return installedPlugin.id;
    });

    if (!pluginId) {
      return { ok: false, reason: "plugin was not installed in Codex" };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: formatError(error) };
  }
}

function findInstalledPlugin(listing) {
  if (!listing || !Array.isArray(listing.marketplaces)) {
    return null;
  }
  for (const marketplace of listing.marketplaces) {
    if (!Array.isArray(marketplace.plugins)) {
      continue;
    }
    const installed = marketplace.plugins.find(
      (plugin) => plugin?.name === PLUGIN_NAME && (plugin.installed || plugin.enabled),
    );
    if (installed) {
      return installed;
    }
  }
  return null;
}

async function withCodexAppServer(run) {
  const codexCommand = process.platform === "win32" ? "codex.cmd" : "codex";
  const child = spawn(codexCommand, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const requests = new Map();
  let nextId = 1;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let settled = false;

  const rejectAll = (error) => {
    for (const pending of requests.values()) {
      pending.reject(error);
    }
    requests.clear();
  };

  child.on("error", (error) => {
    rejectAll(error);
  });

  child.on("exit", (code, signal) => {
    if (settled) {
      return;
    }
    const exitError = new Error(
      code === 0
        ? "Codex app-server exited before responding."
        : `Codex app-server exited with code ${code ?? "unknown"}${signal ? ` (signal: ${signal})` : ""}. ${stderrBuffer}`.trim(),
    );
    rejectAll(exitError);
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
  });

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    while (stdoutBuffer.includes("\n")) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(message, "id")) {
        continue;
      }
      const pending = requests.get(message.id);
      if (!pending) {
        continue;
      }
      requests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  });

  const client = {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        requests.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
  };

  try {
    await client.request("initialize", {
      protocolVersion: 2,
      clientInfo: CLIENT_INFO,
    });
    const result = await run(client);
    settled = true;
    child.kill();
    return result;
  } catch (error) {
    settled = true;
    child.kill();
    throw error;
  }
}

function formatError(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(`Error: ${formatError(error)}`);
  process.exit(1);
});
