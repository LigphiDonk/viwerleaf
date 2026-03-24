use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use walkdir::WalkDir;

use crate::models::{
    ApplyResearchTaskSuggestionRequest, PipelineArtifact, ResearchBootstrapState,
    ResearchCanvasSnapshot, ResearchStageSummary, ResearchTask, ResearchTaskCounts,
    ResearchTaskDraft, ResearchTaskPlanOperation, ResearchTaskUpdateChanges,
};

const STAGE_ORDER: [&str; 5] = [
    "survey",
    "ideation",
    "experiment",
    "publication",
    "promotion",
];

const AGENTS_TEMPLATE: &str = include_str!("../../../templates/research/AGENTS.md");
const CLAUDE_TEMPLATE: &str = include_str!("../../../templates/research/CLAUDE.md");
const RESEARCH_SCOPE_FIXTURE: &str = include_str!("../../../skills/research-scope.json");
const RESEARCH_STAGE_MAP_FIXTURE: &str = include_str!("../../../skills/research-stage-map.json");
const DEFAULT_PIPELINE_TEMPLATE: &str =
    include_str!("../../../templates/research/default-pipeline.json");

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PipelineMeta {
    start_stage: Option<String>,
    current_stage: Option<String>,
    initialized_stages: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BriefMeta {
    topic: Option<String>,
    goal: Option<String>,
    pipeline: Option<PipelineMeta>,
    system_prompt: Option<String>,
    working_memory: Option<String>,
    interaction_rules: Option<Vec<String>>,
}

// ── Pipeline template types ──────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PipelineTemplate {
    #[allow(dead_code)]
    template_id: Option<String>,
    stages: HashMap<String, TemplateStage>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TemplateStage {
    #[serde(default)]
    required_elements: Vec<String>,
    #[serde(default)]
    optional_elements: Vec<String>,
    #[serde(default)]
    quality_gate: String,
    #[serde(default)]
    task_blueprints: Vec<TemplateBlueprintEntry>,
    #[serde(default)]
    recommended_skills: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TemplateBlueprintEntry {
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default, alias = "task_type")]
    task_type: String,
    #[serde(default)]
    priority: String,
    #[serde(default)]
    inputs_needed: Vec<String>,
    #[serde(default)]
    artifact_paths: Vec<String>,
}


#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TasksEnvelope {
    tasks: Vec<ResearchTask>,
}

#[derive(Debug, Deserialize)]
struct ResearchScopeManifest {
    skills: Vec<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct StageSkillConfig {
    #[serde(default)]
    base: Vec<String>,
    #[serde(default, rename = "byTaskType")]
    by_task_type: HashMap<String, Vec<String>>,
}

fn normalize_stage(stage: Option<&str>) -> String {
    let Some(raw) = stage.map(str::trim).filter(|value| !value.is_empty()) else {
        return "survey".into();
    };
    let lowered = raw.to_ascii_lowercase();
    if STAGE_ORDER.contains(&lowered.as_str()) {
        lowered
    } else {
        "survey".into()
    }
}

fn stage_index(stage: &str) -> usize {
    STAGE_ORDER
        .iter()
        .position(|candidate| *candidate == stage)
        .unwrap_or_default()
}

fn stage_label(stage: &str) -> &'static str {
    match stage {
        "survey" => "Survey",
        "ideation" => "Ideation",
        "experiment" => "Experiment",
        "publication" => "Publication",
        "promotion" => "Promotion",
        _ => "Research",
    }
}

fn stage_description(stage: &str) -> &'static str {
    match stage {
        "survey" => "Map the field, collect traceable literature, and stabilize the research boundary.",
        "ideation" => "Turn the survey into a concrete angle, candidate ideas, and a lead hypothesis worth testing.",
        "experiment" => "Define implementation, datasets, metrics, ablations, and analysis checkpoints.",
        "publication" => "Move the validated state into the main LaTeX workspace and draft the paper.",
        "promotion" => "Prepare follow-up deliverables such as slides, summaries, and release notes.",
        _ => "Research workflow stage.",
    }
}

fn stage_bundle_label(stage: &str) -> &'static str {
    match stage {
        "survey" => "Domain & Literature",
        "ideation" => "Idea Generation",
        "experiment" => "Experiment Driver",
        "publication" => "Paper Handoff",
        "promotion" => "Research Delivery",
        _ => "Research Bundle",
    }
}

fn stage_bundle_description(stage: &str) -> &'static str {
    match stage {
        "survey" => "Use this bundle to map the field, collect real papers, and keep screening notes traceable.",
        "ideation" => "Use this bundle to generate, compare, and refine candidate research directions.",
        "experiment" => "Use this bundle to plan implementation, metrics, ablations, and analysis checkpoints.",
        "publication" => "Use this bundle to draft the paper, audit references, and keep claims aligned with evidence.",
        "promotion" => "Use this bundle to prepare slides, summaries, and release-facing downstream materials.",
        _ => "Research bundle.",
    }
}

fn status_rank(status: &str) -> usize {
    match status {
        "in-progress" => 0,
        "pending" => 1,
        "review" => 2,
        "done" => 3,
        "deferred" => 4,
        "cancelled" => 5,
        _ => 6,
    }
}

fn normalize_status(raw: &str) -> String {
    match raw.trim().to_lowercase().replace('_', "-").as_str() {
        "done" | "completed" | "complete" | "finished" => "done",
        "in-progress" | "in progress" | "running" | "active" | "started" => "in-progress",
        "pending" | "todo" | "not-started" | "not started" | "queued" | "waiting" => "pending",
        "review" | "in-review" | "in review" => "review",
        "deferred" | "blocked" | "on-hold" | "on hold" => "deferred",
        "cancelled" | "canceled" | "removed" | "skipped" => "cancelled",
        _ => return raw.trim().to_string(),
    }
    .to_string()
}

fn task_is_open(task: &ResearchTask) -> bool {
    matches!(
        task.status.as_str(),
        "pending" | "in-progress" | "review" | ""
    )
}

fn task_is_done(task: &ResearchTask) -> bool {
    task.status == "done"
}

fn dependency_satisfied(task: &ResearchTask, done_ids: &BTreeSet<String>) -> bool {
    task.dependencies
        .iter()
        .all(|dependency| done_ids.contains(dependency))
}

fn normalize_stage_list(values: Option<&[String]>) -> Vec<String> {
    let mut stages = values
        .unwrap_or(&[])
        .iter()
        .map(|value| normalize_stage(Some(value)))
        .filter(|stage| !stage.is_empty())
        .collect::<Vec<_>>();
    stages.sort_by_key(|stage| stage_index(stage));
    stages.dedup();
    stages
}

fn research_root(root: &Path) -> PathBuf {
    root.join(".viewerleaf").join("research")
}

fn survey_root(root: &Path) -> PathBuf {
    research_root(root).join("Survey")
}

fn ideation_root(root: &Path) -> PathBuf {
    research_root(root).join("Ideation")
}

fn experiment_root(root: &Path) -> PathBuf {
    research_root(root).join("Experiment")
}

fn promotion_root(root: &Path) -> PathBuf {
    research_root(root).join("Promotion")
}

fn pipeline_root(root: &Path) -> PathBuf {
    root.join(".pipeline")
}

fn bundled_skills_root(skills_dir: &Path) -> PathBuf {
    skills_dir.to_path_buf()
}

fn write_if_missing(path: &Path, contents: &str) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)?;
    Ok(())
}

fn write_json_if_missing(path: &Path, value: &Value) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string_pretty(value)?)?;
    Ok(())
}

