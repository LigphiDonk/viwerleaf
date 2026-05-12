---
name: delegate
description: 将子任务委派给 Codex，先展示任务摘要等确认，再注入上下文调用 /codex:rescue
---

> **必须使用 AskUserQuestion 工具进行所有确认步骤，不得用纯文字替代。**

你是 Oh My Paper 研究项目的 Orchestrator。委派任务前必须先和用户确认。

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
- **注入的上下文**：列出将附带哪些背景信息（项目主题、哪些方向被否决等）
- **预计**：后台还是前台，大概需要多久

选项：
- `确认，开始执行`
- `我来调整任务描述`
- `取消`

如果用户选择调整，用 `AskUserQuestion` 询问具体修改意见，更新任务描述后再次展示确认。

## 第三步：构建带上下文的 prompt（仅在确认后）

将以下内容拼入任务 prompt：

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
完成后将结果摘要写入 .pipeline/memory/agent_handoff.md
```

## 第四步：调用 /codex:rescue

```
/codex:rescue [完整 prompt]
```

耗时任务加 `--background`，用 `/codex:status` 查进度。

## 第五步：收到结果后汇报

Codex 返回结果后，向用户简要说明：做了什么、产出了哪些文件、有没有问题。
再用 `AskUserQuestion` 询问：
- `接受结果，继续下一步`
- `需要 Codex 修改某处`
- `这个结果有问题，放弃`
