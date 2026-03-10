use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::path::Path;
use std::process::Command;
use uuid::Uuid;

use crate::models::{FigureBriefDraft, GeneratedAsset};
use crate::services::provider;
use crate::state::AppState;

pub fn create_brief(
    state: &AppState,
    section_ref: &str,
    selected_text: &str,
) -> Result<FigureBriefDraft> {
    let brief = FigureBriefDraft {
        id: Uuid::new_v4().to_string(),
        source_section_ref: section_ref.into(),
        brief_markdown: format!(
            "# Figure brief for {section_ref}\n\n## Source excerpt\n{selected_text}\n"
        ),
        prompt_payload: format!(
            "Create a paper figure for {section_ref} emphasizing compile-preview-agent-figure flow."
        ),
        status: "draft".into(),
    };

    let conn = state.db.lock().expect("db lock poisoned");
    conn.execute(
        "INSERT INTO figure_briefs (id, source_section, brief_markdown, prompt_payload, status) VALUES (?1,?2,?3,?4,?5)",
        params![
            brief.id,
            brief.source_section_ref,
            brief.brief_markdown,
            brief.prompt_payload,
            brief.status
        ],
    )
    .context("failed to persist figure brief")?;

    Ok(brief)
}

pub fn list_briefs(conn: &Connection) -> Result<Vec<FigureBriefDraft>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, source_section, brief_markdown, prompt_payload, status FROM figure_briefs ORDER BY created_at DESC",
        )
        .map_err(|err| err.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(FigureBriefDraft {
                id: row.get(0)?,
                source_section_ref: row.get(1)?,
                brief_markdown: row.get(2)?,
                prompt_payload: row.get(3)?,
                status: row.get(4)?,
            })
        })
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

pub fn get_brief(conn: &Connection, brief_id: &str) -> Result<FigureBriefDraft, String> {
    conn.query_row(
        "SELECT id, source_section, brief_markdown, prompt_payload, status FROM figure_briefs WHERE id=?1",
        params![brief_id],
        |row| {
            Ok(FigureBriefDraft {
                id: row.get(0)?,
                source_section_ref: row.get(1)?,
                brief_markdown: row.get(2)?,
                prompt_payload: row.get(3)?,
                status: row.get(4)?,
            })
        },
    )
    .map_err(|err| err.to_string())
}

pub fn run_figure_skill(state: &AppState, brief_id: &str) -> Result<FigureBriefDraft> {
    let conn = state.db.lock().expect("db lock poisoned");
    let brief = get_brief(&conn, brief_id).map_err(anyhow::Error::msg)?;
    drop(conn);

    let payload = serde_json::json!({
        "briefId": brief.id,
        "promptPayload": brief.prompt_payload,
        "briefMarkdown": brief.brief_markdown
    });

    let output = Command::new("node")
        .arg(state.app_root.join("sidecar/index.mjs"))
        .args(["figure-skill", &payload.to_string()])
        .current_dir(&state.app_root)
        .output()
        .context("failed to run figure skill sidecar")?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let updated = serde_json::from_str::<FigureBriefDraft>(&stdout)
        .context("failed to parse figure skill response")?;

    let conn = state.db.lock().expect("db lock poisoned");
    conn.execute(
        "UPDATE figure_briefs SET source_section=?2, brief_markdown=?3, prompt_payload=?4, status=?5 WHERE id=?1",
        params![
            updated.id,
            updated.source_section_ref,
            updated.brief_markdown,
            updated.prompt_payload,
            updated.status
        ],
    )
    .context("failed to update figure brief")?;

    Ok(updated)
}