fn copy_dir_contents(source: &Path, target: &Path) -> Result<()> {
    if !source.exists() {
        return Ok(());
    }
    if target.exists() {
        fs::remove_dir_all(target)?;
    }
    fs::create_dir_all(target)?;

    for entry in WalkDir::new(source)
        .into_iter()
        .filter_map(|entry| entry.ok())
    {
        let relative = match entry.path().strip_prefix(source) {
            Ok(path) => path,
            Err(_) => continue,
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        let destination = target.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&destination)?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(entry.path(), &destination)?;
    }

    Ok(())
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn collect_files_under(root: &Path, dir: &Path) -> Vec<String> {
    if !dir.exists() {
        return Vec::new();
    }
    let mut files = WalkDir::new(dir)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| relative_path(root, entry.path()))
        .collect::<Vec<_>>();
    files.sort();
    files
}

fn collect_publication_files(root: &Path) -> Vec<String> {
    let mut files = WalkDir::new(root)
        .into_iter()
        .filter_entry(|entry| {
            if entry.path() == root {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            !(entry.file_type().is_dir() && name.starts_with('.'))
        })
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            let ext = entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if matches!(ext.as_str(), "tex" | "bib") {
                Some(relative_path(root, entry.path()))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    files.sort();
    files
}

fn default_research_brief(project_title: &str, start_stage: &str) -> Value {
    let template = load_default_template();
    let stages_value = serde_json::to_value(&template.stages).unwrap_or(json!({}));
    json!({
        "version": 1,
        "topic": project_title,
        "goal": "Turn this topic into a traceable research workflow inside ViewerLeaf.",
        "systemPrompt": format!(
            "You are the shared research agent for the project `{project_title}`. Plan and execute the project as a staged scientific workflow. Keep outputs evidence-based, traceable, and aligned with the project goal."
        ),
        "workingMemory": "Project initialized. Use this field to keep a concise rolling summary of validated findings, open questions, and current decisions.",
        "interactionRules": [
            "Prefer evidence and traceability over speed.",
            "Do not fabricate papers, citations, datasets, metrics, or results.",
            "When a task is active, optimize for that task while preserving project-wide consistency.",
            "Propose task updates only when the project state materially changes."
        ],
        "pipeline": {
            "startStage": start_stage,
            "currentStage": start_stage,
            "initializedStages": [],
            "stages": stages_value
        },
        "stageNotes": {
            "survey": "Map the field, collect traceable papers, and define the research boundary.",
            "ideation": "Extract gaps, generate candidate ideas, and converge on a viable angle.",
            "experiment": "Plan implementation, metrics, ablations, and analysis.",
            "publication": "Draft the paper in the main LaTeX workspace.",
            "promotion": "Prepare slides, summaries, and follow-up deliverables."
        },
        "experimentLoop": default_experiment_loop()
    })
}

fn default_experiment_loop() -> Value {
    json!({
        "enabled": false,
        "remoteNode": "active",
        "evalCommand": "",
        "successMetric": "primaryMetric",
        "successDirection": "max",
        "successThreshold": 0,
        "maxIterations": 10,
        "maxFailures": 3,
        "maxDurationMinutes": 60,
        "resultPaths": []
    })
}

fn research_scope_skill_ids() -> Vec<String> {
    serde_json::from_str::<ResearchScopeManifest>(RESEARCH_SCOPE_FIXTURE)
        .map(|manifest| manifest.skills)
        .unwrap_or_default()
}

fn research_stage_map() -> HashMap<String, StageSkillConfig> {
    serde_json::from_str::<HashMap<String, StageSkillConfig>>(RESEARCH_STAGE_MAP_FIXTURE)
        .unwrap_or_default()
}

fn recommended_skills(stage: &str, task_type: &str) -> Vec<String> {
    let stage_map = research_stage_map();
    let Some(config) = stage_map.get(stage) else {
        return Vec::new();
    };

    let mut skills = config.base.clone();
    if let Some(by_task_type) = config.by_task_type.get(task_type) {
        skills.extend(by_task_type.clone());
    }
    skills.sort();
    skills.dedup();
    skills
}

fn stage_bundle_skill_ids(stage: &str) -> Vec<String> {
    let stage_map = research_stage_map();
    let Some(config) = stage_map.get(stage) else {
        return Vec::new();
    };
    let mut skills = config.base.clone();
    skills.sort();
    skills.dedup();
    skills
}

fn build_next_action_prompt(stage: &str, task_type: &str, suggested_skills: &[String]) -> String {
    if suggested_skills.is_empty() {
        return "Review the current research state, update the project artifacts, and keep outputs traceable.".into();
    }

    let skill_list = suggested_skills
        .iter()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "Use the suggested research skills ({skill_list}) to advance the {stage} stage with a {task_type} task, update the project artifacts, and keep outputs traceable."
    )
}

fn default_task_prompt(
    stage: &str,
    title: &str,
    description: &str,
    next_action_prompt: &str,
) -> String {
    format!(
        "You are working on the `{title}` task in the `{stage}` stage.\nGoal: {description}\nExecution rule: keep outputs traceable to project files, papers, experiments, or notes.\nPreferred next action: {next_action_prompt}"
    )
}

fn dedup_strings(values: &[String]) -> Vec<String> {
    let mut out = values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    out.sort();
    out.dedup();
    out
}

fn apply_task_changes(
    task: &mut ResearchTask,
    changes: &ResearchTaskUpdateChanges,
    known_task_ids: &BTreeSet<String>,
) {
    if let Some(title) = changes
        .title
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        task.title = title.to_string();
    }
    if let Some(status) = changes
        .status
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        task.status = normalize_status(status);
    }
    if let Some(stage) = changes.stage.as_deref() {
        task.stage = normalize_stage(Some(stage));
    }
    if let Some(priority) = changes
        .priority
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        task.priority = priority.to_string();
    }
    if let Some(dependencies) = changes.dependencies.as_ref() {
        task.dependencies = dedup_strings(dependencies)
            .into_iter()
            .filter(|dependency| dependency != &task.id && known_task_ids.contains(dependency))
            .collect();
    }
    if let Some(task_type) = changes
        .task_type
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        task.task_type = task_type.to_string();
    }
    if let Some(description) = changes
        .description
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        task.description = description.to_string();
    }
    if let Some(inputs_needed) = changes.inputs_needed.as_ref() {
        task.inputs_needed = dedup_strings(inputs_needed);
    }
    if let Some(artifact_paths) = changes.artifact_paths.as_ref() {
        task.artifact_paths = dedup_strings(artifact_paths);
    }
    if let Some(suggested_skills) = changes.suggested_skills.as_ref() {
        task.suggested_skills = dedup_strings(suggested_skills);
    }
    if let Some(next_action_prompt) = changes
        .next_action_prompt
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        task.next_action_prompt = next_action_prompt.to_string();
    }
    if let Some(context_notes) = changes
        .context_notes
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        task.context_notes = context_notes.to_string();
    }
    if let Some(task_prompt) = changes
        .task_prompt
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        task.task_prompt = task_prompt.to_string();
    }
    if let Some(agent_entry_label) = changes
        .agent_entry_label
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        task.agent_entry_label = agent_entry_label.to_string();
    }
    task.last_updated_at = iso_now();
}

fn next_custom_task_id(tasks: &[ResearchTask], _stage: &str) -> String {
    let max_numeric = tasks
        .iter()
        .filter_map(|task| task.id.parse::<u32>().ok())
        .max()
        .unwrap_or(0);
    (max_numeric + 1).to_string()
}

