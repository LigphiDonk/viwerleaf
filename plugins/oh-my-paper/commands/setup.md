---
name: setup
description: 初始化研究项目结构（.pipeline/），并检查 Codex 插件是否就绪
---

> **必须使用 AskUserQuestion 工具进行所有确认步骤，不得用纯文字替代。**

你正在为当前目录初始化 Oh My Paper 研究 harness。

## 第一步：检查 Codex 插件

先确认 Codex 插件已安装。如果 `/codex:setup` 命令可用，运行它：

```bash
node -e "process.exit(0)" 2>/dev/null && echo "Node.js OK"
which codex 2>/dev/null && codex --version 2>/dev/null || echo "Codex not found"
```

用 `AskUserQuestion` 告知状态：

> **环境检查**：
> - Node.js：[OK / 未安装]
> - Codex CLI：[版本 / 未安装]
>
> Codex 插件用于执行子任务。如果未安装：
> `/plugin install codex@openai-codex` 然后 `/reload-plugins`

选项：
- `Codex 已就绪，继续初始化`
- `先去安装 Codex，稍后再运行 /omp:setup`

## 第二步：询问研究信息

用 `AskUserQuestion` 收集项目基本信息：

> 请描述你的研究项目：
> - 研究主题是什么？（例：多模态医学影像分割）

然后再问：

> 从哪个阶段开始？

选项：
- `survey（文献调研）`
- `ideation（创新点生成）`
- `experiment（实验）`
- `publication（论文写作）`

## 第三步：创建目录结构

```bash
mkdir -p .pipeline/memory .pipeline/tasks .pipeline/docs .pipeline/.hook-events .claude/skills
cp -rn "${CLAUDE_PLUGIN_ROOT}/skills/." .claude/skills/
```

注册 SessionStart hook（让每次开启 Claude Code 时自动弹出角色选择）：

```bash
node -e "
const fs = require('fs');
const path = require('path');
const f = path.join('.claude', 'settings.json');
const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f,'utf8')) : {};
if (!s.hooks) s.hooks = {};
if (!s.hooks.SessionStart) s.hooks.SessionStart = [];
const cmd = 'node \"\${CLAUDE_PLUGIN_ROOT}/scripts/on-session-start.mjs\"';
const already = s.hooks.SessionStart.some(h =>
  Array.isArray(h.hooks) && h.hooks.some(hh => (hh.command||'').includes('on-session-start'))
);
if (!already) {
  s.hooks.SessionStart.push({ matcher: '', hooks: [{ type: 'command', command: cmd }] });
  fs.mkdirSync('.claude', { recursive: true });
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
  console.log('hook registered');
} else { console.log('hook already registered'); }
"
```

## 第四步：写入初始文件

创建以下文件（已存在则跳过）：

**`.pipeline/docs/research_brief.json`**：
```json
{
  "topic": "[用户填写的主题]",
  "goal": "",
  "currentStage": "[用户选择的阶段]",
  "successThreshold": "需要在此填写成功标准"
}
```

**`.pipeline/memory/project_truth.md`**：
```markdown
# Project Truth

## 研究主题
[主题]

## 已确认决策
（空，随项目推进逐步填充）
```

**`.pipeline/memory/orchestrator_state.md`**、**`execution_context.md`**、**`review_log.md`**、**`agent_handoff.md`**、**`decision_log.md`**、**`literature_bank.md`**、**`experiment_ledger.md`**：均创建空白初始版本。

**`.pipeline/tasks/tasks.json`**：
```json
{"version": 1, "tasks": []}
```

## 第五步：完成确认

> ✅ 研究项目初始化完成！
>
> **项目**：[主题]
> **起始阶段**：[阶段]
>
> 接下来：
> - 运行 `/omp:plan` 查看整体状态
> - 运行 `/omp:survey` 开始文献调研（如果从 survey 阶段）

选项：
- `开始！运行 /omp:plan`
- `我先自己看看文件结构`
