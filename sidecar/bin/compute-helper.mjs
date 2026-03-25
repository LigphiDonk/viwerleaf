#!/usr/bin/env node
/**
 * compute-helper.mjs — CLI for remote compute node operations.
 *
 * Reads active node config from ~/.viewerleaf/compute-nodes.json
 * and provides sync/run/ssh subcommands for the AI agent.
 *
 * Usage:
 *   node compute-helper.mjs info
 *   node compute-helper.mjs sync up   --cwd /path
 *   node compute-helper.mjs sync down --cwd /path [--files "logs/ results/"]
 *   node compute-helper.mjs run  "command" --cwd /path
 *   node compute-helper.mjs ssh  "command"
 */

import fs from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "child_process";

const CONFIG_FILE = path.join(os.homedir(), ".viewerleaf", "compute-nodes.json");

// ─── Config ────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, "utf8");
    return JSON.parse(data);
  } catch {
    return { nodes: [], activeNodeId: null };
  }
}

async function getActiveNode() {
  const config = await loadConfig();
  if (!config.activeNodeId || config.nodes.length === 0) return null;
  return (
    config.nodes.find((n) => n.id === config.activeNodeId) ||
    config.nodes[0] ||
    null
  );
}

// ─── Shell helpers ─────────────────────────────────────────────

function expandTilde(p) {
  if (p.startsWith("~")) return p.replace("~", os.homedir());
  return p;
}

function buildSshArgs(node) {
  const args = [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=15",
    "-p", String(node.port || 22),
  ];
  if (node.authMethod === "key" && node.keyPath) {
    args.push("-i", expandTilde(node.keyPath));
  }
  args.push(`${node.user}@${node.host}`);
  return args;
}

function buildSshCommand(node) {
  const parts = ["ssh", ...buildSshArgs(node).map(shellQuote)];
  return parts.join(" ");
}

function shellQuote(s) {
  if (/^[a-zA-Z0-9._\-/:@=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function execCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Exit ${code}: ${stderr || stdout}`));
    });
    proc.on("error", reject);
  });
}

function sshExec(node, remoteCmd) {
  const args = [...buildSshArgs(node), remoteCmd];

  // If password auth, use sshpass
  if (node.authMethod === "password" && node.password) {
    return execCommand("sshpass", ["-p", node.password, "ssh", ...args]);
  }
  return execCommand("ssh", args);
}

function getProjectName(cwd) {
  return path.basename(cwd);
}

function getRemotePath(node, cwd) {
  const projectName = getProjectName(cwd);
  const base = node.workDir || "~";
  return base.endsWith("/")
    ? `${base}${projectName}`
    : `${base}/${projectName}`;
}

// ─── Subcommands ───────────────────────────────────────────────

async function cmdInfo(node) {
  return {
    id: node.id,
    name: node.name,
    host: node.host,
    port: node.port || 22,
    user: node.user,
    authMethod: node.authMethod,
    workDir: node.workDir,
    sshCommand: buildSshCommand(node),
  };
}

async function cmdSync(node, direction, cwd, files) {
  if (!cwd) throw new Error("--cwd is required for sync");

  const remotePath = getRemotePath(node, cwd);
  const port = String(node.port || 22);

  // Build SSH command string for rsync -e flag
  const sshParts = [
    "ssh",
    "-o", "StrictHostKeyChecking=accept-new",
    "-p", port,
  ];
  if (node.authMethod === "key" && node.keyPath) {
    sshParts.push("-i", expandTilde(node.keyPath));
  }
  const sshCmd = sshParts.join(" ");

  if (direction === "up") {
    // Ensure remote directory exists
    await sshExec(node, `mkdir -p ${shellQuote(remotePath)}`);

    const src = cwd.endsWith("/") ? cwd : cwd + "/";
    const dst = `${node.user}@${node.host}:${remotePath}`;

    const rsyncArgs = [
      "-avz", "--delete",
      "-e", sshCmd,
      "--filter=:- .gitignore",
      "--exclude=.git/",
      "--exclude=node_modules/",
      "--exclude=__pycache__/",
      "--exclude=.viewerleaf/",
      "--exclude=target/",
      "--exclude=.venv/",
      "--exclude=venv/",
      src, dst,
    ];

    // Use sshpass for rsync if password auth
    if (node.authMethod === "password" && node.password) {
      return await execCommand("sshpass", ["-p", node.password, "rsync", ...rsyncArgs]);
    }
    return await execCommand("rsync", rsyncArgs);
  } else {
    // direction === "down"
    const filesToSync = files || "logs/ checkpoints/ results/";
    const fileParts = filesToSync.trim().split(/\s+/);
    const srcs = fileParts.map(
      (f) => `${node.user}@${node.host}:${remotePath}/${f}`
    );

    const rsyncArgs = [
      "-avz",
      "-e", sshCmd,
      ...srcs,
      cwd.endsWith("/") ? cwd : cwd + "/",
    ];

    if (node.authMethod === "password" && node.password) {
      return await execCommand("sshpass", ["-p", node.password, "rsync", ...rsyncArgs]);
    }
    return await execCommand("rsync", rsyncArgs);
  }
}

async function cmdRun(node, command, cwd) {
  if (!command) throw new Error("command argument is required");

  if (cwd) {
    // Auto-sync before running
    await cmdSync(node, "up", cwd);
    const remotePath = getRemotePath(node, cwd);
    return await sshExec(node, `cd ${shellQuote(remotePath)} && ${command}`);
  } else {
    return await sshExec(node, command);
  }
}

async function cmdSsh(node, command) {
  if (!command) throw new Error("command argument is required");
  return await sshExec(node, command);
}

// ─── Main ──────────────────────────────────────────────────────

function output(success, data) {
  console.log(JSON.stringify({ success, ...(typeof data === "string" ? { output: data } : data) }));
}

function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] || "";
      i++;
    } else {
      positional.push(argv[i]);
    }
  }
  return { args, positional };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0) {
    console.error("Usage: compute-helper.mjs <info|sync|run|ssh> [options]");
    process.exit(1);
  }

  const node = await getActiveNode();
  if (!node) {
    output(false, { error: "No active compute node configured" });
    process.exit(1);
  }

  const subcommand = rawArgs[0];
  const rest = rawArgs.slice(1);
  const { args, positional } = parseArgs(rest);

  try {
    let result;
    switch (subcommand) {
      case "info":
        result = await cmdInfo(node);
        output(true, result);
        break;

      case "sync": {
        const direction = positional[0] || "up";
        result = await cmdSync(node, direction, args.cwd, args.files);
        output(true, result);
        break;
      }

      case "run":
        result = await cmdRun(node, positional[0], args.cwd);
        output(true, result);
        break;

      case "ssh":
        result = await cmdSsh(node, positional[0]);
        output(true, result);
        break;

      default:
        output(false, { error: `Unknown subcommand: ${subcommand}` });
        process.exit(1);
    }
  } catch (err) {
    output(false, { error: err.message });
    process.exit(1);
  }
}

main();
