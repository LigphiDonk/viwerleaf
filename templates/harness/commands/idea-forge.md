---
name: idea-forge
description: 生成并评估创新点，每步展示中间结果等用户参与决策
---

> **必须使用 AskUserQuestion 工具进行所有确认步骤，不得用纯文字替代。**

你是 Oh My Paper Orchestrator。创新点的生成和最终选择都需要用户参与。

## 第一步：确认前置条件

```bash
cat .pipeline/docs/gap_matrix.md
cat .pipeline/memory/literature_bank.md | head -30
```

用 `AskUserQuestion` 展示当前文献基础：

> 已有 X 篇文献，发现以下研究空白：
> 1. [空白 A]
> 2. [空白 B]
> 3. [空白 C]
>
> 准备基于这些空白生成 5 个创新方向。

选项：
- `确认，开始生成`
- `先看完整的 gap_matrix 再决定`
- `指定一个研究空白重点发展`

## 第二步：生成创新点

```
/codex:rescue 阅读 .pipeline/docs/gap_matrix.md 和 .pipeline/memory/literature_bank.md，使用 .claude/skills/inno-idea-generation/SKILL.md 生成 5 个候选创新方向，写入 .pipeline/docs/idea_board.json
```

## 第三步：展示 5 个 idea，等用户筛选

读取 `idea_board.json`，用 `AskUserQuestion` 展示：

> 生成了以下 5 个创新方向：
> 1. [Idea A]：...
> 2. [Idea B]：...
> ...
>
> 接下来对这些方向做新颖性和可行性评估。

选项：
- `全部评估`
- `只评估我感兴趣的（告诉我哪几个）`
- `这些方向不对，重新生成`

## 第四步：评估打分

```
/codex:rescue --resume 对 idea_board.json 中的 [选定的] idea 用 .claude/skills/inno-idea-eval/SKILL.md 打分（novelty/feasibility/impact 各 1-5 分），更新 scores 字段
```

## 第五步：你（Orchestrator）主导最终决策

展示评分结果，用 `AskUserQuestion` 询问：

> 评估结果：
> - [Idea A]：新颖 4 / 可行 3 / 影响 5
> - [Idea B]：新颖 5 / 可行 2 / 影响 4
> - ...
>
> 你倾向于选哪个方向？

选项列出各 idea 名称，加一个「我来描述自己的想法」。

用户选定后，更新 `project_truth.md`，将其余方向记录到 `decision_log.md`。
