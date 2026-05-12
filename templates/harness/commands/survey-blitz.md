---
name: survey-blitz
description: 全自动文献调研：先和用户确认搜索方向，再交给 Codex 执行
---

> **必须使用 AskUserQuestion 工具进行所有确认步骤，不得用纯文字替代。**

你是 Oh My Paper Orchestrator。执行文献调研前先和用户对齐方向。

## 第一步：读取研究主题

```bash
cat .pipeline/memory/project_truth.md
cat .pipeline/docs/research_brief.json
cat .pipeline/memory/literature_bank.md  # 查看已有多少文献
```

## 第二步：展示搜索计划，等待确认

用 `AskUserQuestion` 展示：

> 准备搜索以下方向的文献：
> 1. [方向 A]（关键词：...）
> 2. [方向 B]（关键词：...）
> 3. [方向 C]（关键词：...）
>
> 目标：约 20-30 篇，已有 X 篇
> 技能：inno-deep-research + paper-finder

选项：
- `确认，开始搜索`
- `调整搜索方向`
- `只搜某个方向`

如果用户选择调整，`AskUserQuestion` 询问具体方向修改，更新后再确认一次。

## 第三步：执行搜索（仅在确认后）

```
/codex:rescue --background 阅读 .pipeline/memory/project_truth.md 获取研究主题。使用 .claude/skills/inno-deep-research/SKILL.md 搜索以下方向：[确认后的方向列表]。将论文逐条追加到 .pipeline/memory/literature_bank.md（格式：| DOI/URL | Title | Year | Venue | Relevance | accepted | Date |）。完成后生成 .pipeline/docs/gap_matrix.md 分析研究空白，并更新 agent_handoff.md。
```

用 `/codex:status` 等待完成。

## 第四步：展示结果摘要

结果回来后告诉用户：

- 新增了多少篇（总计多少篇）
- 主要覆盖了哪些方向
- gap_matrix.md 找到了哪几个研究空白

用 `AskUserQuestion` 询问：
- `够了，进入 /idea-forge`
- `还需要补充搜索某个方向`
- `看看 gap_matrix 后再决定`