pub fn run_banana_generation(state: &AppState, brief_id: &str) -> Result<GeneratedAsset> {
    let root = {
        let config = state.project_config.read().expect("project config lock poisoned");
        config.root_path.clone()
    };
    let conn = state.db.lock().expect("db lock poisoned");
    let brief = get_brief(&conn, brief_id).map_err(anyhow::Error::msg)?;
    let banana = provider::find_first_by_vendor(&conn, "banana")
        .map_err(|err| anyhow::anyhow!("banana provider not configured: {err}"))?;
    drop(conn);

    let payload = serde_json::json!({
        "apiKey": banana.api_key,
        "baseUrl": banana.base_url,
        "prompt": brief.prompt_payload,
        "projectRoot": root,
        "briefId": brief.id
    });

    let output = Command::new("node")
        .arg(state.app_root.join("sidecar/index.mjs"))
        .args(["banana", &payload.to_string()])
        .current_dir(&state.app_root)
        .output()
        .context("failed to run banana sidecar")?;

    if !output.status.success() {
        return Err(anyhow::anyhow!(
            "banana sidecar failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<GeneratedAsset>(&stdout)
        .context("failed to parse banana response")
}

pub fn register_asset(state: &AppState, asset: GeneratedAsset) -> Result<GeneratedAsset> {
    let conn = state.db.lock().expect("db lock poisoned");
    conn.execute(
        "INSERT INTO assets (id, kind, file_path, source_brief_id, metadata_json) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, file_path=excluded.file_path, source_brief_id=excluded.source_brief_id, metadata_json=excluded.metadata_json",
        params![
            asset.id,
            asset.kind,
            asset.file_path,
            asset.source_brief_id,
            asset.metadata.to_string()
        ],
    )
    .context("failed to persist asset")?;

    if asset.source_brief_id.is_empty() {
        return Ok(asset);
    }

    let _ = conn.execute(
        "UPDATE figure_briefs SET status='generated' WHERE id=?1",
        params![asset.source_brief_id],
    );

    Ok(asset)
}

pub fn list_assets(conn: &Connection) -> Result<Vec<GeneratedAsset>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, file_path, source_brief_id, metadata_json FROM assets ORDER BY created_at DESC",
        )
        .map_err(|err| err.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let metadata_json: String = row.get(4)?;
            let file_path: String = row.get(2)?;
            let preview_uri = Path::new(&file_path)
                .canonicalize()
                .ok()
                .map(|path| format!("file://{}", path.to_string_lossy()))
                .unwrap_or_default();

            Ok(GeneratedAsset {
                id: row.get(0)?,
                kind: row.get(1)?,
                file_path,
                source_brief_id: row.get(3)?,
                metadata: serde_json::from_str(&metadata_json).unwrap_or_else(|_| serde_json::json!({})),
                preview_uri,
            })
        })
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

pub fn get_asset(conn: &Connection, asset_id: &str) -> Result<GeneratedAsset, String> {
    conn.query_row(
        "SELECT id, kind, file_path, source_brief_id, metadata_json FROM assets WHERE id=?1",
        params![asset_id],
        |row| {
            let metadata_json: String = row.get(4)?;
            let file_path: String = row.get(2)?;
            let preview_uri = Path::new(&file_path)
                .canonicalize()
                .ok()
                .map(|path| format!("file://{}", path.to_string_lossy()))
                .unwrap_or_default();

            Ok(GeneratedAsset {
                id: row.get(0)?,
                kind: row.get(1)?,
                file_path,
                source_brief_id: row.get(3)?,
                metadata: serde_json::from_str(&metadata_json).unwrap_or_else(|_| serde_json::json!({})),
                preview_uri,
            })
        },
    )
    .map_err(|err| err.to_string())
}

pub fn insert_figure_snippet(
    state: &AppState,
    file_path: &str,
    asset_id: &str,
    caption: &str,
    line: usize,
) -> Result<(String, String)> {
    let root = {
        let config = state.project_config.read().expect("project config lock poisoned");
        config.root_path.clone()
    };
    let conn = state.db.lock().expect("db lock poisoned");
    let asset = get_asset(&conn, asset_id).map_err(anyhow::Error::msg)?;
    drop(conn);

    let absolute = Path::new(&root).join(file_path);
    let content = std::fs::read_to_string(&absolute).unwrap_or_default();
    let label = asset
        .file_path
        .replace("assets/figures/", "")
        .replace('.', "-")
        .replace('/', "-");
    let snippet = format!(
        "\\begin{{figure}}[htbp]\n  \\centering\n  \\includegraphics[width=0.82\\linewidth]{{{}}}\n  \\caption{{{}}}\n  \\label{{fig:{}}}\n\\end{{figure}}",
        asset.file_path,
        caption,
        label
    );
    let mut lines = content.lines().map(|line| line.to_string()).collect::<Vec<_>>();
    let target = line.min(lines.len());
    lines.insert(target, String::new());
    lines.insert(target, snippet);
    let updated = lines.join("\n");
    std::fs::write(&absolute, &updated)?;
    Ok((file_path.into(), updated))
}
