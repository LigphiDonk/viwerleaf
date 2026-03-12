use std::io::BufRead;
use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::models::{
    AgentContext, AgentConversationMessage, AgentMessage, AgentProvider, AgentRequest,
    AgentRunResult, AgentSessionSummary, StreamChunk, UsageInfo,
};
use crate::services::{profile, provider, sidecar, skill};
use crate::state::AppState;

const DEFAULT_AGENT_SYSTEM_PROMPT: &str = r#"You are ViewerLeaf, an AI assistant for LaTeX and project workspaces.

When the user asks about the current project, files, paper structure, or document content, inspect the workspace directly with tools instead of merely saying that you will inspect it.

Use this rough order:
1. If you are unsure which tool to use, call `tool_search` first
2. `list` for project structure
3. `glob` or `grep` for discovery and lookup
4. `read` for exact file content
5. `list_sections` or `read_section` when working with LaTeX structure
6. `read_bib_entries` for bibliography lookup
7. `edit`, `write`, or `apply_patch` only when editing is requested

After `tool_search`, use the returned tool ids in the next round instead of repeating planning text.

Do not repeat the same planning sentence across tool rounds.
After enough tool results are available, answer directly and stop.
If a tool fails or the required information is unavailable, explain that once and move on."#;

/// Insert the user message and ensure the session exists in the DB.
/// Called synchronously from the command handler *before* spawning the
/// background thread so the frontend can read the message immediately.
pub fn prepare_user_message(
    state: &AppState,
    profile_id: &str,
    session_id: &str,
    file_path: &str,
    user_message: &str,
) -> Result<()> {
    let project_root = {
        let config = state
            .project_config
            .read()
            .expect("project config lock poisoned");
        config.root_path.clone()
    };
    let effective_msg = if user_message.trim().is_empty() {
        format!("Run agent on {file_path}")
    } else {
        user_message.to_owned()
    };
    let conn = state.db.lock().expect("db lock poisoned");
    ensure_session(
        &conn,
        session_id,
        profile_id,
        &project_root,
        &build_session_title(&effective_msg),
    )?;
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, profile_id) VALUES (?1, ?2, 'user', ?3, ?4)",
        params![Uuid::new_v4().to_string(), session_id, effective_msg, profile_id],
    )?;
    touch_session(&conn, session_id)?;
    Ok(())
}

