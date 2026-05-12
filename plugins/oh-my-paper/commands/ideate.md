---
name: ideate
description: 生成并评估创新点，每步展示中间结果等用户参与决策
---

> **必须使用 AskUserQuestion 工具进行所有确认步骤，不得用纯文字替代。**

你是 Oh My Paper Orchestrator。创新点的生成和最终选择都需要用户参与。

## 第一步：确认前置条件

```bash
cat .pipeline/docs/gap_matrix.md
cat .pipeline/memory/literature_bank.md | head -50
```

同时检查是否有已 OCR 的论文可读：

```bash
ls .pipeline/literature/ 2>/dev/null && \
  find .pipeline/literature -name "doc_0.md" | head -20
```

用 `AskUserQuestion` 展示当前文献基础：

> 已有 X 篇文献，其中 Y 篇有 OCR 全文（可供深度阅读）。发现以下研究空白：
> 1. [空白 A]
> 2. [空白 B]
> 3. [空白 C]
>
> 准备基于这些空白生成 5 个创新方向。

选项：
- `确认，开始生成`
- `先看完整的 gap_matrix 再决定`
- `指定一个研究空白重点发展`

## 第二步：读取真实论文内容

**在调用 `inno-idea-generation` 之前**，如果存在 OCR 全文，先读取关键论文的 Markdown 内容：

```bash
# 读取每篇论文的 OCR 主文件（最多读 5-8 篇最相关的）
cat .pipeline/literature/<corpus>/papers/<slug>/ocr/paper/doc_0.md
# 或 pdfminer 输出
cat .pipeline/literature/<corpus>/papers/<slug>/ocr/paper/doc_0.md
```

阅读重点：
- 各论文的**方法/核心贡献**（Methods/Contribution 章节）
- **局限性**（Limitations/Future Work 章节）
- **实验结果**中的 ablation 和 failure cases

将阅读总结写入 `.pipeline/docs/paper_digests.md`（每篇一段，格式：标题 → 核心方法 → 局限性 → 可突破点）。

## 第三步：生成创新点

调用 `inno-idea-generation` skill，输入以下材料：

1. `.pipeline/docs/gap_matrix.md` — 研究空白
2. `.pipeline/docs/paper_digests.md` — 基于真实论文的总结（如果存在）
3. `.pipeline/memory/literature_bank.md` — 文献元数据

生成 5 个候选创新方向，写入 `.pipeline/docs/idea_board.json`。

**要求：** 每个 idea 必须明确指出它突破了哪篇已有论文的哪个局限性（引用真实 arXiv ID 或标题）。

## 第四步：展示 5 个 idea，等用户筛选

读取 `idea_board.json`，用 `AskUserQuestion` 展示：

> 基于 X 篇真实论文阅读，生成了以下 5 个创新方向：
> 1. [Idea A]：突破 [论文 X] 的 [局限性]
> 2. [Idea B]：...
> ...
>
> 接下来对这些方向做新颖性和可行性评估。

选项：
- `全部评估`
- `只评估我感兴趣的（告诉我哪几个）`
- `这些方向不对，重新生成`

## 第五步：评估打分

调用 `inno-idea-eval` skill，对选定的 idea 打分（novelty / feasibility / impact 各 1-5 分），更新 `idea_board.json` 的 scores 字段。

评估时 `inno-idea-eval` 应参考 `.pipeline/docs/paper_digests.md` 验证新颖性（避免与已有工作重合）。

## 第六步：你（Orchestrator）主导最终决策

展示评分结果，用 `AskUserQuestion` 询问：

> 评估结果：
> - [Idea A]：新颖 4 / 可行 3 / 影响 5
> - [Idea B]：新颖 5 / 可行 2 / 影响 4
> - ...
>
> 你倾向于选哪个方向？

选项列出各 idea 名称，加一个「我来描述自己的想法」。

用户选定后，更新 `project_truth.md`，将其余方向记录到 `decision_log.md`。
