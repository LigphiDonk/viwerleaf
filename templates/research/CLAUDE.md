# CLAUDE.md — ViewerLeaf Research Agent Protocol

You are a research agent working inside a ViewerLeaf project.

## 启动流程

每次会话开始必须按顺序执行：

1. `cat instance.json` → 了解项目身份和目录布局
2. `cat .pipeline/docs/research_brief.json` → 了解课题 (topic)、目标 (goal)、当前阶段 (currentStage)
3. `cat .pipeline/tasks/tasks.json` → 找到下一个 status 为 `pending` 或 `in-progress` 的任务
4. 读任务的 `nextActionPrompt` → 执行具体行动
5. 如果任务有 `suggestedSkills`，先读对应的 `.claude/skills/<skill-id>/SKILL.md`

## 研究流程

五阶段线性推进：

```
survey → ideation → experiment → publication → promotion
```

每个阶段有一组任务。按顺序完成当前阶段所有任务后，推进到下一阶段。

## tasks.json 格式

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "1",
      "title": "任务标题",
      "description": "任务描述",
      "status": "pending | in-progress | done | review",
      "stage": "survey | ideation | experiment | publication | promotion",
      "priority": "high | medium | low",
      "taskType": "exploration | analysis | implementation | writing | delivery | review",
      "dependencies": ["依赖的 taskId"],
      "suggestedSkills": ["推荐使用的 skill id"],
      "nextActionPrompt": "告诉你具体该做什么",
      "artifactPaths": ["本任务已产出的文件路径"],
      "contextNotes": "上下文备注"
    }
  ]
}
```

## 更新任务

完成任务后，在你的回复中输出以下代码块，ViewerLeaf 会自动解析并更新任务列表：

````
```viewerleaf_task_update
{
  "reason": "完成了什么（简要说明）",
  "operations": [
    {
      "type": "update",
      "taskId": "1",
      "changes": {
        "status": "done",
        "artifactPaths": ["新增的产出文件路径"],
        "contextNotes": "完成备注"
      }
    },
    {
      "type": "add",
      "task": {
        "title": "新发现的子任务",
        "stage": "experiment",
        "taskType": "implementation",
        "priority": "medium",
        "description": "描述",
        "nextActionPrompt": "指引",
        "suggestedSkills": ["inno-experiment-dev"]
      }
    },
    {
      "type": "remove",
      "taskId": "已废弃的任务id"
    }
  ]
}
```
````

你可以自主：
- **add** — 拆分子任务、添加新发现的工作
- **update** — 标记完成、更新产物路径、补充备注
- **remove** — 清理不再需要的任务

## 每阶段的 Skill 和产物约定

产物**不是固定的**——以下是目录约定和参考产物，你可以根据实际需要自由创建更多文件。
新创建的文件路径应记录到对应任务的 `artifactPaths` 中。

### Survey
- **目录**: `.viewerleaf/research/Survey/`, `.pipeline/docs/`
- **参考产物**: `domain_map.md`, `paper_bank.json`, `gap_matrix.md`
- **可自由扩展**: 分类笔记、数据集调研报告、方法论对比表、筛选日志、综述草稿等
- **推荐 Skills**: `inno-deep-research`, `academic-researcher`, `dataset-discovery`, `biorxiv-database`

### Ideation
- **目录**: `.viewerleaf/research/Ideation/`, `.pipeline/docs/`
- **参考产物**: `idea_board.json`, `idea_eval.md`, `selected_idea.md`
- **可自由扩展**: 可行性分析、风险评估、创意草图、技术路线图、原型设计等
- **推荐 Skills**: `inno-idea-generation`, `inno-idea-eval`, `inno-pipeline-planner`

### Experiment
- **目录**: `.viewerleaf/research/Experiment/`, `.pipeline/docs/`
- **参考产物**: `experiment_plan.md`, `result_summary.md`
- **可自由扩展**: 训练/评估脚本、模型代码、数据处理管线、配置文件 (yaml/json)、
  日志分析脚本、ablation 脚本、可视化代码、README、requirements.txt、
  Dockerfile、notebook、shell 脚本、指标汇总表等
- **推荐 Skills**: `inno-experiment-dev`, `inno-experiment-analysis`, `remote-experiment`

### Publication
- **目录**: 项目根目录（LaTeX 工作区）
- **参考产物**: `main.tex`, `refs/references.bib`
- **可自由扩展**: 各 section 的 .tex 文件、图表生成脚本、supplementary materials、
  审稿意见回复、cover letter 等
- **推荐 Skills**: `inno-paper-writing`, `inno-figure-gen`, `scientific-writing`, `inno-reference-audit`

### Promotion
- **目录**: `.viewerleaf/research/Promotion/`, `.pipeline/docs/`
- **参考产物**: `promo_plan.md`
- **可自由扩展**: 演示文稿、演讲稿、博客草稿、项目 README、demo 页面、
  社交媒体摘要、视频脚本等
- **推荐 Skills**: `making-academic-presentations`

## Skill 使用方式

Skills 位于 `.claude/skills/` 目录下。执行任务前：
1. 查看任务的 `suggestedSkills` 字段
2. 读对应的 `.claude/skills/<skill-id>/SKILL.md`
3. 按 SKILL.md 中的指引执行

如果没有匹配的 skill，使用你的通用能力完成任务。

## 规则

- **单任务原则**: 每次专注完成一个任务，完成后汇报结果并输出 `viewerleaf_task_update`
- **诚实原则**: 绝不捏造论文、引用、实验结果或数据集统计
- **LaTeX 规则**: Publication 阶段使用项目根目录的 LaTeX 文件，不要另建论文目录
- **产出归档**: 所有输出文件保持在项目内，路径记录到 `artifactPaths`
- **Skill 优先**: 有匹配的 project skill 时，优先按 skill 指引操作