fn build_custom_task(tasks: &[ResearchTask], draft: &ResearchTaskDraft) -> Result<ResearchTask> {
    let title = draft.title.trim();
    if title.is_empty() {
        bail!("task title is required");
    }

    let stage = normalize_stage(Some(&draft.stage));
    let known_task_ids = tasks
        .iter()
        .map(|task| task.id.clone())
        .collect::<BTreeSet<_>>();
    let id = draft
        .id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| next_custom_task_id(tasks, &stage));
    let dependencies = dedup_strings(draft.dependencies.as_deref().unwrap_or(&[]))
        .into_iter()
        .filter(|dependency| dependency != &id && known_task_ids.contains(dependency))
        .collect::<Vec<_>>();

    Ok(ResearchTask {
        id,
        title: title.to_string(),
        description: draft
            .description
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string(),
        status: draft
            .status
            .as_deref()
            .unwrap_or("pending")
            .trim()
            .to_string(),
        stage,
        priority: draft
            .priority
            .as_deref()
            .unwrap_or("medium")
            .trim()
            .to_string(),
        dependencies,
        task_type: draft
            .task_type
            .as_deref()
            .unwrap_or("custom")
            .trim()
            .to_string(),
        inputs_needed: dedup_strings(draft.inputs_needed.as_deref().unwrap_or(&[])),
        suggested_skills: dedup_strings(draft.suggested_skills.as_deref().unwrap_or(&[])),
        next_action_prompt: draft
            .next_action_prompt
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(title)
            .to_string(),
        artifact_paths: dedup_strings(draft.artifact_paths.as_deref().unwrap_or(&[])),
        task_prompt: draft
            .task_prompt
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string(),
        context_notes: draft
            .context_notes
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string(),
        last_updated_at: iso_now(),
        agent_entry_label: draft
            .agent_entry_label
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string(),
    })
}

fn sort_tasks(tasks: &mut [ResearchTask]) {
    tasks.sort_by(|left, right| {
        stage_index(&left.stage)
            .cmp(&stage_index(&right.stage))
            .then(status_rank(&left.status).cmp(&status_rank(&right.status)))
            .then(left.title.cmp(&right.title))
            .then(left.id.cmp(&right.id))
    });
}

fn load_default_template() -> PipelineTemplate {
    serde_json::from_str::<PipelineTemplate>(DEFAULT_PIPELINE_TEMPLATE)
        .expect("built-in default-pipeline.json must be valid")
}

fn load_pipeline_template(brief: Option<&Value>) -> PipelineTemplate {
    // Try to read pipeline.stages from the brief itself
    if let Some(brief_value) = brief {
        if let Some(stages_value) = brief_value
            .get("pipeline")
            .and_then(|p| p.get("stages"))
        {
            if stages_value.is_object() {
                if let Ok(stages) =
                    serde_json::from_value::<HashMap<String, TemplateStage>>(stages_value.clone())
                {
                    if !stages.is_empty() {
                        return PipelineTemplate {
                            template_id: brief_value
                                .get("pipeline")
                                .and_then(|p| p.get("templateId"))
                                .and_then(|v| v.as_str())
                                .map(ToOwned::to_owned),
                            stages,
                        };
                    }
                }
            }
        }
    }
    // Fallback: use built-in default template (compat migration)
    load_default_template()
}

/// Generate tasks from a pipeline template for the given stages.
///
/// Behavior aligned with dr-claw:
/// - Only generates for `start_stage` and subsequent stages
/// - Skips stages that already have tasks in `existing_tasks`
/// - For each stage:
///   1. Blueprint tasks from `task_blueprints`
///   2. "Define/Refine X" tasks for `required_elements` not covered by any blueprint
///   3. A quality-gate review task if `quality_gate` is defined
/// - `recommended_skills`: template stage declaration > stage-map fallback
/// - Sequential dependencies within each stage
fn generate_pipeline_tasks(
    template: &PipelineTemplate,
    start_stage: &str,
    existing_tasks: &[ResearchTask],
) -> Vec<ResearchTask> {
    let start_idx = stage_index(start_stage);

    // Find the next available numeric ID
    let mut next_id: u32 = existing_tasks
        .iter()
        .filter_map(|t| t.id.parse::<u32>().ok())
        .max()
        .unwrap_or(0)
        + 1;

    let existing_stages: BTreeSet<String> = existing_tasks
        .iter()
        .map(|t| t.stage.clone())
        .collect();

    let mut generated = Vec::new();

    for stage_name in STAGE_ORDER.iter().filter(|s| stage_index(s) >= start_idx) {
        // Skip stages that already have tasks
        if existing_stages.contains(*stage_name) {
            continue;
        }

        let template_stage = template.stages.get(*stage_name);

        // Determine skills: template declaration > stage-map fallback
        let stage_skills = template_stage
            .map(|ts| ts.recommended_skills.clone())
            .filter(|skills| !skills.is_empty())
            .unwrap_or_else(|| stage_bundle_skill_ids(stage_name));

        let blueprints = template_stage
            .map(|ts| &ts.task_blueprints[..])
            .unwrap_or_default();

        let mut prev_id: Option<String> = None;

        // 1. Blueprint tasks
        for bp in blueprints {
            let id = next_id.to_string();
            next_id += 1;

            let task_type = if bp.task_type.is_empty() {
                "analysis"
            } else {
                &bp.task_type
            };
            let priority = if bp.priority.is_empty() {
                "medium"
            } else {
                &bp.priority
            };

            // Skills: template stage-level > per-task from stage map
            let task_skills = if !stage_skills.is_empty() {
                let mut s = stage_skills.clone();
                let fallback = recommended_skills(stage_name, task_type);
                for skill in fallback {
                    if !s.contains(&skill) {
                        s.push(skill);
                    }
                }
                s
            } else {
                recommended_skills(stage_name, task_type)
            };

            let next_action = build_next_action_prompt(stage_name, task_type, &task_skills);
            let task_prompt =
                default_task_prompt(stage_name, &bp.title, &bp.description, &next_action);

            let dependencies = prev_id.iter().cloned().collect::<Vec<_>>();

            generated.push(ResearchTask {
                id: id.clone(),
                title: bp.title.clone(),
                description: bp.description.clone(),
                status: "pending".into(),
                stage: stage_name.to_string(),
                priority: priority.to_string(),
                dependencies,
                task_type: task_type.to_string(),
                inputs_needed: bp.inputs_needed.clone(),
                suggested_skills: task_skills,
                next_action_prompt: next_action,
                artifact_paths: bp.artifact_paths.clone(),
                task_prompt,
                context_notes: String::new(),
                last_updated_at: String::new(),
                agent_entry_label: "Enter Agent".into(),
            });

            prev_id = Some(id);
        }

        // 2. Gap tasks for required_elements not covered by any blueprint
        if let Some(ts) = template_stage {
            let covered: BTreeSet<String> = blueprints
                .iter()
                .flat_map(|bp| {
                    bp.title
                        .to_ascii_lowercase()
                        .split_whitespace()
                        .map(ToOwned::to_owned)
                        .collect::<Vec<_>>()
                })
                .collect();

            for element in &ts.required_elements {
                let keywords: Vec<String> = element
                    .replace('_', " ")
                    .split_whitespace()
                    .map(|w| w.to_ascii_lowercase())
                    .collect();
                let already_covered = keywords.iter().any(|kw| covered.contains(kw));
                if already_covered {
                    continue;
                }

                let id = next_id.to_string();
                next_id += 1;
                let readable = element.replace('_', " ");
                let title = format!("Define/Refine {readable}");
                let description = format!(
                    "Ensure the required element '{readable}' is documented and traceable in the project artifacts."
                );
                let task_skills = recommended_skills(stage_name, "exploration");
                let next_action =
                    build_next_action_prompt(stage_name, "exploration", &task_skills);
                let task_prompt =
                    default_task_prompt(stage_name, &title, &description, &next_action);
                let dependencies = prev_id.iter().cloned().collect::<Vec<_>>();

                generated.push(ResearchTask {
                    id: id.clone(),
                    title,
                    description,
                    status: "pending".into(),
                    stage: stage_name.to_string(),
                    priority: "medium".into(),
                    dependencies,
                    task_type: "exploration".into(),
                    inputs_needed: vec![readable],
                    suggested_skills: task_skills,
                    next_action_prompt: next_action,
                    artifact_paths: Vec::new(),
                    task_prompt,
                    context_notes: String::new(),
                    last_updated_at: String::new(),
                    agent_entry_label: "Enter Agent".into(),
                });

                prev_id = Some(id);
            }

            // 3. Quality gate review task
            if !ts.quality_gate.is_empty() {
                let id = next_id.to_string();
                next_id += 1;
                let title = format!("{} Quality Gate Review", stage_label(stage_name));
                let description = ts.quality_gate.clone();
                let task_skills = recommended_skills(stage_name, "review");
                let next_action =
                    build_next_action_prompt(stage_name, "review", &task_skills);
                let task_prompt =
                    default_task_prompt(stage_name, &title, &description, &next_action);
                let dependencies = prev_id.iter().cloned().collect::<Vec<_>>();

                generated.push(ResearchTask {
                    id: id.clone(),
                    title,
                    description,
                    status: "pending".into(),
                    stage: stage_name.to_string(),
                    priority: "high".into(),
                    dependencies,
                    task_type: "review".into(),
                    inputs_needed: Vec::new(),
                    suggested_skills: task_skills,
                    next_action_prompt: next_action,
                    artifact_paths: Vec::new(),
                    task_prompt,
                    context_notes: String::new(),
                    last_updated_at: String::new(),
                    agent_entry_label: "Enter Agent".into(),
                });
            }
        }
    }

    generated
}


