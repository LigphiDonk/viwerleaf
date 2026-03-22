use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use rusqlite::{params, Connection};
use serde_json::Value as JsonValue;
use serde_yaml::Value as YamlValue;
use walkdir::WalkDir;

use crate::models::{AgentTaskContext, SkillManifest, SkillResourceFlags, SkillUpstream};

#[derive(Debug, Clone)]
struct ParsedSkillFile {
    manifest: SkillManifest,
    body: String,
}

pub fn global_skill_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home_dir) = dirs::home_dir() {
        roots.push(home_dir.join(".claude").join("skills"));
        roots.push(home_dir.join(".agents").join("skills"));
    }
    roots
}

pub fn refresh_skill_registry(
    conn: &Connection,
    app_root: &Path,
    project_root: Option<&Path>,
) -> Result<(), String> {
    sync_skill_source(conn, &[app_root.join("skills")], "builtin")?;
    sync_skill_source(conn, &global_skill_roots(), "local")?;

    let project_roots = project_root
        .map(crate::services::research::project_skill_roots)
        .unwrap_or_default();
    sync_skill_source(conn, &project_roots, "project")?;
    Ok(())
}

pub fn discover_skills(
    conn: &Connection,
    search_dirs: &[PathBuf],
    source: &str,
) -> Result<(), String> {
    for dir in search_dirs {
        if !dir.exists() {
            continue;
        }

        for entry in WalkDir::new(dir)
            .min_depth(1)
            .max_depth(2)
            .into_iter()
            .filter_map(|entry| entry.ok())
        {
            if !entry.file_type().is_file() || entry.file_name() != "SKILL.md" {
                continue;
            }

            let Some(skill_dir) = entry.path().parent() else {
                continue;
            };
            let content = fs::read_to_string(entry.path()).map_err(|err| err.to_string())?;
            let Some(parsed) = parse_skill_md(&content, skill_dir, source) else {
                continue;
            };
            install_skill(conn, &parsed.manifest)?;
        }
    }

    Ok(())
}

fn sync_skill_source(
    conn: &Connection,
    search_dirs: &[PathBuf],
    source: &str,
) -> Result<(), String> {
    prune_skill_source(conn, search_dirs, source)?;
    discover_skills(conn, search_dirs, source)
}

pub fn list_skills(conn: &Connection) -> Result<Vec<SkillManifest>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT
                id, name, version, stages_json, tools_json, description, summary, primary_intent,
                intents_json, capabilities_json, domains_json, keywords_json, source, status,
                upstream_json, resource_flags_json, dir_path, is_enabled
             FROM skills
             ORDER BY created_at, name",
        )
        .map_err(|err| err.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let stages_json: String = row.get(3)?;
            let tools_json: String = row.get(4)?;
            let intents_json: String = row.get(8)?;
            let capabilities_json: String = row.get(9)?;
            let domains_json: String = row.get(10)?;
            let keywords_json: String = row.get(11)?;
            let upstream_json: String = row.get(14)?;
            let resource_flags_json: String = row.get(15)?;
            Ok(SkillManifest {
                id: row.get(0)?,
                name: row.get(1)?,
                version: row.get(2)?,
                stages: parse_json_vec(&stages_json),
                tools: parse_json_vec(&tools_json),
                description: row.get(5)?,
                summary: row.get(6)?,
                primary_intent: row.get(7)?,
                intents: parse_json_vec(&intents_json),
                capabilities: parse_json_vec(&capabilities_json),
                domains: parse_json_vec(&domains_json),
                keywords: parse_json_vec(&keywords_json),
                source: row.get(12)?,
                status: row.get(13)?,
                upstream: parse_upstream(&upstream_json),
                resource_flags: parse_resource_flags(&resource_flags_json),
                dir_path: row.get(16)?,
                is_enabled: row.get::<_, i32>(17)? != 0,
            })
        })
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

