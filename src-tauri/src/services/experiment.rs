use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager};

use crate::models::AgentTaskContext;
use crate::services::agent;
use crate::state::AppState;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};


/// PID of the experiment's own sidecar agent process (0 = none).
pub static EXPERIMENT_SIDECAR_PID: AtomicU32 = AtomicU32::new(0);
/// Flag set by stop_auto_experiment to signal the daemon loop to exit.
pub static EXPERIMENT_STOP_FLAG: AtomicBool = AtomicBool::new(false);
/// Flag set by pause_auto_experiment; daemon transitions to paused at next check.
pub static EXPERIMENT_PAUSE_FLAG: AtomicBool = AtomicBool::new(false);
/// Guard: only one experiment can run at a time.
pub static EXPERIMENT_RUNNING: AtomicBool = AtomicBool::new(false);
/// Root path of the project that owns the currently running experiment.
pub static EXPERIMENT_ROOT_PATH: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// Check if an experiment is running for a specific project root.
pub fn is_experiment_running_for(root: &str) -> bool {
    if !EXPERIMENT_RUNNING.load(Ordering::SeqCst) {
        return false;
    }
    if let Ok(lock) = EXPERIMENT_ROOT_PATH.lock() {
        *lock == root
    } else {
        false
    }
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentRunState {
    pub status: String,
    pub iterations: u32,
    pub best_metric_value: Option<f64>,
    #[serde(default)]
    pub run_history: Vec<serde_json::Value>,
    #[serde(default)]
    pub max_failures: u32,
    #[serde(default)]
    pub current_failures: u32,
    pub session_id: Option<String>,
    pub start_time_ms: Option<u128>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentLoopConfig {
    pub enabled: bool,
    pub remote_node: String,
    pub eval_command: String,
    pub success_metric: String,
    pub success_direction: String,
    pub success_threshold: f64,
    pub max_iterations: u32,
    pub max_failures: u32,
    pub max_duration_minutes: u32,
    pub result_paths: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutomatePayload {
    pub profile_id: String,
    pub session_id: String,
    pub file_path: String,
    pub task_context: AgentTaskContext,
    pub loop_config: ExperimentLoopConfig,
}



/// Log entry emitted to the frontend via `experiment:log` events.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ExperimentLogEntry {
    timestamp: String,
    level: String,
    message: String,
    iteration: u32,
}

/// Emit a structured log event to the frontend.
fn emit_log(app_handle: &AppHandle, level: &str, message: &str, iteration: u32) {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();
    let entry = ExperimentLogEntry {
        timestamp,
        level: level.to_string(),
        message: message.to_string(),
        iteration,
    };
    let _ = app_handle.emit("experiment:log", &entry);
}

pub fn run_auto_experiment(app_handle: AppHandle, payload: AutomatePayload) -> Result<(), String> {
    // Single-instance guard
    if EXPERIMENT_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("An experiment is already running".into());
    }

    // Reset flags before starting
    EXPERIMENT_STOP_FLAG.store(false, Ordering::SeqCst);
    EXPERIMENT_PAUSE_FLAG.store(false, Ordering::SeqCst);

    EXPERIMENT_SIDECAR_PID.store(0, Ordering::SeqCst);

    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let root_path = {
            let config = state.project_config.read().unwrap();
            config.root_path.clone()
        };

        // Track which project owns this experiment
        if let Ok(mut lock) = EXPERIMENT_ROOT_PATH.lock() {
            *lock = root_path.clone();
        }

        let task_id = payload.task_context.task_id.clone();

        let run_state_path =
            Path::new(&root_path).join(".viewerleaf/research/Experiment/automation/run-state.json");
        if let Some(parent) = run_state_path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        // Stabilize session ID
        let stable_session_id = if payload.session_id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            payload.session_id.clone()
        };

        // ── Write authoritative initial state BEFORE entering loop ──
        // This prevents the race where the daemon reads a stale stopped/completed
        // file left over from a previous run.
        {
            let initial = ExperimentRunState {
                status: "running".into(),
                iterations: 0,
                best_metric_value: None,
                run_history: Vec::new(),
                max_failures: payload.loop_config.max_failures,
                current_failures: 0,
                session_id: Some(stable_session_id.clone()),
                start_time_ms: Some(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis(),
                ),
            };
            let _ = fs::write(
                &run_state_path,
                serde_json::to_string_pretty(&initial).unwrap(),
            );
        }

        emit_log(&app_handle, "info", &format!("🧪 Auto-experiment started (max {} iterations, metric: {} {} {})",
            payload.loop_config.max_iterations,
            payload.loop_config.success_metric,
            payload.loop_config.success_direction,
            payload.loop_config.success_threshold,
        ), 0);

        loop {
            // ── Check stop flag at top of every iteration ──
            if EXPERIMENT_STOP_FLAG.load(Ordering::SeqCst) {
                let mut run_state: ExperimentRunState =
                    serde_json::from_str(&fs::read_to_string(&run_state_path).unwrap_or_default())
                        .unwrap_or_default();
                run_state.status = "stopped".into();
                let _ = fs::write(
                    &run_state_path,
                    serde_json::to_string_pretty(&run_state).unwrap(),
                );
                emit_log(&app_handle, "warn", "⏹ Experiment stopped by user", run_state.iterations);
                break;
            }

            // 1. Load current run-state (always exists because we wrote it above)
            let mut run_state: ExperimentRunState =
                serde_json::from_str(&fs::read_to_string(&run_state_path).unwrap_or_default())
                    .unwrap_or_default();
            let active_session_id = run_state
                .session_id
                .clone()
                .unwrap_or_else(|| stable_session_id.clone());

            // Exit or pause conditions
            // Check pause FLAG (set by frontend command, not file)
            if EXPERIMENT_PAUSE_FLAG.load(Ordering::SeqCst) {
                run_state.status = "paused".into();
                let _ = fs::write(
                    &run_state_path,
                    serde_json::to_string_pretty(&run_state).unwrap(),
                );
                // Sleep-poll while paused; daemon stays alive so Resume works
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    if EXPERIMENT_STOP_FLAG.load(Ordering::SeqCst) {
                        run_state.status = "stopped".into();
                        let _ = fs::write(
                            &run_state_path,
                            serde_json::to_string_pretty(&run_state).unwrap(),
                        );
                        break;
                    }
                    if !EXPERIMENT_PAUSE_FLAG.load(Ordering::SeqCst) {
                        // Resume flag cleared — write running and continue
                        run_state.status = "running".into();
                        let _ = fs::write(
                            &run_state_path,
                            serde_json::to_string_pretty(&run_state).unwrap(),
                        );
                        break;
                    }
                }
                continue; // Re-enter outer loop to re-load state and check conditions
            }
            if run_state.status != "running" {
                break; // completed / stopped / failed — exit daemon
            }
            if run_state.iterations >= payload.loop_config.max_iterations {
                run_state.status = "stopped".into();
                let _ = fs::write(
                    &run_state_path,
                    serde_json::to_string_pretty(&run_state).unwrap(),
                );
                break;
            }
            if run_state.current_failures >= payload.loop_config.max_failures
                && payload.loop_config.max_failures > 0
            {
                run_state.status = "failed".into();
                let _ = fs::write(
                    &run_state_path,
                    serde_json::to_string_pretty(&run_state).unwrap(),
                );
                break;
            }
            if let Some(start) = run_state.start_time_ms {
                let current_time = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis();
                let elapsed_mins = (current_time.saturating_sub(start)) as f64 / 60000.0;
                if elapsed_mins >= payload.loop_config.max_duration_minutes as f64
                    && payload.loop_config.max_duration_minutes > 0
                {
                    run_state.status = "stopped".into();
                    let _ = fs::write(
                        &run_state_path,
                        serde_json::to_string_pretty(&run_state).unwrap(),
                    );
                    break;
                }
            }

            // 2. Build injection prompt
            let iter_num = run_state.iterations + 1;
            emit_log(&app_handle, "info", &format!("🚀 Starting iteration {}/{}",
                iter_num, payload.loop_config.max_iterations), iter_num);

            let mut prompt = format!(
                "Starting auto-experiment iteration {}/{}...\n",
                iter_num,
                payload.loop_config.max_iterations
            );
            if let Some(best) = run_state.best_metric_value {
                prompt.push_str(&format!(
                    "Current best metric ({}) value so far: {}\n",
                    payload.loop_config.success_metric, best
                ));
            }
            prompt.push_str(&format!(
                "Goal Threshold: {} ({})\n",
                payload.loop_config.success_threshold, payload.loop_config.success_direction
            ));
            prompt.push_str(&format!(
                "Evaluation Command: `{}`\n",
                payload.loop_config.eval_command
            ));
            if !payload.loop_config.result_paths.is_empty() {
                prompt.push_str(&format!(
                    "Paths to sync/fetch after experiment: {}\n",
                    payload.loop_config.result_paths.join(", ")
                ));
            }
            prompt.push_str("\nYou are responsible for the FULL workflow:\n");
            prompt.push_str("1. Modify the code locally as needed\n");
            prompt.push_str("2. Use `compute-helper sync up` to synchronize code to the server\n");
            prompt.push_str("3. Use `compute-helper run` to execute the evaluation command on the server\n");
            if !payload.loop_config.result_paths.is_empty() {
                prompt.push_str("4. Use `compute-helper sync down` to pull back result files if needed\n");
            }
            prompt.push_str(&format!(
                "\nIMPORTANT: After running the eval command, the output MUST contain a JSON line like `{{\"{}\": 0.95}}` with the metric value. The orchestrator will parse this from your output.\n",
                payload.loop_config.success_metric
            ));

            emit_log(&app_handle, "info", "🤖 Calling AI agent...", iter_num);

            // 3. Call Agent (Blocks until complete or error)
            // Pass &EXPERIMENT_SIDECAR_PID directly so run_agent writes the PID
            // into our dedicated atomic without polling the global slot.
            let result = agent::run_agent(
                &app_handle,
                &state,
                &payload.profile_id,
                Some(&active_session_id),
                &payload.file_path,
                "",
                Some(&prompt),
                true,
                Some(&payload.task_context),
                Some(&EXPERIMENT_SIDECAR_PID),
            );

            // Agent finished; clear its PID so stop doesn't kill a stale process
            EXPERIMENT_SIDECAR_PID.store(0, Ordering::SeqCst);

            run_state.iterations += 1;
            let iter_num = run_state.iterations;

            // ── Check stop flag after agent returns ──
            if EXPERIMENT_STOP_FLAG.load(Ordering::SeqCst) {
                run_state.status = "stopped".into();
                let _ = fs::write(
                    &run_state_path,
                    serde_json::to_string_pretty(&run_state).unwrap(),
                );
                emit_log(&app_handle, "warn", "⏹ Experiment stopped by user", iter_num);
                break;
            }

            match result {
                Err(_) => {
                    run_state.current_failures += 1;
                    emit_log(&app_handle, "error", &format!("❌ Agent failed (failures: {}/{})",
                        run_state.current_failures, payload.loop_config.max_failures), iter_num);
                    run_state.run_history.push(serde_json::json!({
                        "iteration": iter_num,
                        "metricValue": null,
                        "status": "agent_error"
                    }));
                }
                Ok(agent_result) => {
                    emit_log(&app_handle, "info", "✅ Agent completed successfully", iter_num);

                    // Parse metric from agent's full output (text + tool outputs)
                    let agent_output = agent_result.full_output.unwrap_or_default();
                    let parsed_val = parse_metric_from_output(
                        &agent_output,
                        &payload.loop_config.success_metric,
                    );

                    if let Some(val) = parsed_val {
                        run_state.current_failures = 0;
                        let is_better = match (
                            run_state.best_metric_value,
                            payload.loop_config.success_direction.as_str(),
                        ) {
                            (None, _) => true,
                            (Some(best), "max") => val > best,
                            (Some(best), "min") => val < best,
                            (Some(_), _) => true,
                        };
                        if is_better {
                            run_state.best_metric_value = Some(val);
                        }

                        emit_log(&app_handle, "info", &format!(
                            "📈 {}={:.4} (best={}, threshold={})",
                            payload.loop_config.success_metric, val,
                            run_state.best_metric_value.map(|v| format!("{:.4}", v)).unwrap_or("—".into()),
                            payload.loop_config.success_threshold
                        ), iter_num);

                        run_state.run_history.push(serde_json::json!({
                            "iteration": iter_num,
                            "metricValue": val,
                            "status": "success"
                        }));

                        let meets_goal =
                            if payload.loop_config.success_direction == "max" {
                                val >= payload.loop_config.success_threshold
                            } else {
                                val <= payload.loop_config.success_threshold
                            };

                        if meets_goal {
                            run_state.status = "completed".into();
                            emit_log(&app_handle, "info", &format!(
                                "🎯 Goal met! {}={:.4} {} {}",
                                payload.loop_config.success_metric, val,
                                if payload.loop_config.success_direction == "max" { "≥" } else { "≤" },
                                payload.loop_config.success_threshold
                            ), iter_num);
                            mark_experiment_task_done(&root_path, &task_id);
                        }
                    } else {
                        run_state.current_failures += 1;
                        emit_log(&app_handle, "warn", &format!(
                            "⚠️ Could not parse metric '{}' from agent output (failures: {}/{})",
                            payload.loop_config.success_metric,
                            run_state.current_failures, payload.loop_config.max_failures
                        ), iter_num);
                        run_state.run_history.push(serde_json::json!({
                            "iteration": iter_num,
                            "metricValue": null,
                            "status": "parse_error"
                        }));
                    }
                }
            }

            let _ = fs::write(
                &run_state_path,
                serde_json::to_string_pretty(&run_state).unwrap(),
            );

            // Allow state to flush and avoid runaway loops if they instantly exit
            std::thread::sleep(std::time::Duration::from_secs(2));
        }

        // Release single-instance guard and clear root path
        EXPERIMENT_RUNNING.store(false, Ordering::SeqCst);
        if let Ok(mut lock) = EXPERIMENT_ROOT_PATH.lock() {
            lock.clear();
        }
    });

    Ok(())
}

