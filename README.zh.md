<p align="center">
  <img src="./icons/icon.png" alt="Oh My Paper" width="120" height="120" />
</p>

<h1 align="center">Oh My Paper</h1>

<p align="center">
  <strong>Claude Code 科研 harness — 把你的终端变成自主科研实验室。</strong>
</p>

<p align="center">
  <a href="./README.md">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/claude--code-plugin-blueviolet?style=flat-square" />
  <img src="https://img.shields.io/badge/agents-5-ff69b4?style=flat-square" />
  <img src="https://img.shields.io/badge/skills-34-green?style=flat-square" />
  <img src="https://img.shields.io/badge/commands-8-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/license-MIT-orange?style=flat-square" />
</p>

---

## 快速开始

```bash
# 在 Claude Code 里：
/plugin marketplace add LigphiDonk/Oh-my--paper
/plugin install omp@oh-my-paper
```

重启 Claude Code，在你的科研项目里运行 `/omp:setup`，然后用 `/omp:survey`、`/omp:experiment`、`/omp:write` 驱动整个科研流程。不需要 GUI，不需要切窗口，所有事情都在终端里完成。

---

## 目录

- [为什么做这个](#为什么做这个)
- [安装](#安装)
- [命令列表](#命令列表)
- [Agent 团队](#agent-团队)
- [34 个研究技能](#34-个研究技能)
- [Hooks](#hooks)
- [科研流水线](#科研流水线)
- [项目结构](#项目结构)
- [记忆系统](#记忆系统)
- [Codex 任务委派](#codex-任务委派)
- [远程实验](#远程实验)
- [给 AI Agent 看](#给-ai-agent-看)
- [设计理念](#设计理念)
- [贡献](#贡献)
- [卸载](#卸载)

---

## 为什么做这个

Claude Code 是很强的编程 agent，但**科研不只是写代码** —— 还有文献调研、创新点评估、实验设计、论文撰写、引用核查，这些都需要特定领域的工作流。

Oh My Paper 让 Claude Code **理解科研**，提供：

- **结构化 5 阶段流水线** — 调研 → 创意 → 实验 → 发表 → 推广
- **5 个专职 agent 角色** — 各自有独立记忆和明确职责
- **34 个内置研究技能** — 从论文搜索到图表生成
- **后台 hooks** — 每次开会话自动注入项目上下文、触发角色选择
- **Codex 任务委派** — 把并行任务交给另一个终端里的 Codex 跑

装好就不用管了。会话越来越智能，科研进展有人帮你记。

---

## 安装

### 第一步：添加 marketplace

```bash
/plugin marketplace add LigphiDonk/Oh-my--paper
```

### 第二步：安装插件

```bash
/plugin install omp@oh-my-paper
```

### 第三步：重启 Claude Code

hooks 需要重启才能生效。

### 第四步：初始化项目

```bash
/omp:setup
```

这一步会创建 `.pipeline/` 目录，并把 SessionStart hook 注册到项目的 `.claude/settings.json`。

### 更新插件

一键更新到最新版本：

```bash
/omp:update
```

可选参数：
- `--check-only` — 仅检查更新，不执行安装
- `--auto` — 自动更新，不询问确认

插件还会在每次会话开始时自动检查更新（默认每日一次）。

如果发现新版本：
1. 更新命令从 GitHub 下载最新代码
2. 复制到插件缓存目录
3. 提示你运行 `/reload-plugins`（如果 hooks 有变更，需要重启 Claude Code）

> **手动更新（备选方案）**：
> 如果自动更新失败，可以使用以下命令手动更新：
> ```bash
> /plugin uninstall omp
> /plugin install omp@oh-my-paper
> /reload-plugins
> ```

### 从本地目录安装

```bash
git clone https://github.com/LigphiDonk/Oh-my--paper.git /tmp/oh-my-paper
# 在 Claude Code 里：
/plugin marketplace add /tmp/oh-my-paper
/plugin install omp@oh-my-paper
```

---

## 命令列表

所有命令以 `/omp:` 开头。

| 命令 | 作用 |
|------|------|
| `/omp:setup` | 初始化研究项目——创建 `.pipeline/`、记忆文件，注册 SessionStart hook |
| `/omp:survey` | AI 辅助文献调研——搜索论文，整理 `literature_bank.md` |
| `/omp:ideate` | 基于调研结果生成并评估创新点 |
| `/omp:experiment` | 设计实验、编写评估代码、在远程节点上运行 |
| `/omp:write` | 撰写论文章节、生成图表和标题、管理 LaTeX 文件 |
| `/omp:review` | 同行评审——提交前对论文或实验结果做质量把关 |
| `/omp:update` | 一键更新插件——检查并安装 GitHub 上的最新版本 |
| `/omp:delegate` | 生成 Codex prompt 委派代码/实验任务；等待结果后自动更新项目状态 |
| `/omp:plan` | 查看全局进展，确认下一步方向，更新研究计划 |

### 典型用法

```bash
/omp:setup          # 初始化项目
/omp:survey         # 开始文献调研
/omp:ideate         # 生成创新点
/omp:experiment     # 设计并运行实验
/omp:write          # 撰写论文
/omp:review         # 最终质量把关
```

---

## Agent 团队

在 Oh My Paper 项目里打开 Claude Code，`SessionStart` hook 会自动触发，Claude 立即弹出角色选择。每个角色有**独立的记忆范围**——只读写它需要的文件。

| 角色 | 职责 | 记忆范围 |
|------|------|---------|
| **Conductor（统筹者）** | 全局规划、评审产出、派发任务、每个子任务完成后自动更新 `project_truth` | `project_truth` · `orchestrator_state` · `tasks.json` · `review_log` · `agent_handoff` · `decision_log` |
| **Literature Scout（文献侦察）** | 搜索论文、整理文献库 | `project_truth` · `execution_context` · `literature_bank` · `decision_log` |
| **Experiment Driver（实验执行）** | 设计实验、编写代码、运行评估 | `execution_context` · `experiment_ledger` · `research_brief.json` · `project_truth` |
| **Paper Writer（论文写手）** | 撰写章节、生成图表、审查引用 | `execution_context` · `result_summary` · `literature_bank` · `agent_handoff` |
| **Reviewer（评审者）** | 同行评审、质量把关、一致性检查 | `execution_context` · `project_truth` · `result_summary` |

### 工作流

```
开启会话
    → SessionStart hook 触发
        → Claude 弹出角色选择
            → Agent 加载对应记忆文件
                → 以该角色身份工作
                    → 子任务完成：自动更新 tasks.json + project_truth
                        → 下次会话从上次断点继续
```

**关键设计：**

- **记忆隔离** — 论文写手看不到统筹者的编排状态；文献侦察看不到实验结果。防止上下文污染，让每个 agent 保持专注。
- **共享状态** — `tasks.json` 和 `project_truth.md` 是所有角色的公共地带，每个子任务结束后更新。
- **无需手动同步** — Conductor 在每个子任务完成后自动把 `tasks.json` 里的任务标为 `done`，并往 `project_truth.md` 追加进展记录，不需要你提醒。

---

## 34 个研究技能

技能是 Claude 按需加载的结构化指令集，每个技能是一个 markdown 文件，覆盖特定的科研任务。

<details>
<summary><strong>展开完整技能列表</strong></summary>

| 类别 | 技能 |
|------|------|
| **文献** | `paper-finder` · `paper-analyzer` · `paper-image-extractor` · `research-literature-trace` · `biorxiv-database` · `dataset-discovery` |
| **调研与创意** | `inno-deep-research` · `gemini-deep-research` · `inno-code-survey` · `inno-idea-generation` · `inno-idea-eval` · `research-idea-convergence` |
| **实验** | `inno-experiment-dev` · `inno-experiment-analysis` · `research-experiment-driver` · `remote-experiment` |
| **写作** | `inno-paper-writing` · `ml-paper-writing` · `scientific-writing` · `inno-figure-gen` · `inno-reference-audit` · `research-paper-handoff` |
| **规划与评审** | `inno-pipeline-planner` · `research-pipeline-planner` · `inno-paper-reviewer` · `inno-prepare-resources` · `inno-rclone-to-overleaf` |
| **演示** | `making-academic-presentations` · `inno-grant-proposal` |
| **Agent 派发** | `claude-code-dispatch` · `codex-dispatch` |
| **领域专项** | `academic-researcher` · `bioinformatics-init-analysis` · `research-news` |

</details>

技能根据当前流水线阶段自动推荐。也可以在 `skills/` 目录下添加项目本地技能。

---

## Hooks

Oh My Paper 注册三个后台运行的 hook：

| Hook | 触发时机 | 作用 |
|------|---------|------|
| **SessionStart** | 每次在此项目打开 Claude Code | 向 Claude 输出项目上下文（当前阶段、执行中任务、上次交接），然后通过 `AskUserQuestion` 提示选择角色 |
| **Stop** | 任务完成时 | 追踪任务完成，更新 `tasks.json` |
| **PostToolUse (Write)** | 任何文件写入后 | 检测流水线阶段跳转 |

**重要：** hook 只有在项目里跑过 `/omp:setup` 后才会生效。setup 会把 SessionStart hook 注册到 `.claude/settings.json`，并创建 hook 检测所需的 `.pipeline/` 目录。

---

## 科研流水线

从想法到发表的结构化 5 阶段工作流：

```
┌──────────┐    ┌──────────┐    ┌────────────┐    ┌─────────────┐    ┌───────────┐
│  调研    │ →  │  创意    │ →  │    实验    │ →  │    发表     │ →  │   推广    │
│ Survey   │    │ Ideation │    │ Experiment │    │ Publication │    │ Promotion │
└──────────┘    └──────────┘    └────────────┘    └─────────────┘    └───────────┘
```

每个阶段都有：
- **自动生成的任务树** — 告诉你下一步做什么
- **推荐技能** — 该阶段应该加载哪些技能
- **上下文感知提示** — agent 读取 `tasks.json` 和 `research_brief.json`，知道该做什么

---

## 项目结构

`/omp:setup` 创建以下结构：

```
my-research/
├── paper/                  # LaTeX 工作区
│   ├── main.tex
│   ├── sections/
│   └── refs/
├── experiment/             # 实验代码和脚本
├── survey/                 # 文献调研产出
├── ideation/               # 创新点、评估、计划
├── promotion/              # 幻灯片、Demo、推广材料
├── skills/                 # 项目本地技能
├── .pipeline/
│   ├── tasks/
│   │   └── tasks.json      # 跨阶段任务树
│   ├── docs/
│   │   └── research_brief.json
│   └── memory/             # Agent 记忆文件
├── .claude/
│   └── settings.json       # SessionStart hook 注册
├── CLAUDE.md
└── AGENTS.md
```

---

## 记忆系统

每个角色读写特定的记忆文件。Conductor 负责维护共享状态同步。

```
.pipeline/memory/
├── project_truth.md        # 项目基准 + 进展日志（每个子任务完成后追加）
├── orchestrator_state.md   # Conductor 的编排状态
├── execution_context.md    # 当前执行任务上下文（执行者看）
├── experiment_ledger.md    # 实验历史和结果
├── result_summary.md       # 最新结果（写作和评审用）
├── review_log.md           # 评审反馈历史
├── literature_bank.md      # 整理好的文献笔记
├── agent_handoff.md        # 角色间交接消息
└── decision_log.md         # 已否决方向及理由

.pipeline/tasks/
└── tasks.json              # 共享任务树（所有角色都读写）
```

记忆文件跨会话保留。`SessionStart` hook 读取这些文件并注入相关上下文——你从上次的断点继续。

**自动同步规则：** Conductor 在每个子任务完成后（delegate / experiment / survey / write / review 任一）自动更新 `tasks.json`（标记任务为 done）并往 `project_truth.md` 追加进展记录，不需要你提醒。

---

## Codex 任务委派

Conductor 可以把代码和实验任务交给 Codex 执行：

```bash
/omp:delegate
```

流程：
1. Conductor 读取项目上下文和当前任务
2. 展示任务摘要——你确认
3. 生成预注入上下文的完整 Codex prompt
4. 你复制到新终端：`codex "..."`
5. Conductor 轮询等待完成信号（`agent_handoff.md` 里的 `CODEX_DONE`）
6. 读取结果，让你接受/修改/放弃
7. 接受后：自动更新 `tasks.json` 和 `project_truth.md`

---

## 远程实验

`remote-experiment` 技能 + `/omp:experiment` 支持完整的自动实验循环：

```
设计方案 → 实现代码 → rsync 到服务器 → GPU 节点运行 → 解析指标 → 循环
```

- 通过 `compute-helper` CLI 实现 SSH/rsync 远程计算
- 可配置成功阈值、最大迭代次数、失败上限
- 结果自动回写 `experiment_ledger.md`，供论文写手使用

---

## 给 AI Agent 看

如果你是 AI agent 在安装此插件：

```bash
# 第一步：添加 marketplace
/plugin marketplace add LigphiDonk/Oh-my--paper

# 第二步：安装插件
/plugin install omp@oh-my-paper

# 第三步：验证安装
/plugin
# 应该显示：omp @ oh-my-paper, Status: Enabled

# 第四步：用户必须重启 Claude Code（你无法代劳）
# 告知用户："请重启 Claude Code 以激活 hooks。"

# 第五步：初始化项目
/omp:setup
```

---

## 设计理念

> **增强，而非替代。** Claude Code 本身已经很强——我们加的是科研结构，不是覆盖它的判断。

- **上下文留给推理用** — hooks 只注入必要信息；其余内容留在磁盘上的记忆文件里
- **领域专用，不求通用** — 每个技能、agent 和命令都是为学术科研设计的
- **不需要时无感存在** — hooks 在后台运行；你只是在写代码时不会有任何干扰
- **可组合** — 用一个命令、用全部命令，或者就让 hooks 自己跑
- **记忆胜于重复** — agent 记住项目上下文，你不用每次重新解释

---

## 贡献

欢迎 PR。新增技能请放在 `skills/` 目录，带好 YAML frontmatter，并更新 `research-catalog.json`。

任何涉及缓存内容的改动，需要同时更新以下两个文件的版本号：
- `plugins/oh-my-paper/.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`

---

## 卸载

```bash
/plugin uninstall omp@oh-my-paper
```

---

## 许可证

MIT。详见 [LICENSE](./LICENSE)。

---

## 致谢

特别感谢 **[Linux.do](https://linux.do)** 社区的支持与反馈。

---

<p align="center">
  <strong>Oh My Paper</strong> — 让科研在终端里自己跑起来。
</p>
