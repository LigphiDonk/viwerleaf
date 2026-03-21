import type {
  AppLocale,
  ResearchBootstrapState,
  ResearchCanvasSnapshot,
  ResearchStage,
  ResearchStageSummary,
  ResearchTask,
} from "../types";

const STAGE_COPY: Record<AppLocale, Record<ResearchStage, { label: string; description: string }>> = {
  "zh-CN": {
    survey: {
      label: "文献调研",
      description: "明确研究边界、筛选标准与核心文献线索。",
    },
    ideation: {
      label: "研究构思",
      description: "从调研结论中提炼可发表的问题、假设与贡献点。",
    },
    experiment: {
      label: "实验推进",
      description: "规划实现、数据集、指标、消融和分析检查点。",
    },
    publication: {
      label: "论文写作",
      description: "把当前研究状态整理进主 LaTeX 工作区并完成写作清单。",
    },
    promotion: {
      label: "成果传播",
      description: "准备汇报、摘要、主页和后续交付物。",
    },
  },
  "en-US": {
    survey: {
      label: "Survey",
      description: "Define the boundary, screening criteria, and traceable literature base.",
    },
    ideation: {
      label: "Ideation",
      description: "Turn survey findings into a publishable question, hypothesis, and contribution.",
    },
    experiment: {
      label: "Experiment",
      description: "Plan implementation, datasets, metrics, ablations, and analysis checkpoints.",
    },
    publication: {
      label: "Publication",
      description: "Move validated work into the main LaTeX workspace and a writing checklist.",
    },
    promotion: {
      label: "Promotion",
      description: "Prepare talks, summaries, landing pages, and downstream deliverables.",
    },
  },
};

const BOOTSTRAP_MESSAGES: Record<AppLocale, Record<string, string>> = {
  "zh-CN": {
    ready: "研究画布已就绪，可以直接推进任务或进入写作台。",
    "needs-bootstrap": "当前项目还没有研究工作流脚手架，初始化后即可使用研究画布。",
    "missing-brief": "研究工作流已存在，但缺少 research brief，建议修复脚手架。",
    "missing-tasks": "研究工作流已存在，但缺少任务清单，建议修复脚手架。",
    partial: "研究工作流不完整，建议修复脚手架后继续。",
  },
  "en-US": {
    ready: "The research canvas is ready. You can continue tasks or move into the writing desk.",
    "needs-bootstrap": "This project does not have a research workflow scaffold yet. Initialize it to enable the canvas.",
    "missing-brief": "The workflow exists, but the research brief is missing. Repair the scaffold before continuing.",
    "missing-tasks": "The workflow exists, but the task list is missing. Repair the scaffold before continuing.",
    partial: "The workflow is incomplete. Repair the scaffold before continuing.",
  },
};

const TASK_COPY: Record<string, Record<AppLocale, Partial<ResearchTask>>> = {
  "survey-1": {
    "zh-CN": {
      title: "定义调研边界",
      description: "明确主题范围、目标投稿方向和文献筛选标准。",
      nextActionPrompt: "请使用 research-pipeline-planner 和 research-literature-trace 两个技能，界定调研范围，收集种子论文，并更新 research brief。",
      inputsNeeded: ["研究主题边界", "目标期刊/会议"],
    },
    "en-US": {},
  },
  "survey-2": {
    "zh-CN": {
      title: "筛选核心文献",
      description: "保留可追溯论文、关键基线方法和明确的研究空白。",
      nextActionPrompt: "请使用 research-literature-trace 技能筛选已收集文献，保留可追溯链接，并总结主要研究空白。",
      inputsNeeded: ["种子论文列表"],
    },
    "en-US": {},
  },
  "ideation-1": {
    "zh-CN": {
      title: "提炼可发表角度",
      description: "把调研结果转成清晰的研究假设或贡献点。",
      nextActionPrompt: "请使用 research-pipeline-planner 技能，把调研结论收敛成具体研究角度，更新 brief，并细化后续任务。",
      inputsNeeded: ["研究空白总结"],
    },
    "en-US": {},
  },
  "experiment-1": {
    "zh-CN": {
      title: "设计实验方案",
      description: "确定实现范围、数据集、指标和消融实验结构。",
      nextActionPrompt: "请使用 research-experiment-driver 技能，制定包含数据集、指标、消融和分析检查点的实验方案。",
      inputsNeeded: ["已选定的研究思路"],
    },
    "en-US": {},
  },
  "experiment-2": {
    "zh-CN": {
      title: "整理实现与分析笔记",
      description: "把实验计划拆成可执行的开发和分析检查点。",
      nextActionPrompt: "请使用 research-experiment-driver 技能，把实验计划拆成执行任务和分析笔记，并与论文论点对齐。",
      inputsNeeded: ["实验方案"],
    },
    "en-US": {},
  },
  "publication-1": {
    "zh-CN": {
      title: "切入论文工作区",
      description: "把已验证的研究状态转成论文写作清单。",
      nextActionPrompt: "请使用 research-paper-handoff 技能，为当前 LaTeX 工作区生成论文写作清单，把论点映射到章节，并指出缺失的图表或参考文献。",
      inputsNeeded: ["已验证的结论", "图表素材"],
    },
    "en-US": {},
  },
  "promotion-1": {
    "zh-CN": {
      title: "准备后续传播材料",
      description: "在论文草稿稳定后，整理汇报、摘要或发布说明。",
      nextActionPrompt: "请使用 research-paper-handoff 技能，基于当前论文状态整理汇报或摘要任务。",
      inputsNeeded: ["论文草稿"],
    },
    "en-US": {},
  },
};

export function localizeResearchTask(task: ResearchTask, locale: AppLocale): ResearchTask {
  const copy = TASK_COPY[task.id]?.[locale];
  return {
    ...task,
    ...(copy ?? {}),
    inputsNeeded: copy?.inputsNeeded ?? task.inputsNeeded,
    agentEntryLabel:
      !task.agentEntryLabel || task.agentEntryLabel === "Enter Agent"
        ? (locale === "zh-CN" ? "进入 Agent" : "Enter Agent")
        : task.agentEntryLabel,
  };
}

export function localizeResearchStageSummary(
  summary: ResearchStageSummary,
  locale: AppLocale,
): ResearchStageSummary {
  const stageCopy = STAGE_COPY[locale][summary.stage];
  return {
    ...summary,
    label: stageCopy.label,
    description: stageCopy.description,
  };
}

export function localizeResearchBootstrap(
  bootstrap: ResearchBootstrapState,
  locale: AppLocale,
): ResearchBootstrapState {
  return {
    ...bootstrap,
    message: BOOTSTRAP_MESSAGES[locale][bootstrap.status] ?? bootstrap.message,
  };
}

export function localizeResearchSnapshot(
  research: ResearchCanvasSnapshot,
  locale: AppLocale,
): ResearchCanvasSnapshot {
  const localizedTasks = research.tasks.map((task) => localizeResearchTask(task, locale));
  return {
    ...research,
    bootstrap: localizeResearchBootstrap(research.bootstrap, locale),
    tasks: localizedTasks,
    nextTask: research.nextTask
      ? localizedTasks.find((task) => task.id === research.nextTask?.id) ?? localizeResearchTask(research.nextTask, locale)
      : research.nextTask,
    stageSummaries: research.stageSummaries.map((summary) => localizeResearchStageSummary(summary, locale)),
  };
}

export function getLocalizedStageCopy(stage: ResearchStage, locale: AppLocale) {
  return STAGE_COPY[locale][stage];
}