pub fn stop_auto_experiment() {
    // 1. Set stop flag so the loop exits at the next check point
    EXPERIMENT_STOP_FLAG.store(true, Ordering::SeqCst);

    // 2. Kill the experiment's own sidecar agent process (NOT the global cancel_agent)
    let sidecar_pid = EXPERIMENT_SIDECAR_PID.swap(0, Ordering::SeqCst);
    if sidecar_pid != 0 {
        #[cfg(unix)]
        {
            // Kill the process group first (same strategy as cancel_agent)
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &format!("-{}", sidecar_pid)])
                .output();
            // Fallback: signal the specific PID
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &sidecar_pid.to_string()])
                .output();
        }
    }

    // Do NOT release EXPERIMENT_RUNNING here — let the daemon thread
    // do it when it actually exits, to prevent a second experiment
    // from entering while the old thread is still cleaning up.
}

pub fn pause_auto_experiment() {
    EXPERIMENT_PAUSE_FLAG.store(true, Ordering::SeqCst);
}

pub fn resume_auto_experiment() {
    EXPERIMENT_PAUSE_FLAG.store(false, Ordering::SeqCst);
}

/// Parse a metric value from agent output text.
/// Scans each line for a JSON object containing the given metric key.
fn parse_metric_from_output(output: &str, metric_key: &str) -> Option<f64> {
    for line in output.lines().rev() {
        let trimmed = line.trim();
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
            if let Some(v) = json.get(metric_key).and_then(|val| val.as_f64()) {
                return Some(v);
            }
        }
    }
    None
}

/// Mark the specific experiment task as done in tasks.json.
fn mark_experiment_task_done(root_path: &str, task_id: &str) {
    let tasks_path = Path::new(root_path).join(".pipeline/tasks/tasks.json");
    if !tasks_path.exists() {
        return;
    }

    let raw = match fs::read_to_string(&tasks_path) {
        Ok(r) => r,
        Err(_) => return,
    };

    let mut doc: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return,
    };

    if let Some(tasks) = doc.get_mut("tasks").and_then(|t| t.as_array_mut()) {
        for task in tasks.iter_mut() {
            let id = task.get("id").and_then(|s| s.as_str()).unwrap_or("");
            if id == task_id {
                task.as_object_mut().map(|obj| {
                    obj.insert("status".into(), serde_json::Value::String("done".into()));
                });
                break;
            }
        }
    }

    let _ = fs::write(
        &tasks_path,
        serde_json::to_string_pretty(&doc).unwrap_or_default(),
    );
}