pub fn install_skill(conn: &Connection, skill: &SkillManifest) -> Result<(), String> {
    let stages_json = serde_json::to_string(&skill.stages).unwrap_or_else(|_| "[]".into());
    let tools_json = serde_json::to_string(&skill.tools).unwrap_or_else(|_| "[]".into());
    let intents_json = serde_json::to_string(&skill.intents).unwrap_or_else(|_| "[]".into());
    let capabilities_json =
        serde_json::to_string(&skill.capabilities).unwrap_or_else(|_| "[]".into());
    let domains_json = serde_json::to_string(&skill.domains).unwrap_or_else(|_| "[]".into());
    let keywords_json = serde_json::to_string(&skill.keywords).unwrap_or_else(|_| "[]".into());
    let upstream_json = serde_json::to_string(&skill.upstream).unwrap_or_else(|_| "{}".into());
    let resource_flags_json =
        serde_json::to_string(&skill.resource_flags).unwrap_or_else(|_| "{}".into());

    conn.execute(
        "INSERT INTO skills (
            id, name, version, stages_json, tools_json, description, summary, primary_intent,
            intents_json, capabilities_json, domains_json, keywords_json, source, status,
            upstream_json, resource_flags_json, dir_path, is_enabled
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
         ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            version=excluded.version,
            stages_json=excluded.stages_json,
            tools_json=excluded.tools_json,
            description=excluded.description,
            summary=excluded.summary,
            primary_intent=excluded.primary_intent,
            intents_json=excluded.intents_json,
            capabilities_json=excluded.capabilities_json,
            domains_json=excluded.domains_json,
            keywords_json=excluded.keywords_json,
            source=excluded.source,
            status=excluded.status,
            upstream_json=excluded.upstream_json,
            resource_flags_json=excluded.resource_flags_json,
            dir_path=excluded.dir_path,
            is_enabled=excluded.is_enabled",
        params![
            skill.id,
            skill.name,
            skill.version,
            stages_json,
            tools_json,
            skill.description,
            skill.summary,
            skill.primary_intent,
            intents_json,
            capabilities_json,
            domains_json,
            keywords_json,
            skill.source,
            skill.status,
            upstream_json,
            resource_flags_json,
            skill.dir_path,
            skill.is_enabled as i32
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn enable_skill(
    conn: &Connection,
    skill_id: &str,
    enabled: bool,
) -> Result<Option<SkillManifest>, String> {
    conn.execute(
        "UPDATE skills SET is_enabled=?2 WHERE id=?1",
        params![skill_id, enabled as i32],
    )
    .map_err(|err| err.to_string())?;

    list_skills(conn).map(|skills| skills.into_iter().find(|skill| skill.id == skill_id))
}

pub fn load_skill_prompts(
    conn: &Connection,
    vendor: &str,
    project_root: &Path,
    skill_ids: &[String],
    task_context: Option<&AgentTaskContext>,
) -> Result<String, String> {
    let skills = resolve_enabled_skills(conn, skill_ids)?;
    let mut sections = Vec::new();

    let stage_context = build_project_stage_context(project_root, task_context);
    if !stage_context.is_empty() {
        sections.push(format!(
            "[[VIEWERLEAF_STAGE_CONTEXT]]\n{}\n[[/VIEWERLEAF_STAGE_CONTEXT]]",
            stage_context
        ));
    }

    if let Ok(project_agents) = fs::read_to_string(project_root.join("AGENTS.md")) {
        let trimmed = project_agents.trim();
        if !trimmed.is_empty() {
            sections.push(format!(
                "[[PROJECT_AGENTS_MD]]\n{}\n[[/PROJECT_AGENTS_MD]]",
                trimmed
            ));
        }
    }

    for skill in skills {
        let skill_md = Path::new(&skill.dir_path).join("SKILL.md");
        let Ok(content) = fs::read_to_string(&skill_md) else {
            continue;
        };
        let Some(parsed) = parse_skill_md(&content, Path::new(&skill.dir_path), &skill.source)
        else {
            continue;
        };
        sections.push(format!(
            "[[SKILL:{}]]\nname: {}\npath: {}\nsummary: {}\n\n{}\n[[/SKILL:{}]]",
            parsed.manifest.id,
            parsed.manifest.name,
            parsed.manifest.dir_path,
            parsed.manifest.summary,
            parsed.body.trim(),
            parsed.manifest.id
        ));
    }

    if sections.is_empty() {
        return Ok(String::new());
    }

    let preamble = format!(
        "Treat the following sections as {} system-level ViewerLeaf instructions. Do not repeat the section markers back to the user.",
        if vendor.eq_ignore_ascii_case("codex") {
            "Codex"
        } else {
            "Claude Code"
        }
    );

    Ok(format!("{preamble}\n\n{}", sections.join("\n\n---\n\n")))
}

pub fn import_skill_from_git(
    conn: &Connection,
    app_data_dir: &Path,
    git_url: &str,
) -> Result<SkillManifest, String> {
    let skills_dir = app_data_dir.join("skills");
    fs::create_dir_all(&skills_dir).map_err(|e| e.to_string())?;

    let repo_name = git_url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("skill")
        .trim_end_matches(".git");
    let dest = skills_dir.join(repo_name);

    if dest.exists() {
        let status = Command::new("git")
            .args(["pull"])
            .current_dir(&dest)
            .status()
            .map_err(|e| format!("git pull failed: {e}"))?;
        if !status.success() {
            return Err("git pull failed".into());
        }
    } else {
        let status = Command::new("git")
            .args(["clone", "--depth", "1", git_url])
            .arg(&dest)
            .status()
            .map_err(|e| format!("git clone failed: {e}"))?;
        if !status.success() {
            return Err("git clone failed".into());
        }
    }

    let skill_md = dest.join("SKILL.md");
    if !skill_md.exists() {
        let _ = fs::remove_dir_all(&dest);
        return Err("No SKILL.md found in repository".into());
    }

    let content = fs::read_to_string(&skill_md).map_err(|e| e.to_string())?;
    let parsed =
        parse_skill_md(&content, &dest, "git").ok_or("Failed to parse SKILL.md frontmatter")?;
    let mut manifest = parsed.manifest;
    manifest.source = "git".into();
    manifest.is_enabled = true;
    install_skill(conn, &manifest)?;
    Ok(manifest)
}

pub fn remove_skill(conn: &Connection, skill_id: &str, delete_files: bool) -> Result<(), String> {
    if delete_files {
        let dir_path: String = conn
            .query_row(
                "SELECT dir_path FROM skills WHERE id=?1",
                params![skill_id],
                |row| row.get(0),
            )
            .unwrap_or_default();
        if !dir_path.is_empty() {
            let _ = fs::remove_dir_all(&dir_path);
        }
    }

    conn.execute("DELETE FROM skills WHERE id=?1", params![skill_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn prune_skill_source(
    conn: &Connection,
    search_dirs: &[PathBuf],
    source: &str,
) -> Result<(), String> {
    let normalized_roots = search_dirs
        .iter()
        .filter(|root| root.exists())
        .map(|root| root.canonicalize().unwrap_or_else(|_| root.clone()))
        .collect::<Vec<_>>();

    let mut stmt = conn
        .prepare("SELECT id, dir_path FROM skills WHERE source=?1")
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![source], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| err.to_string())?;

    for row in rows {
        let (skill_id, dir_path) = row.map_err(|err| err.to_string())?;
        let current_dir = PathBuf::from(&dir_path);
        let canonical_dir = current_dir
            .canonicalize()
            .unwrap_or_else(|_| current_dir.clone());
        let is_under_root = normalized_roots
            .iter()
            .any(|root| canonical_dir.starts_with(root));
        let has_skill_md = canonical_dir.join("SKILL.md").is_file();

        if !is_under_root || !has_skill_md {
            conn.execute("DELETE FROM skills WHERE id=?1", params![skill_id])
                .map_err(|err| err.to_string())?;
        }
    }

    Ok(())
}

fn parse_skill_md(
    content: &str,
    skill_dir: &Path,
    default_source: &str,
) -> Option<ParsedSkillFile> {
    let body = extract_body(content)?.trim().to_string();
    let frontmatter = extract_frontmatter(content)?;
    let yaml = serde_yaml::from_str::<YamlValue>(&frontmatter).ok()?;

    let name = yaml_string(&yaml, "name")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            skill_dir
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("skill")
                .to_string()
        });
    let id = yaml_string(&yaml, "id")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| slugify(&name));
    let version = yaml_string(&yaml, "version")
        .or_else(|| yaml_string_at_path(&yaml, &["metadata", "version"]))
        .unwrap_or_else(|| "1.0.0".into());
    let stages = yaml_vec(&yaml, "stages");
    let tools = yaml_vec(&yaml, "tools");
    let summary = yaml_string(&yaml, "summary")
        .or_else(|| yaml_string(&yaml, "description"))
        .unwrap_or_else(|| first_paragraph(&body));
    let description = yaml_string(&yaml, "description").unwrap_or_else(|| first_sentence(&summary));
    let primary_intent = yaml_string(&yaml, "primaryIntent")
        .or_else(|| yaml_string(&yaml, "primary_intent"))
        .unwrap_or_default();
    let source = yaml_string(&yaml, "source")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_source.to_string());
    let status = yaml_string(&yaml, "status").unwrap_or_else(|| "verified".into());
    let upstream = yaml_object(&yaml, "upstream").map(|value| SkillUpstream {
        repo: yaml_string_from_value(&value, "repo").unwrap_or_default(),
        path: yaml_string_from_value(&value, "path").unwrap_or_default(),
        revision: yaml_string_from_value(&value, "revision").unwrap_or_default(),
    });
    let resource_flags = yaml_object(&yaml, "resourceFlags")
        .or_else(|| yaml_object(&yaml, "resource_flags"))
        .map(parse_resource_flags_from_yaml)
        .unwrap_or_else(|| detect_resource_flags(skill_dir));

    Some(ParsedSkillFile {
        manifest: SkillManifest {
            id,
            name,
            version,
            stages,
            tools,
            description,
            summary,
            primary_intent,
            intents: yaml_vec_any(&yaml, &["intents"]),
            capabilities: yaml_vec_any(&yaml, &["capabilities"]),
            domains: yaml_vec_any(&yaml, &["domains"]),
            keywords: yaml_vec_any(&yaml, &["keywords"]),
            source,
            status,
            upstream,
            resource_flags,
            dir_path: skill_dir.to_string_lossy().to_string(),
            is_enabled: true,
        },
        body,
    })
}

fn extract_frontmatter(content: &str) -> Option<String> {
    let normalized = content.replace("\r\n", "\n");
    if !normalized.starts_with("---\n") {
        return None;
    }
    let closing_index = normalized[4..].find("\n---\n")?;
    Some(normalized[4..4 + closing_index].to_string())
}

fn extract_body(content: &str) -> Option<String> {
    let normalized = content.replace("\r\n", "\n");
    if !normalized.starts_with("---\n") {
        return Some(normalized.trim().to_string());
    }
    let closing_index = normalized[4..].find("\n---\n")?;
    Some(normalized[4 + closing_index + 5..].trim().to_string())
}

fn resolve_enabled_skills(
    conn: &Connection,
    skill_ids: &[String],
) -> Result<Vec<SkillManifest>, String> {
    let all_skills = list_skills(conn)?;
    let mut requested = if skill_ids.is_empty() {
        all_skills
            .iter()
            .filter(|skill| skill.is_enabled)
            .map(|skill| skill.id.clone())
            .collect::<Vec<_>>()
    } else {
        skill_ids.to_vec()
    };
    requested.sort();
    requested.dedup();

    Ok(all_skills
        .into_iter()
        .filter(|skill| skill.is_enabled && requested.iter().any(|id| id == &skill.id))
        .collect())
}

fn build_project_stage_context(
    project_root: &Path,
    task_context: Option<&AgentTaskContext>,
) -> String {
    let brief_path = project_root
        .join(".pipeline")
        .join("docs")
        .join("research_brief.json");
    let tasks_path = project_root
        .join(".pipeline")
        .join("tasks")
        .join("tasks.json");

    let mut lines = Vec::new();
    let mut current_stage_value = String::new();

    if let Ok(raw) = fs::read_to_string(brief_path) {
        if let Ok(value) = serde_json::from_str::<JsonValue>(&raw) {
            let topic = value
                .get("topic")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let goal = value
                .get("goal")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let system_prompt = value
                .get("systemPrompt")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let working_memory = value
                .get("workingMemory")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let pipeline = value.get("pipeline").cloned().unwrap_or(JsonValue::Null);
            let current_stage = pipeline
                .get("currentStage")
                .and_then(|value| value.as_str())
                .or_else(|| pipeline.get("startStage").and_then(|value| value.as_str()))
                .unwrap_or("");
            if !topic.is_empty() {
                lines.push(format!("topic: {topic}"));
            }
            if !goal.is_empty() {
                lines.push(format!("goal: {goal}"));
            }
            if !current_stage.is_empty() {
                current_stage_value = current_stage.to_string();
                lines.push(format!("currentStage: {current_stage}"));
            }
            if !system_prompt.is_empty() {
                lines.push(format!("globalSystemPrompt: {system_prompt}"));
            }
            if !working_memory.is_empty() {
                lines.push(format!("workingMemory: {working_memory}"));
            }
            if let Some(rules) = value
                .get("interactionRules")
                .and_then(|value| value.as_array())
            {
                let rule_lines = rules
                    .iter()
                    .filter_map(|rule| rule.as_str())
                    .map(|rule| format!("- {rule}"))
                    .collect::<Vec<_>>();
                if !rule_lines.is_empty() {
                    lines.push("interactionRules:".into());
                    lines.extend(rule_lines);
                }
            }
        }
    }

    if let Ok(raw) = fs::read_to_string(tasks_path) {
        if let Ok(value) = serde_json::from_str::<JsonValue>(&raw) {
            if let Some(tasks) = value.get("tasks").and_then(|value| value.as_array()) {
                let current_stage_tasks = if current_stage_value.is_empty() {
                    Vec::new()
                } else {
                    tasks
                        .iter()
                        .filter(|task| {
                            task.get("stage")
                                .and_then(|value| value.as_str())
                                .map(|stage| stage == current_stage_value)
                                .unwrap_or(false)
                                && task
                                    .get("status")
                                    .and_then(|value| value.as_str())
                                    .map(|status| {
                                        matches!(status, "" | "pending" | "in-progress" | "review")
                                    })
                                    .unwrap_or(true)
                        })
                        .filter_map(|task| task.get("title").and_then(|value| value.as_str()))
                        .take(3)
                        .map(ToOwned::to_owned)
                        .collect::<Vec<_>>()
                };
                if !current_stage_tasks.is_empty() {
                    lines.push(format!(
                        "currentStageOpenTasks: {}",
                        current_stage_tasks.join(" | ")
                    ));
                }
                if let Some(next_task) = tasks.iter().find(|task| {
                    task.get("status")
                        .and_then(|status| status.as_str())
                        .map(|status| matches!(status, "" | "pending" | "in-progress" | "review"))
                        .unwrap_or(true)
                }) {
                    let title = next_task
                        .get("title")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    let task_type = next_task
                        .get("taskType")
                        .or_else(|| next_task.get("task_type"))
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    let stage = next_task
                        .get("stage")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    if !title.is_empty() {
                        lines.push(format!("nextTask: {title}"));
                    }
                    if !stage.is_empty() {
                        lines.push(format!("nextTaskStage: {stage}"));
                    }
                    if !task_type.is_empty() {
                        lines.push(format!("nextTaskType: {task_type}"));
                    }
                }
            }
        }
    }

    if let Some(task) = task_context {
        lines.push("taskMode: true".into());
        lines.push(format!("activeTaskId: {}", task.task_id));
        lines.push(format!("activeTaskStage: {}", task.stage));
        lines.push(format!("activeTaskTitle: {}", task.title));
        if !task.description.trim().is_empty() {
            lines.push(format!(
                "activeTaskDescription: {}",
                task.description.trim()
            ));
        }
        if !task.next_action_prompt.trim().is_empty() {
            lines.push(format!(
                "activeTaskNextAction: {}",
                task.next_action_prompt.trim()
            ));
        }
        if !task.task_prompt.trim().is_empty() {
            lines.push(format!("activeTaskPrompt: {}", task.task_prompt.trim()));
        }
        if !task.context_notes.trim().is_empty() {
            lines.push(format!(
                "activeTaskContextNotes: {}",
                task.context_notes.trim()
            ));
        }
        if !task.inputs_needed.is_empty() {
            lines.push(format!(
                "activeTaskInputs: {}",
                task.inputs_needed.join(" | ")
            ));
        }
        if !task.suggested_skills.is_empty() {
            lines.push(format!(
                "activeTaskSkills: {}",
                task.suggested_skills.join(", ")
            ));
        }
        if !task.artifact_paths.is_empty() {
            lines.push(format!(
                "activeTaskArtifacts: {}",
                task.artifact_paths.join(", ")
            ));
        }
        lines.push("taskUpdateProtocol: When the active task or project plan materially changes, append a fenced code block with language `viewerleaf_task_update`. Use JSON with keys `reason`, optional `confidence`, optional `workingMemory`, and either legacy `taskId` + `changes` or `operations`. `operations` is an array of plan actions: `{ \"type\": \"update\", \"taskId\": \"...\", \"changes\": { ... } }`, `{ \"type\": \"add\", \"task\": { \"title\": \"...\", \"stage\": \"survey|ideation|experiment|publication|promotion\", optional \"description\", \"priority\", \"dependencies\", \"taskType\", \"inputsNeeded\", \"suggestedSkills\", \"nextActionPrompt\" } }`, or `{ \"type\": \"remove\", \"taskId\": \"...\" }`. Prefer updating only the active task unless project evidence clearly requires replanning. Do not remove completed tasks.".into());
    } else {
        lines.push("taskMode: false".into());
    }

    lines.join("\n")
}

fn detect_resource_flags(skill_dir: &Path) -> SkillResourceFlags {
    SkillResourceFlags {
        has_references: skill_dir.join("references").is_dir(),
        has_scripts: skill_dir.join("scripts").is_dir(),
        has_templates: skill_dir.join("templates").is_dir(),
        has_assets: skill_dir.join("assets").is_dir(),
        reference_count: count_files(&skill_dir.join("references")),
        script_count: count_files(&skill_dir.join("scripts")),
        template_count: count_files(&skill_dir.join("templates")),
        asset_count: count_files(&skill_dir.join("assets")),
        optional_scripts: skill_dir.join("scripts").is_dir(),
    }
}

fn count_files(path: &Path) -> usize {
    if !path.exists() {
        return 0;
    }

    WalkDir::new(path)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .count()
}

fn parse_resource_flags_from_yaml(value: YamlValue) -> SkillResourceFlags {
    SkillResourceFlags {
        has_references: yaml_bool_from_value(&value, "hasReferences"),
        has_scripts: yaml_bool_from_value(&value, "hasScripts"),
        has_templates: yaml_bool_from_value(&value, "hasTemplates"),
        has_assets: yaml_bool_from_value(&value, "hasAssets"),
        reference_count: yaml_usize_from_value(&value, "referenceCount"),
        script_count: yaml_usize_from_value(&value, "scriptCount"),
        template_count: yaml_usize_from_value(&value, "templateCount"),
        asset_count: yaml_usize_from_value(&value, "assetCount"),
        optional_scripts: yaml_bool_from_value(&value, "optionalScripts"),
    }
}

fn parse_upstream(raw: &str) -> Option<SkillUpstream> {
    if raw.trim().is_empty() || raw.trim() == "{}" {
        return None;
    }
    serde_json::from_str(raw).ok()
}

fn parse_resource_flags(raw: &str) -> SkillResourceFlags {
    if raw.trim().is_empty() || raw.trim() == "{}" {
        return SkillResourceFlags::default();
    }
    serde_json::from_str(raw).unwrap_or_default()
}

fn parse_json_vec(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn slugify(input: &str) -> String {
    let mut out = String::new();
    let mut previous_dash = false;
    for ch in input.chars() {
        let normalized = if ch.is_ascii_alphanumeric() {
            ch.to_ascii_lowercase()
        } else {
            '-'
        };
        if normalized == '-' {
            if !previous_dash {
                out.push('-');
            }
            previous_dash = true;
        } else {
            out.push(normalized);
            previous_dash = false;
        }
    }
    out.trim_matches('-').to_string()
}

fn first_paragraph(input: &str) -> String {
    input
        .split("\n\n")
        .map(str::trim)
        .find(|item| !item.is_empty())
        .unwrap_or("")
        .replace('\n', " ")
}

fn first_sentence(input: &str) -> String {
    let compact = input.replace('\n', " ").trim().to_string();
    if let Some((sentence, _)) = compact.split_once(". ") {
        format!("{sentence}.")
    } else {
        compact
    }
}

fn yaml_string(root: &YamlValue, key: &str) -> Option<String> {
    root.get(key).and_then(yaml_value_to_string)
}

fn yaml_string_at_path(root: &YamlValue, path: &[&str]) -> Option<String> {
    let mut current = root;
    for segment in path {
        current = current.get(*segment)?;
    }
    yaml_value_to_string(current)
}

fn yaml_vec(root: &YamlValue, key: &str) -> Vec<String> {
    root.get(key).map(yaml_value_to_vec).unwrap_or_default()
}

fn yaml_vec_any(root: &YamlValue, path: &[&str]) -> Vec<String> {
    let mut current = root;
    for segment in path {
        let Some(next) = current.get(*segment) else {
            return Vec::new();
        };
        current = next;
    }
    yaml_value_to_vec(current)
}

fn yaml_object(root: &YamlValue, key: &str) -> Option<YamlValue> {
    root.get(key).cloned()
}

fn yaml_string_from_value(value: &YamlValue, key: &str) -> Option<String> {
    value.get(key).and_then(yaml_value_to_string)
}

fn yaml_bool_from_value(value: &YamlValue, key: &str) -> bool {
    value
        .get(key)
        .and_then(YamlValue::as_bool)
        .unwrap_or_default()
}

fn yaml_usize_from_value(value: &YamlValue, key: &str) -> usize {
    value
        .get(key)
        .and_then(YamlValue::as_u64)
        .unwrap_or_default() as usize
}

fn yaml_value_to_string(value: &YamlValue) -> Option<String> {
    match value {
        YamlValue::String(text) => Some(text.trim().to_string()),
        YamlValue::Number(number) => Some(number.to_string()),
        YamlValue::Bool(boolean) => Some(boolean.to_string()),
        _ => None,
    }
}

fn yaml_value_to_vec(value: &YamlValue) -> Vec<String> {
    match value {
        YamlValue::Sequence(items) => items.iter().filter_map(yaml_value_to_string).collect(),
        YamlValue::String(text) => text
            .split(',')
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::{detect_resource_flags, load_skill_prompts, parse_skill_md, prune_skill_source};
    use rusqlite::Connection;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("viewerleaf-skill-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("failed to create temp dir");
        path
    }

    fn create_skills_table(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE skills (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                version TEXT NOT NULL DEFAULT '1.0.0',
                stages_json TEXT NOT NULL DEFAULT '[]',
                tools_json TEXT NOT NULL DEFAULT '[]',
                description TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL DEFAULT '',
                primary_intent TEXT NOT NULL DEFAULT '',
                intents_json TEXT NOT NULL DEFAULT '[]',
                capabilities_json TEXT NOT NULL DEFAULT '[]',
                domains_json TEXT NOT NULL DEFAULT '[]',
                keywords_json TEXT NOT NULL DEFAULT '[]',
                source TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT '',
                upstream_json TEXT NOT NULL DEFAULT '{}',
                resource_flags_json TEXT NOT NULL DEFAULT '{}',
                dir_path TEXT NOT NULL DEFAULT '',
                is_enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );",
        )
        .expect("failed to create table");
    }

    #[test]
    fn parse_legacy_frontmatter_without_id() {
        let root = temp_dir();
        let skill_dir = root.join("academic-researcher");
        fs::create_dir_all(&skill_dir).expect("failed to create skill dir");
        let content = r#"---
name: academic-researcher
description: Legacy skill
metadata:
  version: "2.0.0"
---

# Body
"#;

        let parsed = parse_skill_md(content, &skill_dir, "builtin").expect("should parse");
        assert_eq!(parsed.manifest.id, "academic-researcher");
        assert_eq!(parsed.manifest.version, "2.0.0");
        assert_eq!(parsed.manifest.description, "Legacy skill");
        assert_eq!(parsed.body, "# Body");
    }

    #[test]
    fn detect_resource_flags_from_directory() {
        let root = temp_dir();
        fs::create_dir_all(root.join("references")).expect("failed to create refs dir");
        fs::write(root.join("references").join("a.md"), "x").expect("failed to write ref");
        let flags = detect_resource_flags(&root);
        assert!(flags.has_references);
        assert_eq!(flags.reference_count, 1);
    }

    #[test]
    fn render_prompt_bundle_includes_stage_context_and_skill_body() {
        let root = temp_dir();
        fs::write(root.join("AGENTS.md"), "# AGENTS\nproject instructions")
            .expect("failed to write agents");
        fs::create_dir_all(root.join(".pipeline").join("docs")).expect("failed to create docs");
        fs::create_dir_all(root.join(".pipeline").join("tasks")).expect("failed to create tasks");
        fs::write(
            root.join(".pipeline")
                .join("docs")
                .join("research_brief.json"),
            r#"{"topic":"A","goal":"B","pipeline":{"currentStage":"survey"}}"#,
        )
        .expect("failed to write brief");
        fs::write(
            root.join(".pipeline").join("tasks").join("tasks.json"),
            r#"{"tasks":[{"title":"Screen papers","stage":"survey","taskType":"analysis","status":"pending"}]}"#,
        )
        .expect("failed to write tasks");

        let skill_dir = root.join("skill-one");
        fs::create_dir_all(&skill_dir).expect("failed to create skill dir");
        fs::write(
            skill_dir.join("SKILL.md"),
            r#"---
id: skill-one
name: Skill One
summary: Summary
---

# Body
"#,
        )
        .expect("failed to write skill");

        let conn = Connection::open_in_memory().expect("failed to open db");
        create_skills_table(&conn);
        conn.execute(
            "INSERT INTO skills (
                id,name,version,stages_json,tools_json,description,summary,primary_intent,
                intents_json,capabilities_json,domains_json,keywords_json,source,status,
                upstream_json,resource_flags_json,dir_path,is_enabled
             ) VALUES (?1,?2,'1.0.0','[]','[]','','Summary','','[]','[]','[]','[]','builtin','verified','{}','{}',?3,1)",
            rusqlite::params!["skill-one", "Skill One", skill_dir.to_string_lossy().to_string()],
        )
        .expect("failed to insert");

        let prompt =
            load_skill_prompts(&conn, "codex", &root, &["skill-one".into()], None).expect("render");
        assert!(prompt.contains("currentStage: survey"));
        assert!(prompt.contains("[[PROJECT_AGENTS_MD]]"));
        assert!(prompt.contains("[[SKILL:skill-one]]"));
        assert!(prompt.contains("# Body"));
    }

    #[test]
    fn prune_skill_source_removes_entries_outside_current_roots() {
        let conn = Connection::open_in_memory().expect("failed to open db");
        create_skills_table(&conn);

        let root = temp_dir();
        let active_skill = root.join("active").join("skill-a");
        fs::create_dir_all(&active_skill).expect("failed to create active skill dir");
        fs::write(
            active_skill.join("SKILL.md"),
            "---\nid: skill-a\nname: skill-a\n---\n",
        )
        .expect("failed to write active skill");

        let stale_root = temp_dir();
        let stale_skill = stale_root.join("skill-b");
        fs::create_dir_all(&stale_skill).expect("failed to create stale skill dir");
        fs::write(
            stale_skill.join("SKILL.md"),
            "---\nid: skill-b\nname: skill-b\n---\n",
        )
        .expect("failed to write stale skill");

        conn.execute(
            "INSERT INTO skills (
                id,name,version,stages_json,tools_json,description,summary,primary_intent,
                intents_json,capabilities_json,domains_json,keywords_json,source,status,
                upstream_json,resource_flags_json,dir_path,is_enabled
             ) VALUES (?1,?2,'1.0.0','[]','[]','','','','[]','[]','[]','[]','local','verified','{}','{}',?3,1)",
            rusqlite::params!["skill-a", "skill-a", active_skill.to_string_lossy().to_string()],
        )
        .expect("failed to insert active skill");
        conn.execute(
            "INSERT INTO skills (
                id,name,version,stages_json,tools_json,description,summary,primary_intent,
                intents_json,capabilities_json,domains_json,keywords_json,source,status,
                upstream_json,resource_flags_json,dir_path,is_enabled
             ) VALUES (?1,?2,'1.0.0','[]','[]','','','','[]','[]','[]','[]','local','verified','{}','{}',?3,1)",
            rusqlite::params!["skill-b", "skill-b", stale_skill.to_string_lossy().to_string()],
        )
        .expect("failed to insert stale skill");

        prune_skill_source(&conn, &[root.join("active")], "local").expect("prune should pass");
        let ids = super::list_skills(&conn)
            .expect("should list skills")
            .into_iter()
            .map(|skill| skill.id)
            .collect::<Vec<_>>();

        assert!(ids.iter().any(|id| id == "skill-a"));
        assert!(!ids.iter().any(|id| id == "skill-b"));
    }
}