fn default_pipeline_config(start_stage: &str) -> Value {
    json!({
        "version": 1,
        "startStage": start_stage,
        "intakeCompleted": true,
        "bootstrappedAt": iso_now()
    })
}

fn default_instance(root: &Path) -> Value {
    let root_string = root.to_string_lossy().to_string();
    json!({
        "instanceId": format!("viewerleaf-{}", root.file_name().and_then(|value| value.to_str()).unwrap_or("project")),
        "Survey": {
            "references": survey_root(root).join("references").to_string_lossy().to_string(),
            "reports": survey_root(root).join("reports").to_string_lossy().to_string()
        },
        "Ideation": {
            "ideas": ideation_root(root).join("ideas").to_string_lossy().to_string(),
            "references": ideation_root(root).join("references").to_string_lossy().to_string()
        },
        "Experiment": {
            "code_references": experiment_root(root).join("code_references").to_string_lossy().to_string(),
            "datasets": experiment_root(root).join("datasets").to_string_lossy().to_string(),
            "core_code": experiment_root(root).join("core_code").to_string_lossy().to_string(),
            "analysis": experiment_root(root).join("analysis").to_string_lossy().to_string()
        },
        "Publication": {
            "paper": root_string
        },
        "Promotion": {
            "homepage": promotion_root(root).join("homepage").to_string_lossy().to_string(),
            "slides": promotion_root(root).join("slides").to_string_lossy().to_string(),
            "audio": promotion_root(root).join("audio").to_string_lossy().to_string(),
            "video": promotion_root(root).join("video").to_string_lossy().to_string()
        }
    })
}

fn copy_bundled_skill_set(skills_dir: &Path, target_root: &Path) -> Result<()> {
    fs::create_dir_all(target_root)?;
    for skill_id in research_scope_skill_ids() {
        let source_dir = bundled_skills_root(skills_dir).join(&skill_id);
        if !source_dir.exists() {
            continue;
        }
        copy_dir_contents(&source_dir, &target_root.join(&skill_id))?;
    }
    Ok(())
}

fn write_skill_views(skills_dir: &Path, root: &Path) -> Result<()> {
    let skill_dirs = research_scope_skill_ids();

    let skills_index = {
        let mut lines = vec![
            "# Skills Index".to_string(),
            String::new(),
            "Read only the skill that matches the current task.".to_string(),
            String::new(),
        ];
        for skill_id in &skill_dirs {
            lines.push(format!("- `{skill_id}` -> `./{skill_id}/SKILL.md`"));
        }
        lines.join("\n")
    };

    for base in [
        root.join(".agents").join("skills"),
        root.join(".claude").join("skills"),
        root.join(".codex").join("skills"),
    ] {
        fs::create_dir_all(&base)?;
        fs::write(base.join("skills-index.md"), &skills_index)?;
        copy_bundled_skill_set(skills_dir, &base)?;
    }

    Ok(())
}

fn write_templates(root: &Path) -> Result<()> {
    write_if_missing(&root.join("AGENTS.md"), AGENTS_TEMPLATE)?;
    write_if_missing(&root.join("CLAUDE.md"), CLAUDE_TEMPLATE)?;
    Ok(())
}

fn write_default_research_docs(root: &Path) -> Result<()> {
    write_if_missing(
        &pipeline_root(root).join("docs").join("domain_map.md"),
        "# Domain Map\n\nUse this file to summarize the field boundary, core venues, benchmark patterns, and open questions.\n",
    )?;
    write_if_missing(
        &pipeline_root(root).join("docs").join("paper_bank.json"),
        "{\n  \"papers\": []\n}\n",
    )?;
    write_if_missing(
        &pipeline_root(root).join("docs").join("gap_matrix.md"),
        "# Gap Matrix\n\nTrack representative baselines, their limitations, and the gaps that matter.\n",
    )?;
    write_if_missing(
        &pipeline_root(root).join("docs").join("idea_board.json"),
        "{\n  \"ideas\": []\n}\n",
    )?;
    write_if_missing(
        &pipeline_root(root).join("docs").join("idea_eval.md"),
        "# Idea Evaluation\n\nCompare candidate ideas by novelty, feasibility, risk, and experimental leverage.\n",
    )?;
    write_if_missing(
        &pipeline_root(root).join("docs").join("selected_idea.md"),
        "# Selected Idea\n\nRecord the chosen angle, novelty claim, and first experiment commitments.\n",
    )?;
    write_if_missing(
        &pipeline_root(root).join("docs").join("experiment_plan.md"),
        "# Experiment Plan\n\nDocument datasets, metrics, baselines, ablations, and execution checkpoints.\n",
    )?;
    write_if_missing(
        &pipeline_root(root).join("docs").join("result_summary.md"),
        "# Result Summary\n\nLink each claim to supporting evidence, caveats, and remaining questions.\n",
    )?;
    write_if_missing(
        &pipeline_root(root).join("docs").join("promo_plan.md"),
        "# Promotion Plan\n\nCapture slide structure, release notes, and downstream communication tasks.\n",
    )?;
    Ok(())
}

pub fn project_skill_roots(root: &Path) -> Vec<PathBuf> {
    vec![
        root.join(".agents").join("skills"),
        root.join(".claude").join("skills"),
        root.join("skills"),
    ]
}