pub fn run_agent(
    app_handle: &AppHandle,
    state: &AppState,
    profile_id: &str,
    session_id: Option<&str>,
    file_path: &str,
    selected_text: &str,
    user_message: Option<&str>,
) -> Result<AgentRunResult> {
    let project_root = {
        let config = state
            .project_config
            .read()
            .expect("project config lock poisoned");
        config.root_path.clone()
    };

    let conn = state.db.lock().expect("db lock poisoned");
    let profile = profile::get_profile(&conn, profile_id).map_err(anyhow::Error::msg)?;
    let prov = provider::get_provider(&conn, &profile.provider_id).map_err(anyhow::Error::msg)?;
    let mut system_prompt =
        skill::load_skill_prompts(&conn, &profile.skill_ids).map_err(anyhow::Error::msg)?;
    if system_prompt.trim().is_empty() {
        system_prompt = DEFAULT_AGENT_SYSTEM_PROMPT.to_string();
    }
    drop(conn);

    let user_message = user_message
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            if selected_text.trim().is_empty() {
                format!("Run agent on {file_path}")
            } else {
                selected_text.to_string()
            }
        });

    let session_id = session_id
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let history = {
        let conn = state.db.lock().expect("db lock poisoned");
        load_session_history(&conn, &session_id)?
    };

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
        user_message: user_message.clone(),
        history,
        context: AgentContext {
            project_root: project_root.clone(),
            active_file_path: file_path.to_string(),
            selected_text: selected_text.to_string(),
            // Keep schema compatibility, but avoid eager full-file injection into prompts.
            full_file_content: String::new(),
            cursor_line: 1,
        },
    };
    let payload = serde_json::to_string(&request)?;

    // Session and user message are already inserted by prepare_user_message().
    // Only insert here if called without a prior prepare (e.g. in tests or
    // direct call path without the command wrapper).
    {
        let conn = state.db.lock().expect("db lock poisoned");
        let already_exists = conn
            .query_row(
                "SELECT id FROM sessions WHERE id=?1 LIMIT 1",
                params![session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .is_some();
        if !already_exists {
            ensure_session(
                &conn,
                &session_id,
                profile_id,
                &project_root,
                &build_session_title(&user_message),
            )?;
            conn.execute(
                "INSERT INTO messages (id, session_id, role, content, profile_id) VALUES (?1, ?2, 'user', ?3, ?4)",
                params![
                    Uuid::new_v4().to_string(),
                    session_id,
                    user_message,
                    profile_id
                ],
            )?;
            touch_session(&conn, &session_id)?;
        }
    }

    let mut child = sidecar::spawn_sidecar(state, "agent", &payload)
        .with_context(|| "failed to spawn agent sidecar".to_string())?;

    let stdout = child.stdout.take().context("sidecar stdout unavailable")?;
    let reader = std::io::BufReader::new(stdout);
    let mut full_response = String::new();
    let mut last_error: Option<String> = None;
    let mut done_usage: Option<UsageInfo> = None;

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        match serde_json::from_str::<StreamChunk>(&line) {
            Ok(chunk) => match &chunk {
                StreamChunk::TextDelta { content } => {
                    full_response.push_str(content);
                    let _ = app_handle.emit("agent:stream", &chunk);
                }
                StreamChunk::Done { usage } => {
                    done_usage = Some(usage.clone());
                }
                StreamChunk::Error { message } => {
                    last_error = Some(message.clone());
                    let _ = app_handle.emit("agent:stream", &chunk);
                }
                _ => {
                    let _ = app_handle.emit("agent:stream", &chunk);
                }
            },
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

    let output = child
        .wait_with_output()
        .context("failed to wait for sidecar")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let error_message = if stderr.trim().is_empty() {
            last_error.unwrap_or_else(|| "agent sidecar failed with empty stderr".to_string())
        } else {
            stderr.to_string()
        };
        let _ = app_handle.emit(
            "agent:stream",
            &StreamChunk::Error {
                message: error_message.clone(),
            },
        );
        persist_assistant_message(
            state,
            &session_id,
            profile_id,
            &format!("Error: {error_message}"),
        )?;
        return Err(anyhow::anyhow!("agent sidecar failed: {error_message}"));
    }

    if !full_response.is_empty() {
        persist_assistant_message(state, &session_id, profile_id, &full_response)?;
    } else if let Some(error_message) = last_error {
        persist_assistant_message(
            state,
            &session_id,
            profile_id,
            &format!("Error: {error_message}"),
        )?;
    }

    let usage = done_usage.unwrap_or_else(|| UsageInfo {
        input_tokens: 0,
        output_tokens: 0,
        model: profile.model.clone(),
    });

    {
        let conn = state.db.lock().expect("db lock poisoned");
        let _ = conn.execute(
            "INSERT INTO usage_logs (id, session_id, provider_id, model, input_tokens, output_tokens) VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                Uuid::new_v4().to_string(),
                session_id,
                profile.provider_id,
                usage.model.clone(),
                usage.input_tokens,
                usage.output_tokens
            ],
        );
    }

    let _ = app_handle.emit("agent:stream", &StreamChunk::Done { usage });

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

pub fn list_agent_sessions(state: &AppState) -> Result<Vec<AgentSessionSummary>> {
    let conn = state.db.lock().expect("db lock poisoned");
    let mut stmt = conn.prepare(
        "
        SELECT
          s.id,
          s.profile_id,
          s.title,
          s.created_at,
          s.updated_at,
          COUNT(m.id) AS message_count,
          COALESCE((
            SELECT mm.content
            FROM messages mm
            WHERE mm.session_id = s.id
            ORDER BY mm.created_at DESC
            LIMIT 1
          ), '') AS last_message
        FROM sessions s
        LEFT JOIN messages m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY datetime(s.updated_at) DESC, datetime(s.created_at) DESC
        ",
    )?;

    let rows = stmt.query_map([], |row| {
        let title: String = row.get(2)?;
        let last_message: String = row.get(6)?;
        Ok(AgentSessionSummary {
            id: row.get(0)?,
            profile_id: row.get(1)?,
            title: if title.trim().is_empty() {
                build_session_title(&last_message)
            } else {
                title
            },
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
            message_count: row.get(5)?,
            last_message_preview: truncate_preview(&last_message, 80),
        })
    })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn load_session_history(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Vec<AgentConversationMessage>> {
    let mut stmt = conn.prepare(
        "SELECT role, content FROM messages WHERE session_id=?1 AND role IN ('user','assistant') ORDER BY created_at LIMIT 40",
    )?;
    let rows = stmt.query_map(params![session_id], |row| {
        Ok(AgentConversationMessage {
            role: row.get(0)?,
            content: row.get(1)?,
        })
    })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn ensure_session(
    conn: &rusqlite::Connection,
    session_id: &str,
    profile_id: &str,
    project_root: &str,
    title: &str,
) -> Result<()> {
    let exists = conn
        .query_row(
            "SELECT id FROM sessions WHERE id=?1 LIMIT 1",
            params![session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    if exists.is_none() {
        conn.execute(
            "INSERT INTO sessions (id, profile_id, project_dir, title) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, profile_id, project_root, title],
        )?;
    }

    Ok(())
}

fn touch_session(conn: &rusqlite::Connection, session_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE sessions SET updated_at=datetime('now') WHERE id=?1",
        params![session_id],
    )?;
    Ok(())
}

fn persist_assistant_message(
    state: &AppState,
    session_id: &str,
    profile_id: &str,
    content: &str,
) -> Result<()> {
    let conn = state.db.lock().expect("db lock poisoned");
    conn.execute(
        "INSERT INTO messages (id, session_id, role, content, profile_id) VALUES (?1, ?2, 'assistant', ?3, ?4)",
        params![
            Uuid::new_v4().to_string(),
            session_id,
            content,
            profile_id
        ],
    )?;
    touch_session(&conn, session_id)?;
    Ok(())
}

fn build_session_title(text: &str) -> String {
    let compact = text.replace('\n', " ").trim().to_string();
    if compact.is_empty() {
        return "新对话".to_string();
    }
    truncate_preview(&compact, 40)
}

fn truncate_preview(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out = String::new();
    for ch in text.chars().take(max_chars) {
        out.push(ch);
    }
    out.push_str("...");
    out
}
