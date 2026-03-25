use std::collections::HashMap;
use std::io::BufRead;
use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::models::{
    AgentContext, AgentMcpServerConfig, AgentMessage, AgentProvider, AgentRequest, AgentRunResult,
    AgentSessionSummary, AgentTaskContext, StreamChunk, UsageInfo,
};
use crate::services::{compute_node, profile, provider, sidecar, skill};
use crate::state::AppState;

use std::sync::atomic::Ordering;

fn read_provider_reasoning_effort(meta_json: &str) -> String {
    serde_json::from_str::<serde_json::Value>(meta_json)
        .ok()
        .and_then(|meta| meta.get("runtime").cloned())
        .and_then(|runtime| runtime.get("effort").cloned())
        .and_then(|effort| effort.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn read_provider_mcp_servers(meta_json: &str) -> HashMap<String, AgentMcpServerConfig> {
    let mut servers = HashMap::new();
    let Ok(meta) = serde_json::from_str::<serde_json::Value>(meta_json) else {
        return servers;
    };

    let Some(raw_servers) = meta.get("mcpServers").and_then(|value| value.as_object()) else {
        return servers;
    };

    for (name, raw_config) in raw_servers {
        let Some(config) = raw_config.as_object() else {
            continue;
        };

        let transport = config
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("stdio");
        if transport != "stdio" {
            continue;
        }

        let command = config
            .get("command")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .unwrap_or_default();
        if command.is_empty() {
            continue;
        }

        let args = config
            .get("args")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let env = config
            .get("env")
            .and_then(|value| value.as_object())
            .map(|vars| {
                vars.iter()
                    .filter_map(|(key, value)| {
                        value.as_str().map(|item| (key.clone(), item.to_owned()))
                    })
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();

        servers.insert(
            name.clone(),
            AgentMcpServerConfig {
                r#type: "stdio".into(),
                command: command.to_owned(),
                args,
                env,
            },
        );
    }

    servers
}

fn serialize_tool_args(args: &serde_json::Value) -> String {
    match args {
        serde_json::Value::Null => String::new(),
        serde_json::Value::Object(map) if map.is_empty() => String::new(),
        _ => serde_json::to_string_pretty(args).unwrap_or_default(),
    }
}

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
    task_mode: bool,
    task_context: Option<&AgentTaskContext>,
    sidecar_pid_out: Option<&std::sync::atomic::AtomicU32>,
) -> Result<AgentRunResult> {
    // Reset cancellation flag at the start of each run
    state.sidecar_cancelled.store(false, Ordering::SeqCst);

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
    let remote_session_id = read_remote_session_id(&conn, session_id)?;
    // Load skill prompts for injection (CLI runners use them as appendSystemPrompt)
    let mut system_prompt = skill::load_skill_prompts(
        &conn,
        &prov.vendor,
        Path::new(&project_root),
        &profile.skill_ids,
        task_context,
    )
    .map_err(anyhow::Error::msg)?;
    drop(conn);

    // Inject active compute node info + compute-helper CLI instructions
    if let Some(node) = compute_node::get_active_node() {
        // Resolve path to compute-helper.mjs relative to the sidecar location
        let helper_path = {
            let sidecar_dir = state.sidecar_dir.to_string_lossy().to_string();
            if sidecar_dir.is_empty() {
                "compute-helper.mjs".to_string()
            } else {
                format!("{}/bin/compute-helper.mjs", sidecar_dir)
            }
        };
        let node_block = format!(
            "\n\n<compute_node>\n\
             你有一台可用的远程计算节点：\n\
             - 名称: {name}\n\
             - 地址: {user}@{host}:{port}\n\
             - 工作目录: {work_dir}\n\
             \n\
             可用的计算工具命令：\n\
             - `node {helper} sync up --cwd {project_root}` — 同步本地代码到服务器\n\
             - `node {helper} run \"<command>\" --cwd {project_root}` — 同步代码 + 远程执行命令\n\
             - `node {helper} sync down --cwd {project_root} --files \"logs/ results/\"` — 从服务器拉回结果文件\n\
             - `node {helper} ssh \"<command>\"` — 仅 SSH 执行命令（不同步代码）\n\
             - `node {helper} info` — 查看节点配置信息\n\
             \n\
             使用流程：修改代码 → sync up 同步 → run/ssh 远程执行 → sync down 拉回结果\n\
             所有命令输出为 JSON 格式: {{\"success\": true, \"output\": \"...\"}}\n\
             </compute_node>",
            name = node.name,
            user = node.user,
            host = node.host,
            port = node.port,
            work_dir = node.work_dir,
            helper = helper_path,
            project_root = project_root,
        );
        system_prompt.push_str(&node_block);
    }

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

    let request = AgentRequest {
        session_id: session_id.clone(),
        remote_session_id,
        profile_id: profile_id.to_string(),
        provider: AgentProvider {
            vendor: prov.vendor.clone(),
            model: if prov.default_model.trim().is_empty() {
                profile.model.clone()
            } else {
                prov.default_model.clone()
            },
            permission_mode: String::from("acceptEdits"),
            reasoning_effort: read_provider_reasoning_effort(&prov.meta_json),
            mcp_servers: read_provider_mcp_servers(&prov.meta_json),
        },
        system_prompt,
        user_message: user_message.clone(),
        context: AgentContext {
            project_root: project_root.clone(),
            active_file_path: file_path.to_string(),
            selected_text: selected_text.to_string(),
            task_mode,
            task_context: task_context.cloned(),
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

    // Store sidecar PID for cancellation support
    {
        let pid = child.id();
        let mut active = state
            .active_sidecar
            .lock()
            .expect("active_sidecar lock poisoned");
        *active = Some(pid);
        // Also write to caller-provided output if given (used by experiment daemon)
        if let Some(out) = sidecar_pid_out {
            out.store(pid, Ordering::SeqCst);
        }
    }

    let stdout = child.stdout.take().context("sidecar stdout unavailable")?;
    // Use a small buffer (256 bytes) so that streaming text_delta events
    // are read and emitted promptly instead of waiting for the default 8KB
    // BufReader buffer to fill.
    let reader = std::io::BufReader::with_capacity(256, stdout);
    let mut full_response = String::new();
    let mut active_thinking = String::new();
    let mut committed_thinking = String::new();
    let mut last_error: Option<String> = None;
    let mut done_usage: Option<UsageInfo> = None;
    let mut final_remote_session_id: Option<String> = None;
    let mut assistant_timeline: Vec<AssistantTimelineItem> = Vec::new();

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        match serde_json::from_str::<StreamChunk>(&line) {
            Ok(chunk) => match &chunk {
                StreamChunk::ThinkingDelta { content } => {
                    active_thinking.push_str(content);
                    let _ = app_handle.emit("agent:stream", &chunk);
                }
                StreamChunk::ThinkingClear => {
                    active_thinking.clear();
                    let _ = app_handle.emit("agent:stream", &chunk);
                }
                StreamChunk::ThinkingCommit => {
                    if !active_thinking.trim().is_empty() {
                        if !committed_thinking.is_empty() {
                            committed_thinking.push_str("\n\n");
                        }
                        committed_thinking.push_str(active_thinking.trim());
                    }
                    active_thinking.clear();
                    let _ = app_handle.emit("agent:stream", &chunk);
                }
                StreamChunk::TextDelta { content } => {
                    full_response.push_str(content);
                    push_timeline_text(&mut assistant_timeline, content);
                    let _ = app_handle.emit("agent:stream", &chunk);
                }
                StreamChunk::Done {
                    usage,
                    remote_session_id,
                } => {
                    done_usage = Some(usage.clone());
                    final_remote_session_id = remote_session_id.clone();
                }
                StreamChunk::Error { message } => {
                    last_error = Some(message.clone());
                    let _ = app_handle.emit("agent:stream", &chunk);
                }
                StreamChunk::ToolCallStart {
                    tool_id,
                    tool_use_id,
                    args,
                } => {
                    assistant_timeline.push(AssistantTimelineItem::Tool {
                        tool_id: tool_id.clone(),
                        tool_use_id: tool_use_id.clone(),
                        status: "running".into(),
                        args: serialize_tool_args(args),
                        preview: String::new(),
                    });
                    let _ = app_handle.emit("agent:stream", &chunk);
                }
                StreamChunk::ToolCallResult {
                    tool_id,
                    tool_use_id,
                    output,
                    status,
                } => {
                    let resolved_status = status.as_deref().unwrap_or("completed").to_string();
                    let preview = truncate_preview(output, 240);
                    // Find matching index — prefer tool_use_id, fallback to name+status
                    let matched_idx = if !tool_use_id.is_empty() {
                        assistant_timeline
                            .iter()
                            .rposition(|item| matches!(item, AssistantTimelineItem::Tool { tool_use_id: uid, status, .. } if uid == tool_use_id && status == "running"))
                    } else {
                        None
                    };
                    let matched_idx = matched_idx.or_else(|| {
                        assistant_timeline
                            .iter()
                            .rposition(|item| matches!(item, AssistantTimelineItem::Tool { tool_id: id, status, .. } if id == tool_id && status == "running"))
                    });
                    if let Some(idx) = matched_idx {
                        if let AssistantTimelineItem::Tool {
                            status,
                            preview: item_preview,
                            ..
                        } = &mut assistant_timeline[idx]
                        {
                            *status = resolved_status;
                            *item_preview = preview;
                        }
                    } else {
                        assistant_timeline.push(AssistantTimelineItem::Tool {
                            tool_id: tool_id.clone(),
                            tool_use_id: tool_use_id.clone(),
                            status: resolved_status,
                            args: String::new(),
                            preview,
                        });
                    }
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
        // Check if this was a user-initiated cancellation
        if state.sidecar_cancelled.load(Ordering::SeqCst) {
            // User cancelled — treat as a graceful stop, not an error
            let all_thinking = merge_thinking_segments(&committed_thinking, &active_thinking);
            let partial_content =
                build_assistant_message_content(&all_thinking, &full_response, &assistant_timeline);
            if !partial_content.trim().is_empty() {
                persist_assistant_message(state, &session_id, profile_id, &partial_content)?;
            }
            // Clear sidecar PID
            {
                let mut active = state
                    .active_sidecar
                    .lock()
                    .expect("active_sidecar lock poisoned");
                *active = None;
            }
            let usage = done_usage.unwrap_or_else(|| UsageInfo {
                input_tokens: 0,
                output_tokens: 0,
                model: profile.model.clone(),
            });
            let _ = app_handle.emit(
                "agent:stream",
                &StreamChunk::Done {
                    usage,
                    remote_session_id: final_remote_session_id,
                },
            );
            return Ok(AgentRunResult {
                session_id: Some(session_id),
                message: None,
                suggested_patch: None,
                full_output: Some(full_response.clone()),
            });
        }

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
        let all_thinking = merge_thinking_segments(&committed_thinking, &active_thinking);
        let partial_content =
            build_assistant_message_content(&all_thinking, &full_response, &assistant_timeline);
        if !partial_content.trim().is_empty() {
            persist_assistant_message(state, &session_id, profile_id, &partial_content)?;
        }
        persist_assistant_message(
            state,
            &session_id,
            profile_id,
            &format!("Error: {error_message}"),
        )?;
        return Err(anyhow::anyhow!("agent sidecar failed: {error_message}"));
    }

    let all_thinking = merge_thinking_segments(&committed_thinking, &active_thinking);
    let final_content =
        build_assistant_message_content(&all_thinking, &full_response, &assistant_timeline);
    if !final_content.trim().is_empty() {
        persist_assistant_message(state, &session_id, profile_id, &final_content)?;
    } else if let Some(error_message) = last_error {
        persist_assistant_message(
            state,
            &session_id,
            profile_id,
            &format!("Error: {error_message}"),
        )?;
    }

    if let Some(remote_session_id) = final_remote_session_id.as_deref() {
        persist_remote_session_id(state, &session_id, remote_session_id)?;
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

    // Clear sidecar PID
    {
        let mut active = state
            .active_sidecar
            .lock()
            .expect("active_sidecar lock poisoned");
        *active = None;
    }

    let _ = app_handle.emit(
        "agent:stream",
        &StreamChunk::Done {
            usage,
            remote_session_id: final_remote_session_id,
        },
    );

    Ok(AgentRunResult {
        session_id: Some(session_id),
        message: None,
        suggested_patch: None,
        full_output: Some(full_response),
    })
}

pub fn apply_agent_patch(root_path: &str, file_path: &str, content: &str) -> Result<()> {
    let absolute = Path::new(root_path).join(file_path);
    std::fs::write(absolute, content).context("failed to apply agent patch")?;
    Ok(())
}

pub fn cancel_agent(state: &AppState) -> Result<bool> {
    let mut active = state
        .active_sidecar
        .lock()
        .expect("active_sidecar lock poisoned");
    if let Some(pid) = active.take() {
        // Mark as user-initiated cancellation so run_agent knows not to
        // treat the non-zero exit code as an error.
        state.sidecar_cancelled.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        {
            // Kill entire process group (sidecar + Claude CLI children).
            // The sidecar is spawned with process_group(0), so its PID == PGID.
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &format!("-{}", pid)])
                .output();
            // Fallback: also signal the specific PID in case pgid kill missed it
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .output();
        }
        #[cfg(not(unix))]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .output();
        }
        Ok(true)
    } else {
        Ok(false)
    }
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
    let project_root = {
        let config = state
            .project_config
            .read()
            .expect("project config lock poisoned");
        config.root_path.clone()
    };
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
        WHERE s.project_dir = ?1
        GROUP BY s.id
        ORDER BY datetime(s.updated_at) DESC, datetime(s.created_at) DESC
        ",
    )?;

    let rows = stmt.query_map(params![project_root], |row| {
        let title: String = row.get(2)?;
        let last_message: String = row.get(6)?;
        let preview_source = sanitize_agent_message_for_display(&last_message);
        Ok(AgentSessionSummary {
            id: row.get(0)?,
            profile_id: row.get(1)?,
            title: if title.trim().is_empty() {
                build_session_title(&preview_source)
            } else {
                title
            },
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
            message_count: row.get(5)?,
            last_message_preview: truncate_preview(&preview_source, 80),
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

fn read_remote_session_id(
    conn: &rusqlite::Connection,
    session_id: Option<&str>,
) -> Result<Option<String>> {
    let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };

    let remote_session_id = conn
        .query_row(
            "SELECT remote_session_id FROM sessions WHERE id=?1 LIMIT 1",
            params![session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    Ok(remote_session_id.filter(|value| !value.trim().is_empty()))
}

fn persist_remote_session_id(
    state: &AppState,
    session_id: &str,
    remote_session_id: &str,
) -> Result<()> {
    let conn = state.db.lock().expect("db lock poisoned");
    conn.execute(
        "UPDATE sessions SET remote_session_id=?2 WHERE id=?1",
        params![session_id, remote_session_id],
    )?;
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

fn build_assistant_message_content(
    thinking: &str,
    text: &str,
    timeline: &[AssistantTimelineItem],
) -> String {
    let mut parts = Vec::new();
    let trimmed_thinking = thinking.trim();
    if !trimmed_thinking.is_empty() {
        parts.push(format!("<think>\n{trimmed_thinking}\n</think>"));
    }
    // Strip any <think> blocks already present in the model's text output
    // to avoid duplication with the system-managed thinking above.
    let sanitized_text = sanitize_agent_message_for_display(text);
    if timeline.is_empty() {
        if !sanitized_text.trim().is_empty() {
            parts.push(sanitized_text);
        }
        return parts.join("\n");
    }
    for item in timeline {
        match item {
            AssistantTimelineItem::Text(content) => {
                let cleaned = sanitize_agent_message_for_display(content);
                if !cleaned.trim().is_empty() {
                    parts.push(cleaned);
                }
            }
            AssistantTimelineItem::Tool {
                tool_id,
                tool_use_id,
                status,
                args,
                preview,
            } => {
                let mut lines = vec![format!("[Tool: {tool_id}]")];
                if !tool_use_id.is_empty() {
                    lines.push(format!("[ToolUseId: {tool_use_id}]"));
                }
                if !args.is_empty() {
                    lines.push("[Args]".into());
                    lines.push(args.clone());
                    lines.push("[/Args]".into());
                }
                lines.push(format!("[Status: {status}]"));
                if !preview.is_empty() {
                    lines.push("[Result]".into());
                    lines.push(preview.clone());
                    lines.push("[/Result]".into());
                }
                parts.push(lines.join("\n"));
            }
        }
    }
    parts.join("\n")
}

#[derive(Debug, Clone)]
enum AssistantTimelineItem {
    Text(String),
    Tool {
        tool_id: String,
        tool_use_id: String,
        status: String,
        args: String,
        preview: String,
    },
}

fn push_timeline_text(timeline: &mut Vec<AssistantTimelineItem>, content: &str) {
    if content.is_empty() {
        return;
    }

    match timeline.last_mut() {
        Some(AssistantTimelineItem::Text(existing)) => existing.push_str(content),
        _ => timeline.push(AssistantTimelineItem::Text(content.to_string())),
    }
}

fn merge_thinking_segments(committed: &str, active: &str) -> String {
    let trimmed_committed = committed.trim();
    let trimmed_active = active.trim();

    match (trimmed_committed.is_empty(), trimmed_active.is_empty()) {
        (true, true) => String::new(),
        (false, true) => trimmed_committed.to_string(),
        (true, false) => trimmed_active.to_string(),
        (false, false) if trimmed_committed == trimmed_active => trimmed_committed.to_string(),
        (false, false) => format!("{trimmed_committed}\n\n{trimmed_active}"),
    }
}

fn sanitize_agent_message_for_display(content: &str) -> String {
    strip_tagged_block(content, "<think>", "</think>")
        .replace("<think>", "")
        .replace("</think>", "")
        .trim()
        .to_string()
}

fn strip_tagged_block(content: &str, open_tag: &str, close_tag: &str) -> String {
    let mut output = content.to_string();
    while let Some(start) = output.find(open_tag) {
        let after_open = start + open_tag.len();
        if let Some(end_rel) = output[after_open..].find(close_tag) {
            let end = after_open + end_rel + close_tag.len();
            output.replace_range(start..end, "");
        } else {
            output.replace_range(start..output.len(), "");
            break;
        }
    }
    output
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