pub fn ensure_research_scaffold(
    skills_dir: &Path,
    root: &Path,
    start_stage: Option<&str>,
) -> Result<()> {
    let start_stage = normalize_stage(start_stage);

    fs::create_dir_all(survey_root(root).join("references"))?;
    fs::create_dir_all(survey_root(root).join("reports"))?;
    fs::create_dir_all(ideation_root(root).join("ideas"))?;
    fs::create_dir_all(ideation_root(root).join("references"))?;
    fs::create_dir_all(experiment_root(root).join("code_references"))?;
    fs::create_dir_all(experiment_root(root).join("datasets"))?;
    fs::create_dir_all(experiment_root(root).join("core_code"))?;
    fs::create_dir_all(experiment_root(root).join("analysis"))?;
    fs::create_dir_all(promotion_root(root).join("homepage"))?;
    fs::create_dir_all(promotion_root(root).join("slides"))?;
    fs::create_dir_all(promotion_root(root).join("audio"))?;
    fs::create_dir_all(promotion_root(root).join("video"))?;
    fs::create_dir_all(pipeline_root(root).join("docs"))?;
    fs::create_dir_all(pipeline_root(root).join("tasks"))?;

    write_templates(root)?;
    copy_bundled_skill_set(skills_dir, &root.join("skills"))?;
    write_skill_views(skills_dir, root)?;

    let project_title = root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("ViewerLeaf Project");

    write_json_if_missing(&root.join("instance.json"), &default_instance(root))?;
    write_json_if_missing(
        &pipeline_root(root).join("config.json"),
        &default_pipeline_config(&start_stage),
    )?;
    write_json_if_missing(
        &pipeline_root(root).join("docs").join("research_brief.json"),
        &default_research_brief(project_title, &start_stage),
    )?;
    write_default_research_docs(root)?;
    write_json_if_missing(
        &pipeline_root(root).join("tasks").join("tasks.json"),
        &json!({
            "version": 1,
            "tasks": [],
        }),
    )?;

    Ok(())
}

#[cfg(test)]
fn read_json_file(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

enum BriefReadResult {
    Missing,
    InvalidJson,
    Valid(Value, BriefMeta),
}

fn read_brief(path: &Path) -> BriefReadResult {
    if !path.exists() {
        return BriefReadResult::Missing;
    }
    let Ok(raw) = fs::read_to_string(path) else {
        return BriefReadResult::InvalidJson;
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return BriefReadResult::InvalidJson;
    };
    let meta = serde_json::from_value::<BriefMeta>(value.clone()).unwrap_or_default();
    BriefReadResult::Valid(value, meta)
}

fn merged_experiment_loop(brief_value: &Value) -> Value {
    let mut merged = default_experiment_loop();
    let Some(merged_obj) = merged.as_object_mut() else {
        return merged;
    };

    if let Some(overrides) = brief_value.get("experimentLoop").and_then(Value::as_object) {
        for (key, value) in overrides {
            merged_obj.insert(key.clone(), value.clone());
        }
    }

    merged
}

impl BriefReadResult {
    fn meta(&self) -> Option<&BriefMeta> {
        match self {
            BriefReadResult::Valid(_, meta) => Some(meta),
            _ => None,
        }
    }

    fn value(&self) -> Option<&Value> {
        match self {
            BriefReadResult::Valid(value, _) => Some(value),
            _ => None,
        }
    }
}

fn read_tasks(path: &Path) -> Vec<ResearchTask> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };

    if let Ok(envelope) = serde_json::from_str::<TasksEnvelope>(&raw) {
        return envelope.tasks;
    }

    serde_json::from_str::<Vec<ResearchTask>>(&raw).unwrap_or_default()
}

fn write_tasks(path: &Path, tasks: &[ResearchTask]) -> Result<()> {
    fs::write(
        path,
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "tasks": tasks,
        }))?,
    )?;
    Ok(())
}

fn set_pipeline_stage_state(
    brief_json: &mut Value,
    current_stage: &str,
    initialized_stages: &[String],
) {
    if !brief_json
        .get("pipeline")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        brief_json["pipeline"] = json!({});
    }
    brief_json["pipeline"]["currentStage"] = Value::String(current_stage.to_string());
    brief_json["pipeline"]["initializedStages"] = Value::Array(
        initialized_stages
            .iter()
            .cloned()
            .map(Value::String)
            .collect(),
    );
}

pub fn initialize_research_stage(root: &Path, stage: &str) -> Result<()> {
    let normalized_stage = normalize_stage(Some(stage));
    let brief_path = pipeline_root(root).join("docs").join("research_brief.json");
    let tasks_path = pipeline_root(root).join("tasks").join("tasks.json");
    let mut tasks = read_tasks(&tasks_path);
    if tasks.iter().any(|task| task.stage == normalized_stage) {
        return Ok(());
    }

    // Load template from brief (or default fallback)
    let brief_value = fs::read_to_string(&brief_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let template = load_pipeline_template(brief_value.as_ref());

    // Generate tasks only for this specific stage
    let stage_tasks = generate_pipeline_tasks(&template, &normalized_stage, &tasks)
        .into_iter()
        .filter(|t| t.stage == normalized_stage)
        .collect::<Vec<_>>();
    tasks.extend(stage_tasks);
    sort_tasks(&mut tasks);
    write_tasks(&tasks_path, &tasks)?;

    let raw_brief = fs::read_to_string(&brief_path)?;
    let mut brief_json = serde_json::from_str::<Value>(&raw_brief)?;
    let initialized_stages = normalize_stage_list(
        brief_json
            .get("pipeline")
            .and_then(|pipeline| pipeline.get("initializedStages"))
            .and_then(|value| value.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(ToOwned::to_owned))
                    .collect::<Vec<_>>()
            })
            .as_deref(),
    );
    let mut next_initialized = initialized_stages;
    if !next_initialized
        .iter()
        .any(|value| value == &normalized_stage)
    {
        next_initialized.push(normalized_stage.clone());
    }
    next_initialized.sort_by_key(|value| stage_index(value));
    next_initialized.dedup();
    set_pipeline_stage_state(&mut brief_json, &normalized_stage, &next_initialized);
    fs::write(&brief_path, serde_json::to_string_pretty(&brief_json)?)?;

    Ok(())
}

