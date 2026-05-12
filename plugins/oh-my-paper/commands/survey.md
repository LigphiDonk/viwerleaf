---
name: survey
description: 全自动文献调研：下载真实论文 PDF 并 OCR，再执行搜索和 gap 分析
---

> **必须使用 AskUserQuestion 工具进行所有确认步骤，不得用纯文字替代。**

你是 Oh My Paper Orchestrator。执行文献调研前先和用户对齐方向，然后下载真实论文 PDF 并 OCR，让 ideation 阶段能读到真实论文内容。

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
> **工具：** literature-pdf-ocr-library（真实 PDF + OCR）+ inno-deep-research

选项：
- `确认，开始搜索`
- `调整搜索方向`
- `只搜某个方向`
- `我有具体的 arXiv ID 列表，直接下载`

如果用户选择调整，`AskUserQuestion` 询问具体方向修改，更新后再确认一次。
如果用户提供了 arXiv ID 列表，直接进入第三步用 `--arxiv-ids` 模式。

## 第三步：询问 OCR 方式（下载前必须确认）

用 `AskUserQuestion` 询问：

> 下载 PDF 后需要 OCR 转 Markdown，供后续 ideation 阅读真实论文内容。请选择 OCR 方式：

选项：
- `使用 PaddleOCR API（高质量布局识别，需要 Token）`
- `使用 pdfminer 本地模式（纯文本，无需 Token）`
- `只下载 PDF，暂不 OCR`

**如果用户选择 PaddleOCR API：**
用 `AskUserQuestion` 继续询问：
> 请提供你的 PADDLEOCR_TOKEN（仅用于本次会话，不会写入任何文件）：

**如果用户选择 pdfminer：**
用 `AskUserQuestion` 再次确认：
> pdfminer 只提取纯文本，没有图表和公式布局识别。确认用 pdfminer 继续？

选项：
- `确认，用 pdfminer 继续`
- `等我找到 PaddleOCR Token 再说`

## 第四步：执行下载 + OCR（仅在确认后）

### 4a. 下载论文

corpus-name 根据研究主题自动命名（短横线格式，如 `humanoid-locomotion`）。

```bash
# 如果用户提供了 arXiv IDs
python .claude/skills/literature-pdf-ocr-library/scripts/search_and_download_papers.py \
  --arxiv-ids <id1> <id2> ... \
  --out-dir .pipeline/literature/<corpus-name> \
  --download-pdfs

# 如果按关键词搜索
python .claude/skills/literature-pdf-ocr-library/scripts/search_and_download_papers.py \
  --query "<搜索关键词>" \
  --out-dir .pipeline/literature/<corpus-name> \
  --limit 20 --sources arxiv semanticscholar openalex \
  --download-pdfs
```

### 4b. OCR 转 Markdown

```bash
# PaddleOCR API（用户提供 Token）
export PADDLEOCR_TOKEN="<用户提供，不要写入文件>"
python .claude/skills/literature-pdf-ocr-library/scripts/paddleocr_layout_to_markdown.py \
  .pipeline/literature/<corpus-name>/papers/*/paper.pdf \
  --output-dir .pipeline/literature/<corpus-name>/papers \
  --skip-existing

# pdfminer fallback（用户已通过 AskUserQuestion 确认）
python .claude/skills/literature-pdf-ocr-library/scripts/paddleocr_layout_to_markdown.py \
  .pipeline/literature/<corpus-name>/papers/*/paper.pdf \
  --output-dir .pipeline/literature/<corpus-name>/papers \
  --fallback-pdfminer
```

### 4c. 生成索引

```bash
python .claude/skills/literature-pdf-ocr-library/scripts/build_library_index.py \
  --library-root .pipeline/literature/<corpus-name>
```

### 4d. 补充搜索（元数据层）

调用 `inno-deep-research` skill 搜索 OCR 没有覆盖的方向，每个方向至少找 5 篇。

### 4e. 更新 literature_bank.md

将所有论文逐条追加（含 OCR 路径字段）：

```
| [URL] | Title | Year | Venue | Relevance | accepted | Date | OCR路径 |
```

OCR 路径填实际路径，例如：
`.pipeline/literature/humanoid-core/papers/2502-13817-asap/ocr/paper/doc_0.md`
没有 OCR 的填 `none`。

完成后生成 `.pipeline/docs/gap_matrix.md` 分析研究空白，更新 `.pipeline/memory/agent_handoff.md`。

## 第五步：展示结果摘要

结果回来后告诉用户：

- 下载了多少篇、OCR 成功多少篇
- 新增了多少篇（总计多少篇）
- 主要覆盖了哪些方向
- gap_matrix.md 找到了哪几个研究空白

用 `AskUserQuestion` 询问：
- `够了，进入 /omp:ideate`
- `还需要补充搜索某个方向`
- `看看 gap_matrix 后再决定`
