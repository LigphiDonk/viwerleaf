---
name: delegate
description: 为代码/实验任务生成 Codex prompt，用户复制到新终端执行，结果自动落到共享文件
---

> **必须使用 AskUserQuestion 工具进行所有确认步骤，不得用纯文字替代。**

你是 Oh My Paper 研究项目的 Orchestrator。此命令专用于需要 Codex 执行的**代码和实验任务**。

## 第一步：读取上下文

```bash
cat .pipeline/memory/project_truth.md
cat .pipeline/memory/agent_handoff.md
cat .pipeline/memory/decision_log.md
cat .pipeline/docs/research_brief.json
```

## 第二步：展示计划，等待确认

用 `AskUserQuestion` 向用户展示将要委派的任务摘要：

- **任务内容**：用 1-2 句话描述将交给 Codex 做什么
- **注入的上下文**：列出将附带哪些背景信息
- **输出文件**：Codex 完成后会写入哪个文件

选项：
- `确认，生成 prompt`
- `我来调整任务描述`
- `取消`

## 第三步：生成 Codex prompt（仅在确认后）

构建完整 prompt，格式如下：

```
[项目背景]
研究主题：（project_truth.md 前 10 行）
当前阶段：（research_brief.json 的 currentStage）

[已否决方向 - 不要重蹈]
（decision_log.md 最近 3 条，如有）

[上一步交接]
（agent_handoff.md 最近一条 Handoff 块，如有）

[你的任务]
（确认后的任务描述）

[输出要求]
完成后将结果摘要写入 .pipeline/memory/agent_handoff.md，
在文件末尾追加一行 <!-- CODEX_DONE -->
```

## 第四步：展示给用户复制执行

用代码块展示完整命令，告知用户在**新终端**里执行：

```
在新终端里运行：
codex "[完整 prompt]"

或后台运行：
codex --background "[完整 prompt]"
```

用 `AskUserQuestion` 询问：
- `我已经在新终端里跑起来了`
- `取消`

## 第五步：等待完成，读取结果

用户确认跑起来后，轮询等待完成信号：

```bash
# 每 10 秒检查一次，最多等 10 分钟
for i in $(seq 1 60); do
  grep -q "CODEX_DONE" .pipeline/memory/agent_handoff.md 2>/dev/null && break
  sleep 10
done
cat .pipeline/memory/agent_handoff.md | tail -30
```

读取结果后向用户简要说明：做了什么、产出了哪些文件、有没有问题。

用 `AskUserQuestion` 询问：
- `接受结果，继续下一步`
- `需要 Codex 修改某处`
- `这个结果有问题，放弃`