/// Regenerate pipeline tasks from the template.
///
/// - If `force` is false, only generates for stages that have no existing tasks.
/// - If `force` is true, replaces existing tasks for the target stage(s).
/// - If `stage` is Some, only regenerates that stage; otherwise all stages from startStage onward.
pub fn regenerate_pipeline_tasks(
    root: &Path,
    force: bool,
    stage: Option<&str>,
) -> Result<Vec<ResearchTask>> {
    let brief_path = pipeline_root(root).join("docs").join("research_brief.json");
    let tasks_path = pipeline_root(root).join("tasks").join("tasks.json");

    let brief_value = fs::read_to_string(&brief_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let template = load_pipeline_template(brief_value.as_ref());

    let start_stage = brief_value
        .as_ref()
        .and_then(|v| v.get("pipeline"))
        .and_then(|p| p.get("startStage"))
        .and_then(|v| v.as_str())
        .map(|s| normalize_stage(Some(s)))
        .unwrap_or_else(|| "survey".into());

    let effective_start = stage
        .map(|s| normalize_stage(Some(s)))
        .unwrap_or(start_stage);

    let mut tasks = read_tasks(&tasks_path);

    if force {
        // Remove existing tasks for the target stages
        let start_idx = stage_index(&effective_start);
        let target_stages: Vec<&str> = if stage.is_some() {
            vec![effective_start.as_str()]
        } else {
            STAGE_ORDER
                .iter()
                .filter(|s| stage_index(s) >= start_idx)
                .copied()
                .collect()
        };
        tasks.retain(|t| !target_stages.contains(&t.stage.as_str()));
    }

    let new_tasks = generate_pipeline_tasks(&template, &effective_start, &tasks);
    let new_task_list = if stage.is_some() {
        let target = normalize_stage(stage);
        new_tasks
            .into_iter()
            .filter(|t| t.stage == target)
            .collect()
    } else {
        new_tasks
    };

    tasks.extend(new_task_list.clone());
    sort_tasks(&mut tasks);
    write_tasks(&tasks_path, &tasks)?;

    Ok(new_task_list)
}

pub fn load_research_snapshot(root: &Path) -> Result<ResearchCanvasSnapshot> {
    let brief_path = pipeline_root(root).join("docs").join("research_brief.json");
    let tasks_path = pipeline_root(root).join("tasks").join("tasks.json");
    let has_instance = root.join("instance.json").exists();
    let has_templates = root.join("AGENTS.md").exists() && root.join("CLAUDE.md").exists();
    let has_skill_views = root.join(".agents").join("skills").exists()
        && root.join(".claude").join("skills").exists();
    let has_brief = brief_path.exists();
    let has_tasks = tasks_path.exists();
    let has_any_scaffold =
        has_instance || has_templates || has_skill_views || has_brief || has_tasks;
    let brief = read_brief(&brief_path);
    let brief_is_invalid = matches!(&brief, BriefReadResult::InvalidJson);

    let bootstrap = {
        let (status, message) = if !has_any_scaffold {
            (
                "needs-bootstrap",
                "This project has no research workflow scaffold yet.",
            )
        } else if !has_brief {
            (
                "missing-brief",
                "The research scaffold exists but the research brief is missing.",
            )
        } else if brief_is_invalid {
            (
                "invalid-brief",
                "The research brief exists but contains invalid JSON. Research brief features, including auto experiment, are unavailable until it is fixed.",
            )
        } else if !has_tasks {
            (
                "missing-tasks",
                "The research scaffold exists but the task list is missing.",
            )
        } else if !has_templates || !has_skill_views || !has_instance {
            (
                "partial",
                "The research scaffold is only partially available and can be repaired.",
            )
        } else {
            ("ready", "Research workflow is ready.")
        };

        ResearchBootstrapState {
            status: status.into(),
            message: message.into(),
            has_instance,
            has_templates,
            has_skill_views,
            has_brief,
            has_tasks,
        }
    };

    let brief_value = brief.value().cloned();
    let brief_topic = brief
        .meta()
        .and_then(|meta| meta.topic.clone())
        .unwrap_or_else(|| {
            root.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("ViewerLeaf Project")
                .to_string()
        });
    let brief_goal = brief
        .meta()
        .and_then(|meta| meta.goal.clone())
        .unwrap_or_else(|| "Turn this topic into a traceable research workflow.".into());
    let system_prompt = brief
        .meta()
        .and_then(|meta| meta.system_prompt.clone())
        .unwrap_or_default();
    let working_memory = brief
        .meta()
        .and_then(|meta| meta.working_memory.clone())
        .unwrap_or_default();
    let start_stage = brief
        .meta()
        .and_then(|meta| meta.pipeline.as_ref())
        .and_then(|pipeline| pipeline.start_stage.as_deref())
        .map(Some)
        .map(normalize_stage)
        .unwrap_or_else(|| "survey".into());
    let initialized_stages = normalize_stage_list(
        brief
            .meta()
            .and_then(|meta| meta.pipeline.as_ref())
            .and_then(|pipeline| pipeline.initialized_stages.as_deref()),
    );

    let mut tasks = read_tasks(&tasks_path)
        .into_iter()
        .map(|mut task| {
            task.status = if task.status.trim().is_empty() {
                "pending".into()
            } else {
                normalize_status(&task.status)
            };
            task.stage = normalize_stage(Some(&task.stage));
            if task.task_prompt.trim().is_empty() {
                task.task_prompt = default_task_prompt(
                    &task.stage,
                    &task.title,
                    &task.description,
                    &task.next_action_prompt,
                );
            }
            if task.agent_entry_label.trim().is_empty() {
                task.agent_entry_label = "Enter Agent".into();
            }
            task
        })
        .collect::<Vec<_>>();
    tasks.sort_by(|left, right| {
        stage_index(&left.stage)
            .cmp(&stage_index(&right.stage))
            .then(status_rank(&left.status).cmp(&status_rank(&right.status)))
            .then(left.id.cmp(&right.id))
    });

    let mut artifact_paths = HashMap::new();
    artifact_paths.insert(
        "survey".into(),
        collect_files_under(root, &survey_root(root)),
    );
    artifact_paths.insert(
        "ideation".into(),
        collect_files_under(root, &ideation_root(root)),
    );
    artifact_paths.insert(
        "experiment".into(),
        collect_files_under(root, &experiment_root(root)),
    );
    artifact_paths.insert("publication".into(), collect_publication_files(root));
    artifact_paths.insert(
        "promotion".into(),
        collect_files_under(root, &promotion_root(root)),
    );

    let done_ids = tasks
        .iter()
        .filter(|task| task_is_done(task))
        .map(|task| task.id.clone())
        .collect::<BTreeSet<_>>();

    let next_task = tasks
        .iter()
        .find(|task| task.status == "in-progress")
        .cloned()
        .or_else(|| tasks.iter().find(|task| task.status == "review").cloned())
        .or_else(|| {
            tasks
                .iter()
                .find(|task| task.status == "pending" && dependency_satisfied(task, &done_ids))
                .cloned()
        })
        .or_else(|| tasks.iter().find(|task| task_is_open(task)).cloned());

    let current_stage = next_task
        .as_ref()
        .map(|task| task.stage.clone())
        .or_else(|| {
            brief
                .meta()
                .and_then(|meta| meta.pipeline.as_ref())
                .and_then(|pipeline| pipeline.current_stage.as_deref())
                .map(Some)
                .map(normalize_stage)
        })
        .or_else(|| {
            STAGE_ORDER
                .iter()
                .find(|stage| !initialized_stages.iter().any(|value| value == *stage))
                .map(|stage| (*stage).to_string())
        })
        .unwrap_or_else(|| start_stage.clone());

    let current_stage_index = stage_index(&current_stage);
    let stage_summaries = STAGE_ORDER
        .iter()
        .map(|stage| {
            let stage_tasks = tasks
                .iter()
                .filter(|task| task.stage == *stage)
                .cloned()
                .collect::<Vec<_>>();
            let mut counts = ResearchTaskCounts::default();
            counts.total = stage_tasks.len();
            for task in &stage_tasks {
                match task.status.as_str() {
                    "done" => counts.done += 1,
                    "in-progress" => counts.in_progress += 1,
                    "review" => counts.review += 1,
                    _ => counts.pending += 1,
                }
            }

            let missing_inputs = stage_tasks
                .iter()
                .flat_map(|task| task.inputs_needed.iter().cloned())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            let mut suggested_skills = stage_tasks
                .iter()
                .flat_map(|task| task.suggested_skills.iter().cloned())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>();
            let bundle_skill_ids = stage_bundle_skill_ids(stage);
            if suggested_skills.is_empty() {
                suggested_skills = bundle_skill_ids.clone();
            }
            let stage_artifacts = artifact_paths.get(*stage).cloned().unwrap_or_default();
            let next_task_id = stage_tasks
                .iter()
                .find(|task| task_is_open(task))
                .map(|task| task.id.clone());
            let is_initialized =
                initialized_stages.iter().any(|value| value == *stage) || !stage_tasks.is_empty();
            let stage_status = if counts.total > 0 && counts.done == counts.total {
                "complete"
            } else if *stage == current_stage {
                "active"
            } else if stage_index(stage) < current_stage_index {
                "complete"
            } else if is_initialized || counts.total > 0 {
                "queued"
            } else {
                "idle"
            };

            ResearchStageSummary {
                stage: (*stage).into(),
                label: stage_label(stage).into(),
                description: stage_description(stage).into(),
                status: stage_status.into(),
                bundle_id: (*stage).into(),
                bundle_label: stage_bundle_label(stage).into(),
                bundle_description: stage_bundle_description(stage).into(),
                bundle_skill_ids: bundle_skill_ids.clone(),
                is_initialized,
                can_initialize: !is_initialized && *stage == current_stage,
                total_tasks: counts.total,
                done_tasks: counts.done,
                artifact_count: stage_artifacts.len(),
                artifact_paths: stage_artifacts,
                missing_inputs,
                suggested_skills,
                next_task_id,
                task_counts: counts,
            }
        })
        .collect::<Vec<_>>();

    Ok(ResearchCanvasSnapshot {
        bootstrap,
        brief: brief_value.clone(),
        tasks,
        current_stage: current_stage.clone(),
        initialized_stages,
        next_task: next_task.clone(),
        stage_summaries,
        artifact_paths,
        handoff_to_writing: current_stage == "publication"
            || next_task
                .as_ref()
                .map(|task| task.stage == "publication")
                .unwrap_or(false),
        pipeline_root: relative_path(root, &pipeline_root(root)),
        instance_path: root
            .join("instance.json")
            .exists()
            .then(|| "instance.json".to_string()),
        brief_topic,
        brief_goal,
        system_prompt,
        working_memory,
        experiment_loop: brief_value.as_ref().map(merged_experiment_loop),
        pipeline_artifacts: collect_pipeline_artifacts(root),
    })
}

fn collect_pipeline_artifacts(root: &Path) -> Vec<PipelineArtifact> {
    let docs_dir = pipeline_root(root).join("docs");
    if !docs_dir.exists() {
        return Vec::new();
    }

    let label_map: &[(&str, &str)] = &[
        ("research_brief.json", "研究摘要 / Research Brief"),
        ("domain_map.md", "领域地图 / Domain Map"),
        ("paper_bank.json", "文献库 / Paper Bank"),
        ("gap_matrix.md", "差距矩阵 / Gap Matrix"),
        ("idea_board.json", "创意板 / Idea Board"),
        ("idea_eval.md", "创意评估 / Idea Evaluation"),
        ("selected_idea.md", "选定方向 / Selected Idea"),
        ("experiment_plan.md", "实验计划 / Experiment Plan"),
        ("result_summary.md", "结果摘要 / Result Summary"),
        ("promo_plan.md", "推广计划 / Promotion Plan"),
    ];

    let mut artifacts = Vec::new();
    for (filename, label) in label_map {
        let file_path = docs_dir.join(filename);
        if file_path.exists() {
            let ext = filename.rsplit('.').next().unwrap_or("txt");
            artifacts.push(PipelineArtifact {
                label: label.to_string(),
                path: relative_path(root, &file_path),
                file_type: ext.to_string(),
            });
        }
    }

    // Also pick up any other files not in the label map
    if let Ok(entries) = fs::read_dir(&docs_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let fname = entry.file_name().to_string_lossy().to_string();
            if label_map.iter().any(|(name, _)| *name == fname) {
                continue;
            }
            if entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                let ext = fname.rsplit('.').next().unwrap_or("txt").to_string();
                artifacts.push(PipelineArtifact {
                    label: fname.clone(),
                    path: relative_path(root, &entry.path()),
                    file_type: ext,
                });
            }
        }
    }

    artifacts
}

