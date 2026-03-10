use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

use crate::models::SkillManifest;

fn parse_skill_md(content: &str) -> Option<(String, String, String, Vec<String>, Vec<String>)> {
    let content = content.trim();
    if !content.starts_with("---") {
        return None;
    }

    let end = content[3..].find("---")?;
    let frontmatter = &content[3..3 + end];

    let mut id = String::new();
    let mut name = String::new();
    let mut version = String::from("1.0.0");
    let mut stages = Vec::new();
    let mut tools = Vec::new();

    for line in frontmatter.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("id:") {
            id = val.trim().to_string();
        } else if let Some(val) = line.strip_prefix("name:") {
            name = val.trim().to_string();
        } else if let Some(val) = line.strip_prefix("version:") {
            version = val.trim().to_string();
        } else if let Some(val) = line.strip_prefix("stages:") {
            stages = parse_yaml_array(val.trim());
        } else if let Some(val) = line.strip_prefix("tools:") {
            tools = parse_yaml_array(val.trim());
        }
    }

    if id.is_empty() {
        return None;
    }

    Some((id, name, version, stages, tools))
}

fn parse_yaml_array(raw: &str) -> Vec<String> {
    raw.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|item| item.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

pub fn discover_skills(conn: &Connection, search_dirs: &[PathBuf], source: &str) -> Result<(), String> {
    for dir in search_dirs {
        if !dir.exists() {
            continue;
        }

        let entries = fs::read_dir(dir).map_err(|err| err.to_string())?;
        for entry in entries.flatten() {
            let skill_dir = entry.path();
            if !skill_dir.is_dir() {
                continue;
            }

            let skill_md = skill_dir.join("SKILL.md");
            if !skill_md.exists() {
                continue;
            }

            let content = fs::read_to_string(&skill_md).map_err(|err| err.to_string())?;
            if let Some((id, name, version, stages, tools)) = parse_skill_md(&content) {
                let stages_json = serde_json::to_string(&stages).unwrap_or_else(|_| "[]".into());
                let tools_json = serde_json::to_string(&tools).unwrap_or_else(|_| "[]".into());
                let dir_path = skill_dir.to_string_lossy().to_string();

                conn.execute(
                    "INSERT INTO skills (id, name, version, stages_json, tools_json, source, dir_path) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version, stages_json=excluded.stages_json, tools_json=excluded.tools_json, source=excluded.source, dir_path=excluded.dir_path",
                    params![id, name, version, stages_json, tools_json, source, dir_path],
                )
                .map_err(|err| err.to_string())?;
            }
        }
    }

    Ok(())
}

pub fn list_skills(conn: &Connection) -> Result<Vec<SkillManifest>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, version, stages_json, tools_json, source, dir_path, is_enabled FROM skills ORDER BY created_at, name",
        )
        .map_err(|err| err.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let stages_json: String = row.get(3)?;
            let tools_json: String = row.get(4)?;
            Ok(SkillManifest {
                id: row.get(0)?,
                name: row.get(1)?,
                version: row.get(2)?,
                stages: serde_json::from_str(&stages_json).unwrap_or_default(),
                tools: serde_json::from_str(&tools_json).unwrap_or_default(),
                source: row.get(5)?,
                dir_path: row.get(6)?,
                is_enabled: row.get::<_, i32>(7)? != 0,
            })
        })
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

pub fn install_skill(conn: &Connection, skill: &SkillManifest) -> Result<(), String> {
    let stages_json = serde_json::to_string(&skill.stages).unwrap_or_else(|_| "[]".into());
    let tools_json = serde_json::to_string(&skill.tools).unwrap_or_else(|_| "[]".into());

    conn.execute(
        "INSERT INTO skills (id, name, version, stages_json, tools_json, source, dir_path, is_enabled) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version, stages_json=excluded.stages_json, tools_json=excluded.tools_json, source=excluded.source, dir_path=excluded.dir_path, is_enabled=excluded.is_enabled",
        params![
            skill.id,
            skill.name,
            skill.version,
            stages_json,
            tools_json,
            skill.source,
            skill.dir_path,
            skill.is_enabled as i32
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn enable_skill(conn: &Connection, skill_id: &str, enabled: bool) -> Result<Option<SkillManifest>, String> {
    conn.execute(
        "UPDATE skills SET is_enabled=?2 WHERE id=?1",
        params![skill_id, enabled as i32],
    )
    .map_err(|err| err.to_string())?;

    list_skills(conn).map(|skills| skills.into_iter().find(|skill| skill.id == skill_id))
}

pub fn load_skill_prompts(conn: &Connection, skill_ids: &[String]) -> Result<String, String> {
    let mut prompts = Vec::new();

    for skill_id in skill_ids {
        let dir_path: String = conn
            .query_row(
                "SELECT dir_path FROM skills WHERE id=?1 AND is_enabled=1",
                params![skill_id],
                |row| row.get(0),
            )
            .unwrap_or_default();

        if dir_path.is_empty() {
            continue;
        }

        let skill_md = Path::new(&dir_path).join("SKILL.md");
        if let Ok(content) = fs::read_to_string(&skill_md) {
            if let Some(body) = extract_body(&content) {
                prompts.push(body);
            }
        }
    }

    Ok(prompts.join("\n\n---\n\n"))
}

fn extract_body(content: &str) -> Option<String> {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return Some(trimmed.to_string());
    }

    let rest = &trimmed[3..];
    let end = rest.find("---")?;
    Some(rest[end + 3..].trim().to_string())
}
