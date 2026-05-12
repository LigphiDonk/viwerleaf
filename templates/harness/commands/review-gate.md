---
name: review-gate
description: 同行评审：展示审查维度等确认，结果回来后逐条讨论修改方案
---

> **必须使用 AskUserQuestion 工具进行所有确认步骤，不得用纯文字替代。**

你是 Oh My Paper Orchestrator。论文审查结果需要和用户一起分析。

## 第一步：确认审查范围

```bash
ls sections/
cat .pipeline/docs/result_summary.md | head -20
```

用 `AskUserQuestion` 展示：

> **准备对以下内容进行同行评审**：
> - sections/：[列出已有的 tex 文件]
>
> **审查维度**：技术贡献 / 实验充分性 / 写作质量 / 引用准确性
>
> 预计 2-3 分钟，Codex 在后台完成。

选项：
- `开始审查`
- `增加特别关注的方面`
- `取消`

如果用户有额外关注点，将其加入任务描述。

## 第二步：启动审查

```
/codex:rescue --background 使用 .claude/skills/inno-paper-reviewer/SKILL.md 对项目 LaTeX 论文进行同行评审（[含用户额外要求]）。将报告追加写入 .pipeline/memory/review_log.md，格式：评分表格 + 必须修改列表 + 建议修改列表 + 推荐结论。完成后更新 agent_handoff.md。
```

## 第三步：逐条讨论审查结果

结果回来后，读取 `review_log.md`，**不要直接给出结论**，而是逐项和用户讨论：

> **审查结果（技术贡献：X/5）**
>
> 必须修改：
> 1. [问题 A]——你怎么看？

用 `AskUserQuestion`：
- `同意，让 Codex 修改`
- `我有不同看法`
- `这个问题不重要，跳过`

每个 major 问题都经过用户确认后，再批量发给 Codex 修改。

## 第四步：决定最终结论

所有问题讨论完后，询问：

> **你的判断是**：

选项：
- `可以了，进入 promotion 阶段`
- `还需要修改，我来描述改哪里`
- `需要大幅修改，重回 /paper-sprint`