pub fn apply_task_suggestion(
    root: &Path,
    request: &ApplyResearchTaskSuggestionRequest,
) -> Result<()> {
    let tasks_path = pipeline_root(root).join("tasks").join("tasks.json");
    let brief_path = pipeline_root(root).join("docs").join("research_brief.json");
    let mut tasks = read_tasks(&tasks_path);
    let operations = request.operations.clone();

    if operations.is_empty() {
        bail!("no task operations provided");
    }

    for operation in operations {
        match operation {
            ResearchTaskPlanOperation::Update { task_id, changes } => {
                let known_task_ids = tasks
                    .iter()
                    .map(|task| task.id.clone())
                    .collect::<BTreeSet<_>>();
                let Some(task) = tasks.iter_mut().find(|task| task.id == task_id) else {
                    bail!("task not found: {task_id}");
                };
                apply_task_changes(task, &changes, &known_task_ids);
            }
            ResearchTaskPlanOperation::Add { task, .. } => {
                let custom_task = build_custom_task(&tasks, &task)?;
                tasks.push(custom_task);
            }
            ResearchTaskPlanOperation::Remove { task_id } => {
                let Some(index) = tasks.iter().position(|task| task.id == task_id) else {
                    continue;
                };
                if matches!(tasks[index].status.as_str(), "done" | "in-progress") {
                    tasks[index].status = "cancelled".into();
                    tasks[index].last_updated_at = iso_now();
                } else {
                    tasks.remove(index);
                    for task in &mut tasks {
                        task.dependencies
                            .retain(|dependency| dependency != &task_id);
                    }
                }
            }
        }
    }

    sort_tasks(&mut tasks);
    write_tasks(&tasks_path, &tasks)?;

    if let Some(working_memory) = request
        .working_memory
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        let raw_brief = fs::read_to_string(&brief_path)?;
        let mut brief_json = serde_json::from_str::<Value>(&raw_brief)?;
        brief_json["workingMemory"] = Value::String(working_memory.to_string());
        fs::write(&brief_path, serde_json::to_string_pretty(&brief_json)?)?;
    }

    Ok(())
}

fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_temp_project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("viewerleaf-{name}-{}", iso_now()));
        fs::create_dir_all(&dir).expect("failed to create temp dir");
        dir
    }

    fn make_app_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("viewerleaf-app-root-{}", iso_now()));
        fs::create_dir_all(dir.join("skills")).expect("failed to create app skills dir");
        for skill_id in research_scope_skill_ids() {
            let skill_dir = dir.join("skills").join(&skill_id);
            fs::create_dir_all(&skill_dir).expect("failed to create skill dir");
            fs::write(
                skill_dir.join("SKILL.md"),
                format!(
                    "---\nid: {skill_id}\nname: {skill_id}\nsummary: summary\nstages: [\"survey\"]\n---\n\n# {skill_id}\n"
                ),
            )
            .expect("failed to write skill");
        }
        dir
    }

    #[test]
    fn scaffold_is_idempotent_and_preserves_main_tex() {
        let root = make_temp_project("research-idempotent");
        let app_root = make_app_root();
        fs::create_dir_all(root.join(".viewerleaf")).expect("viewerleaf dir");
        fs::write(root.join("main.tex"), "% existing main tex").expect("main tex");

        ensure_research_scaffold(&app_root, &root, Some("survey")).expect("first scaffold");
        ensure_research_scaffold(&app_root, &root, Some("publication")).expect("second scaffold");

        let main_tex = fs::read_to_string(root.join("main.tex")).expect("read main tex");
        assert_eq!(main_tex, "% existing main tex");
        assert!(root.join("AGENTS.md").exists());
        assert!(root.join("CLAUDE.md").exists());
        assert!(root.join(".viewerleaf/research/Survey/references").exists());
        assert!(root.join(".pipeline/docs/research_brief.json").exists());
        assert!(root.join(".pipeline/tasks/tasks.json").exists());
        assert!(root.join("instance.json").exists());
    }

    #[test]
    fn publication_points_to_project_root() {
        let root = make_temp_project("research-instance");
        let app_root = make_app_root();
        ensure_research_scaffold(&app_root, &root, Some("publication")).expect("scaffold");

        let instance = read_json_file(&root.join("instance.json")).expect("instance json");
        let publication = instance
            .get("Publication")
            .and_then(|value| value.get("paper"))
            .and_then(|value| value.as_str())
            .expect("publication paper path");

        assert_eq!(publication, root.to_string_lossy());
    }

    #[test]
    fn snapshot_derives_ready_state_and_stage_summary() {
        let root = make_temp_project("research-snapshot");
        let app_root = make_app_root();
        ensure_research_scaffold(&app_root, &root, Some("publication")).expect("scaffold");

        let snapshot = load_research_snapshot(&root).expect("research snapshot");
        assert_eq!(snapshot.bootstrap.status, "ready");
        assert_eq!(snapshot.current_stage, "publication");
        assert!(snapshot.handoff_to_writing);
        assert_eq!(snapshot.stage_summaries.len(), STAGE_ORDER.len());
        assert_eq!(
            snapshot
                .experiment_loop
                .as_ref()
                .and_then(|value| value.get("enabled"))
                .and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn default_brief_includes_experiment_loop() {
        let brief = default_research_brief("demo", "survey");
        let loop_config = brief
            .get("experimentLoop")
            .expect("default experiment loop");
        assert_eq!(
            loop_config.get("enabled").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            loop_config.get("maxIterations").and_then(Value::as_u64),
            Some(10)
        );
    }

    #[test]
    fn snapshot_backfills_partial_experiment_loop() {
        let root = make_temp_project("research-experiment-loop-backfill");
        let app_root = make_app_root();
        ensure_research_scaffold(&app_root, &root, Some("experiment")).expect("scaffold");

        let brief_path = root.join(".pipeline/docs/research_brief.json");
        fs::write(
            &brief_path,
            serde_json::to_string_pretty(&json!({
                "topic": "legacy brief",
                "goal": "legacy goal",
                "pipeline": {
                    "startStage": "experiment",
                    "currentStage": "experiment",
                    "initializedStages": ["survey", "ideation", "experiment"]
                },
                "experimentLoop": {
                    "enabled": true,
                    "maxIterations": 5
                }
            }))
            .expect("serialize brief"),
        )
        .expect("write brief");

        let snapshot = load_research_snapshot(&root).expect("snapshot");
        let loop_config = snapshot.experiment_loop.expect("experiment loop");
        assert_eq!(
            loop_config.get("enabled").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            loop_config.get("maxIterations").and_then(Value::as_u64),
            Some(5)
        );
        assert_eq!(
            loop_config.get("maxFailures").and_then(Value::as_u64),
            Some(3)
        );
        assert_eq!(
            loop_config.get("successMetric").and_then(Value::as_str),
            Some("primaryMetric")
        );
    }

    #[test]
    fn invalid_brief_sets_bootstrap_error_and_hides_experiment_loop() {
        let root = make_temp_project("research-invalid-brief");
        let app_root = make_app_root();
        ensure_research_scaffold(&app_root, &root, Some("experiment")).expect("scaffold");

        fs::write(
            root.join(".pipeline/docs/research_brief.json"),
            "{ invalid json }",
        )
        .expect("write invalid brief");

        let snapshot = load_research_snapshot(&root).expect("snapshot");
        assert_eq!(snapshot.bootstrap.status, "invalid-brief");
        assert!(snapshot.bootstrap.message.contains("invalid JSON"));
        assert!(snapshot.experiment_loop.is_none());
    }

    #[test]
    fn recommendations_use_stage_map() {
        let skills = recommended_skills("publication", "writing");
        assert!(skills.iter().any(|skill| skill == "inno-paper-writing"));
        assert!(skills.iter().any(|skill| skill == "ml-paper-writing"));
    }

    #[test]
    fn template_loads_and_generates_survey_tasks() {
        // Test 1: built-in template loads
        let template = load_default_template();
        assert!(template.stages.contains_key("survey"), "template must contain survey stage");
        let survey = &template.stages["survey"];
        assert!(!survey.task_blueprints.is_empty(), "survey must have blueprints");

        // Test 2: generate tasks from template
        let tasks = generate_pipeline_tasks(&template, "survey", &[]);
        assert!(!tasks.is_empty(), "should generate at least one task for survey (got {} tasks)", tasks.len());
        assert!(tasks.iter().any(|t| t.stage == "survey"), "should have survey tasks");

        // Test 3: round-trip through brief serialization
        let brief = default_research_brief("test", "survey");
        let template_from_brief = load_pipeline_template(Some(&brief));
        assert!(template_from_brief.stages.contains_key("survey"), "brief must round-trip survey stage");
        let brief_survey = &template_from_brief.stages["survey"];
        assert!(!brief_survey.task_blueprints.is_empty(), "brief survey must have blueprints on round-trip");
    }

    #[test]
    fn task_suggestion_can_add_custom_task() {
        let root = make_temp_project("research-add-task");
        let app_root = make_app_root();
        ensure_research_scaffold(&app_root, &root, Some("survey")).expect("scaffold");
        initialize_research_stage(&root, "survey").expect("initialize survey");

        // Get the first generated task ID (dynamic, template-driven)
        let initial_snapshot = load_research_snapshot(&root).expect("initial snapshot");
        let first_task_id = initial_snapshot
            .tasks
            .first()
            .expect("should have at least one survey task")
            .id
            .clone();

        apply_task_suggestion(
            &root,
            &ApplyResearchTaskSuggestionRequest {
                operations: vec![ResearchTaskPlanOperation::Add {
                    task: ResearchTaskDraft {
                        title: "Check venue scope".into(),
                        stage: "survey".into(),
                        description: Some("Verify target venue boundaries.".into()),
                        priority: Some("high".into()),
                        dependencies: Some(vec![first_task_id.clone()]),
                        next_action_prompt: Some(
                            "Review venue CFP and collect constraints.".into(),
                        ),
                        ..ResearchTaskDraft::default()
                    },
                    after_task_id: None,
                }],
                working_memory: None,
            },
        )
        .expect("apply task suggestion");

        let snapshot = load_research_snapshot(&root).expect("snapshot");
        let custom_task = snapshot
            .tasks
            .iter()
            .find(|task| task.title == "Check venue scope")
            .expect("custom task");
        assert_eq!(custom_task.stage, "survey");
        assert_eq!(custom_task.dependencies, vec![first_task_id]);
    }

    #[test]
    fn task_suggestion_can_remove_pending_task() {
        let root = make_temp_project("research-remove-task");
        let app_root = make_app_root();
        ensure_research_scaffold(&app_root, &root, Some("survey")).expect("scaffold");
        initialize_research_stage(&root, "survey").expect("initialize survey");

        // Get the second generated task ID
        let initial_snapshot = load_research_snapshot(&root).expect("initial snapshot");
        assert!(initial_snapshot.tasks.len() >= 2, "should have at least 2 survey tasks");
        let second_task_id = initial_snapshot.tasks[1].id.clone();

        apply_task_suggestion(
            &root,
            &ApplyResearchTaskSuggestionRequest {
                operations: vec![ResearchTaskPlanOperation::Remove {
                    task_id: second_task_id.clone(),
                }],
                working_memory: None,
            },
        )
        .expect("remove task");

        let snapshot = load_research_snapshot(&root).expect("snapshot");
        assert!(snapshot.tasks.iter().all(|task| task.id != second_task_id));
    }
}
