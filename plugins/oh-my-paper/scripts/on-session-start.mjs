/**
 * on-session-start.mjs
 * SessionStart hook — 注入当前任务上下文到 .pipeline/.session-context.md
 */

import fs from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const PROJECT = process.cwd();
const SESSION_CONTEXT = path.join(PROJECT, ".pipeline", ".session-context.md");
const TTL_MS = 5 * 60 * 1000;

// 检查更新（每日最多一次）
function checkForUpdate() {
  try {
    const pluginRoot = path.resolve(PROJECT, 'plugins', 'oh-my-paper');
    if (!existsSync(pluginRoot)) return false;
    
    const checkScript = path.join(pluginRoot, 'scripts', 'check-update.mjs');
    if (!existsSync(checkScript)) return false;
    
    const output = execSync(`node "${checkScript}"`, { 
      cwd: PROJECT, 
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return true; // 有更新（退出码 0）
  } catch (e) {
    // 检查脚本执行失败（退出码非0 = 无更新或检查失败）
    return false;
  }
}

function main() {
  // 自动更新检查（每日一次）
  const pipelineDir = path.join(PROJECT, ".pipeline");
  if (existsSync(pipelineDir)) {
    const lastCheckFile = path.join(pipelineDir, ".last-update-check");
    const today = new Date().toISOString().split('T')[0];
    let shouldCheck = true;

    if (existsSync(lastCheckFile)) {
      const lastCheck = readFileSync(lastCheckFile, "utf8").trim();
      if (lastCheck === today) shouldCheck = false;
    }

    if (shouldCheck) {
      if (checkForUpdate()) {
        process.stdout.write("\n🔔 OMP 插件有可用更新！运行 /omp:update 更新\n");
      }
      // 写入今天已检查标记
      try {
        writeFileSync(lastCheckFile, today);
      } catch (e) {}
    }
  }

  // 如果已经有新鲜的 context，跳过
  if (existsSync(SESSION_CONTEXT)) {
    if (Date.now() - statSync(SESSION_CONTEXT).mtimeMs < TTL_MS) return;
  }

  // 检查是否是研究项目
  if (!existsSync(pipelineDir)) return;

  const lines = ["# Session Context (Auto-generated)", ""];

  const briefPath = path.join(pipelineDir, "docs", "research_brief.json");
  if (existsSync(briefPath)) {
    try {
      const brief = JSON.parse(readFileSync(briefPath, "utf8"));
      lines.push(`**当前阶段**: ${brief.currentStage || "unknown"}`);
      lines.push(`**研究主题**: ${brief.topic || ""}`);
      lines.push("");
    } catch {}
  }

  const contextPath = path.join(pipelineDir, "memory", "execution_context.md");
  if (existsSync(contextPath)) {
    const content = readFileSync(contextPath, "utf8").trim();
    if (content) {
      lines.push("## 当前任务");
      lines.push(content.split("\n").slice(0, 30).join("\n"));
      lines.push("");
    }
  }

  const handoffPath = path.join(pipelineDir, "memory", "agent_handoff.md");
  if (existsSync(handoffPath)) {
    const content = readFileSync(handoffPath, "utf8");
    const matches = [...content.matchAll(/^## Handoff:.+$/gm)];
    if (matches.length > 0) {
      const last = content.slice(matches[matches.length - 1].index).trim();
      lines.push("## 上一步交接");
      lines.push(last.split("\n").slice(0, 10).join("\n"));
      lines.push("");
    }
  }

  lines.push(`_生成时间: ${new Date().toISOString()}_`);
  lines.push("");
  lines.push("## 启动指令");
  lines.push("");
  lines.push("检测到 Oh My Paper 研究项目。请立即用 `AskUserQuestion` 询问用户今天的工作模式，选项如下：");
  lines.push("");
  lines.push("- `统筹规划` — 以 Conductor 身份：查看全局进展，决定下一步，评审产出");
  lines.push("- `文献调研` — 以 Literature Scout 身份：搜索论文，整理 literature_bank");
  lines.push("- `实验执行` — 以 Experiment Driver 身份：设计/实现/运行实验，追踪结果");
  lines.push("- `论文写作` — 以 Paper Writer 身份：撰写章节，生成图表，审查引用");
  lines.push("- `论文评审` — 以 Reviewer 身份：同行评审，输出 review_log");
  lines.push("- `直接告诉我要做什么` — 跳过角色选择");
  lines.push("");
  lines.push("用户选择后，读取对应角色的记忆文件，以该角色身份开始工作。");

  const output = lines.join("\n");

  // 输出到 stdout 供 Claude Code SessionStart hook 读取
  process.stdout.write(output + "\n");

  // 同时写文件备用
  fs.mkdir(path.dirname(SESSION_CONTEXT), { recursive: true })
    .then(() => fs.writeFile(SESSION_CONTEXT, output, "utf8"))
    .catch(() => {});
}

main();
