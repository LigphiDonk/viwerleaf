use std::process::{Child, ChildStdin, Command, Stdio};

use anyhow::{Context, Result};

use crate::state::AppState;

/// Spawn claude or codex CLI as a child process and return the child + stdin.
///
/// For `claude-code`:
///   claude -p "<message>" --print --output-format stream-json \
///       --cwd <project_root> [--resume <remote_session_id>] \
///       [--append-system-prompt "<system_prompt>"]
///
/// For `codex`:
///   codex -p "<message>" --full-auto \
///       --cwd <project_root>
///
/// The caller reads `child.stdout` line-by-line for JSON stream chunks,
/// identical to the old sidecar runner output format.
pub fn spawn_cli_agent(
    state: &AppState,
    vendor: &str,
    user_message: &str,
    project_root: &str,
    system_prompt: &str,
    remote_session_id: Option<&str>,
) -> Result<(Child, ChildStdin)> {
    let enriched_path = crate::services::enriched_path();

    let mut cmd = match vendor {
        "codex" => {
            let mut c = Command::new("codex");
            c.args(["-p", user_message, "--full-auto"]);
            if !project_root.is_empty() {
                c.args(["--cwd", project_root]);
            }
            c
        }
        _ => {
            // Default: claude-code
            let mut c = Command::new("claude");
            c.args([
                "-p",
                user_message,
                "--print",
                "--output-format",
                "stream-json",
            ]);
            if !project_root.is_empty() {
                c.args(["--cwd", project_root]);
            }
            if let Some(rsid) = remote_session_id {
                if !rsid.is_empty() {
                    c.args(["--resume", rsid]);
                }
            }
            if !system_prompt.is_empty() {
                c.args(["--append-system-prompt", system_prompt]);
            }
            c
        }
    };

    cmd.env("PATH", &enriched_path);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Reset the cancelled flag before launch
    state
        .sidecar_cancelled
        .store(false, std::sync::atomic::Ordering::SeqCst);

    let mut child = cmd.spawn().with_context(|| {
        format!(
            "failed to spawn CLI agent '{}'. Is it installed and on PATH?",
            if vendor == "codex" { "codex" } else { "claude" }
        )
    })?;

    let stdin = child.stdin.take().context("CLI agent stdin unavailable")?;

    Ok((child, stdin))
}
