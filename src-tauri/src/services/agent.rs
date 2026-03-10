use std::io::BufRead;
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{Context, Result};
use rusqlite::params;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::models::{AgentContext, AgentMessage, AgentProvider, AgentRequest, AgentRunResult, StreamChunk};
use crate::services::{profile, provider, skill};
use crate::state::AppState;

pub fn run_agent(
    app_handle: &AppHandle,
    state: &AppState,
    profile_id: &str,
    file_path: &str,
    selected_text: &str,
) -> Result<AgentRunResult> {
    let project_root = {
        let config = state.project_config.read().expect("project config lock poisoned");
        config.root_path.clone()
    };

    let conn = state.db.lock().expect("db lock poisoned");
    let profile = profile::get_profile(&conn, profile_id).map_err(anyhow::Error::msg)?;
    let prov = provider::get_provider(&conn, &profile.provider_id).map_err(anyhow::Error::msg)?;
    let system_prompt =
        skill::load_skill_prompts(&conn, &profile.skill_ids).map_err(anyhow::Error::msg)?;
    drop(conn);

    let full_path = Path::new(&project_root).join(file_path);
    let full_content = std::fs::read_to_string(&full_path).unwrap_or_default();

    let session_id = Uuid::new_v4().to_string();
    let request = AgentRequest {
        session_id: session_id.clone(),
        profile_id: profile_id.to_string(),
        provider: AgentProvider {
            vendor: prov.vendor.clone(),
            base_url: prov.base_url.clone(),
            api_key: prov.api_key.clone(),
            model: profile.model.clone(),
        },
        system_prompt,
        tools: profile.tool_allowlist.clone(),
        context: AgentContext {
            project_root: project_root.clone(),
            active_file_path: file_path.to_string(),
            selected_text: selected_text.to_string(),
            full_file_content: full_content,
            cursor_line: 1,
        },
    };
    let payload = serde_json::to_string(&request)?;

    {
        let conn = state.db.lock().expect("db lock poisoned");
        conn.execute(
            "INSERT INTO sessions (id, profile_id, project_dir) VALUES (?1, ?2, ?3)",
            params![session_id, profile_id, project_root],
        )?;
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, profile_id) VALUES (?1, ?2, 'user', ?3, ?4)",
            params![
                Uuid::new_v4().to_string(),
                session_id,
                if selected_text.is_empty() {
                    format!("Run agent on {file_path}")
                } else {
                    selected_text.to_string()
                },
                profile_id
            ],
        )?;
    }

    let mut child = Command::new("node")
        .arg(state.app_root.join("sidecar/index.mjs"))
        .args(["agent", &payload])
        .current_dir(&state.app_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("failed to spawn agent sidecar")?;

    let stdout = child.stdout.take().context("sidecar stdout unavailable")?;
    let reader = std::io::BufReader::new(stdout);
    let mut full_response = String::new();

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        match serde_json::from_str::<StreamChunk>(&line) {
            Ok(chunk) => {
                let _ = app_handle.emit("agent:stream", &chunk);

                match &chunk {
                    StreamChunk::TextDelta { content } => {
                        full_response.push_str(content);
                    }
                    StreamChunk::Done { usage } => {
                        let conn = state.db.lock().expect("db lock poisoned");
                        let _ = conn.execute(
                            "INSERT INTO usage_logs (id, session_id, provider_id, model, input_tokens, output_tokens) VALUES (?1,?2,?3,?4,?5,?6)",
                            params![
                                Uuid::new_v4().to_string(),
                                session_id,
                                profile.provider_id,
                                usage.model,
                                usage.input_tokens,
                                usage.output_tokens
                            ],
                        );
                    }
                    _ => {}
                }
            }
            Err(err) => {
                let _ = app_handle.emit(
                    "agent:stream",
                    &StreamChunk::Error {
                        message: format!("failed to decode sidecar chunk: {err}"),
                    },
                );
            }
        }
    }

    let output = child.wait_with_output().context("failed to wait for sidecar")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = app_handle.emit(
            "agent:stream",
            &StreamChunk::Error {
                message: stderr.to_string(),
            },
        );
        return Err(anyhow::anyhow!("agent sidecar failed: {stderr}"));
    }

    if !full_response.is_empty() {
        let conn = state.db.lock().expect("db lock poisoned");
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, profile_id) VALUES (?1, ?2, 'assistant', ?3, ?4)",
            params![
                Uuid::new_v4().to_string(),
                session_id,
                full_response,
                profile_id
            ],
        )?;
    }

    Ok(AgentRunResult {
        session_id: Some(session_id),
        message: None,
        suggested_patch: None,
    })
}

pub fn apply_agent_patch(root_path: &str, file_path: &str, content: &str) -> Result<()> {
    let absolute = Path::new(root_path).join(file_path);
    std::fs::write(absolute, content).context("failed to apply agent patch")?;
    Ok(())
}

pub fn get_agent_messages(state: &AppState, session_id: Option<&str>) -> Result<Vec<AgentMessage>> {
    let conn = state.db.lock().expect("db lock poisoned");
    let sql = if session_id.is_some() {
        "SELECT id, session_id, role, content, profile_id, tool_id, tool_args, created_at FROM messages WHERE session_id=?1 ORDER BY created_at"
    } else {
        "SELECT id, session_id, role, content, profile_id, tool_id, tool_args, created_at FROM messages ORDER BY created_at"
    };
    let mut stmt = conn.prepare(sql)?;
    let map_row = |row: &rusqlite::Row<'_>| {
        Ok(AgentMessage {
            id: row.get(0)?,
            session_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            profile_id: row.get(4)?,
            tool_id: row.get(5)?,
            tool_args: row.get(6)?,
            created_at: row.get(7)?,
        })
    };

    if let Some(session_id) = session_id {
        let rows = stmt.query_map(params![session_id], map_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    } else {
        let rows = stmt.query_map([], map_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
}
