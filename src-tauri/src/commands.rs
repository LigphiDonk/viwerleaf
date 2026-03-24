use std::fs;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::desktop_menu;
use crate::models::{
    AgentMessage, AgentRunResult, AgentSessionSummary, AgentTaskContext,
    ApplyResearchTaskSuggestionRequest, AssetResource, CliAgentStatus, FigureBriefDraft,
    GeneratedAsset, LiteratureCandidate, LiteratureItem, LiteratureSearchResult, ProfileConfig,
    ProjectConfig, ProjectFile, ProviderConfig, SkillManifest, TerminalSessionInfo, TestResult,
    UsageRecord, WorkspaceSnapshot, ZoteroSearchResult,
};
use crate::services::{
    agent, compile, figure, literature, profile, project, provider, research, sidecar, skill, sync,
    terminal, worker,
};
use crate::state::AppState;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZoteroImportPayload {
    item_key: String,
    title: String,
    #[serde(default)]
    authors: Vec<String>,
    #[serde(default)]
    year: i32,
    #[serde(default)]
    journal: String,
    #[serde(default)]
    doi: String,
    #[serde(default, rename = "abstract")]
    abstract_text: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    library_id: String,
    #[serde(default)]
    zotero_version: i64,
    #[serde(default)]
    notes: Vec<String>,
    #[serde(default)]
    fulltext: String,
}

fn chunk_fulltext(text: &str, max_chars: usize) -> Vec<(i32, String)> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut index = 0;

    for paragraph in text.split("\n\n") {
        let trimmed = paragraph.trim();
        if trimmed.is_empty() {
            continue;
        }

        let separator = if current.is_empty() { 0 } else { 2 };
        if !current.is_empty()
            && current.chars().count() + separator + trimmed.chars().count() > max_chars
        {
            chunks.push((index, current.trim().to_string()));
            index += 1;
            current.clear();
        }

        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(trimmed);
    }

    if !current.trim().is_empty() {
        chunks.push((index, current.trim().to_string()));
    }

    chunks
}

#[tauri::command]
pub async fn open_project(app_handle: AppHandle) -> Result<WorkspaceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        project::load_project_snapshot(&state).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn read_file(app_handle: AppHandle, path: String) -> Result<ProjectFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        project::read_file(&state, &path).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn read_asset(app_handle: AppHandle, path: String) -> Result<AssetResource, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        project::read_asset(&state, &path).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn switch_project(
    app_handle: AppHandle,
    root_path: String,
) -> Result<WorkspaceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        project::switch_project(&state, Path::new(&root_path)).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn create_project(
    app_handle: AppHandle,
    parent_dir: String,
    project_name: String,
) -> Result<WorkspaceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        project::create_project(&state, Path::new(&parent_dir), &project_name)
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn ensure_research_scaffold(
    app_handle: AppHandle,
    start_stage: Option<String>,
) -> Result<WorkspaceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let root_path = state
            .project_config
            .read()
            .map_err(|err| err.to_string())?
            .root_path
            .clone();
        if root_path.trim().is_empty() {
            return Err("no active project".into());
        }

        research::ensure_research_scaffold(
            &state.skills_dir,
            Path::new(&root_path),
            start_stage.as_deref(),
        )
        .map_err(|err| err.to_string())?;
        let conn = state.db.lock().map_err(|err| err.to_string())?;
        skill::refresh_skill_registry(&conn, &state.skills_dir, Some(Path::new(&root_path)))
            .map_err(|err| err.to_string())?;
        drop(conn);
        project::load_project_snapshot(&state).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn initialize_research_stage(
    app_handle: AppHandle,
    stage: String,
) -> Result<WorkspaceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let root_path = state
            .project_config
            .read()
            .map_err(|err| err.to_string())?
            .root_path
            .clone();
        if root_path.trim().is_empty() {
            return Err("no active project".into());
        }

        research::initialize_research_stage(Path::new(&root_path), &stage)
            .map_err(|err| err.to_string())?;
        project::load_project_snapshot(&state).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn launch_workspace_window(root_path: Option<String>) -> Result<bool, String> {
    desktop_menu::launch_workspace_window(root_path.as_deref())
        .map(|_| true)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn sync_app_menu(
    app_handle: AppHandle,
    auto_save: bool,
    compile_on_save: bool,
    active_workspace_root: String,
    recent_workspaces: Vec<desktop_menu::WorkspaceMenuEntry>,
) -> Result<bool, String> {
    let state = desktop_menu::AppMenuState {
        auto_save,
        compile_on_save,
        active_workspace_root,
        recent_workspaces,
    };

    desktop_menu::sync_menu_state(&app_handle, &state)
        .map(|_| true)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn save_file(
    app_handle: AppHandle,
    file_path: String,
    content: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        project::save_file(&state, &file_path, &content)
            .map(|_| true)
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn update_project_config(
    app_handle: AppHandle,
    config: ProjectConfig,
) -> Result<ProjectConfig, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        project::update_project_config(&state, &config).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn compile_project(
    app_handle: AppHandle,
    file_path: String,
) -> Result<crate::models::CompileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        compile::compile_project(&state, &file_path).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn get_compile_environment() -> Result<crate::models::CompileEnvironmentStatus, String> {
    Ok(compile::detect_compile_environment())
}

#[tauri::command]
pub fn forward_search(
    state: State<'_, AppState>,
    file_path: String,
    line: usize,
    column: Option<usize>,
) -> Result<crate::models::SyncLocation, String> {
    sync::forward_search(&state, &file_path, line, column.unwrap_or(1))
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn reverse_search(
    state: State<'_, AppState>,
    page: usize,
    h: Option<f64>,
    v: Option<f64>,
) -> Result<crate::models::SyncLocation, String> {
    sync::reverse_search(&state, page, h, v).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn run_agent(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    session_id: Option<String>,
    file_path: String,
    selected_text: String,
    user_message: Option<String>,
    task_mode: Option<bool>,
    task_context: Option<AgentTaskContext>,
) -> Result<AgentRunResult, String> {
    // Resolve session_id eagerly so we can return it immediately to the frontend.
    let resolved_session_id = session_id
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Pre-insert the user message synchronously so the DB is consistent.
    agent::prepare_user_message(
        &state,
        &profile_id,
        &resolved_session_id,
        &file_path,
        user_message.as_deref().unwrap_or_default(),
    )
    .map_err(|err| format!("{err:#}"))?;

    let app_handle2 = app_handle.clone();
    let profile_id2 = profile_id.clone();
    let session_id2 = resolved_session_id.clone();
    let file_path2 = file_path.clone();
    let selected_text2 = selected_text.clone();
    let user_message2 = user_message.clone();
    let task_mode2 = task_mode.unwrap_or(false);
    let task_context2 = task_context.clone();

    // Run the blocking sidecar I/O on a dedicated thread so the command
    // returns immediately and does not freeze the frontend invoke() call.
    tauri::async_runtime::spawn_blocking(move || {
        let state_ref = app_handle2.state::<AppState>();
        if let Err(err) = agent::run_agent(
            &app_handle2,
            &state_ref,
            &profile_id2,
            Some(&session_id2),
            &file_path2,
            &selected_text2,
            user_message2.as_deref(),
            task_mode2,
            task_context2.as_ref(),
            None, // No PID capture needed for normal agent runs
        ) {
            let _ = app_handle2.emit(
                "agent:stream",
                &crate::models::StreamChunk::Error {
                    message: format!("{err:#}"),
                },
            );
        }
    });

    Ok(AgentRunResult {
        session_id: Some(resolved_session_id),
        message: None,
        suggested_patch: None,
    })
}

#[tauri::command]
pub fn run_auto_experiment(
    app_handle: AppHandle,
    payload: crate::services::experiment::AutomatePayload,
) -> Result<bool, String> {
    crate::services::experiment::run_auto_experiment(app_handle, payload)?;
    Ok(true)
}

#[tauri::command]
pub fn stop_auto_experiment() -> Result<bool, String> {
    crate::services::experiment::stop_auto_experiment();
    Ok(true)
}

#[tauri::command]
pub fn pause_auto_experiment() -> Result<bool, String> {
    crate::services::experiment::pause_auto_experiment();
    Ok(true)
}

#[tauri::command]
pub fn resume_auto_experiment() -> Result<bool, String> {
    crate::services::experiment::resume_auto_experiment();
    Ok(true)
}

#[tauri::command]
pub fn is_experiment_running(state: State<'_, AppState>) -> bool {
    let root_path = state.project_config.read().unwrap().root_path.clone();
    crate::services::experiment::is_experiment_running_for(&root_path)
}

#[tauri::command]
pub async fn apply_research_task_suggestion(
    app_handle: AppHandle,
    request: ApplyResearchTaskSuggestionRequest,
) -> Result<WorkspaceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let root_path = state
            .project_config
            .read()
            .map_err(|err| err.to_string())?
            .root_path
            .clone();
        if root_path.trim().is_empty() {
            return Err("no active project".into());
        }
        research::apply_task_suggestion(Path::new(&root_path), &request)
            .map_err(|err| err.to_string())?;
        project::load_project_snapshot(&state).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn regenerate_pipeline_tasks(
    app_handle: AppHandle,
    force: Option<bool>,
    stage: Option<String>,
) -> Result<WorkspaceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let root_path = state
            .project_config
            .read()
            .map_err(|err| err.to_string())?
            .root_path
            .clone();
        if root_path.trim().is_empty() {
            return Err("no active project".into());
        }
        research::regenerate_pipeline_tasks(
            Path::new(&root_path),
            force.unwrap_or(false),
            stage.as_deref(),
        )
        .map_err(|err| err.to_string())?;
        project::load_project_snapshot(&state).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn apply_agent_patch(
    state: State<'_, AppState>,
    file_path: String,
    content: String,
) -> Result<bool, String> {
    let root_path = state
        .project_config
        .read()
        .map_err(|err| err.to_string())?
        .root_path
        .clone();

    agent::apply_agent_patch(&root_path, &file_path, &content)
        .map(|_| true)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn get_agent_messages(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<Vec<AgentMessage>, String> {
    agent::get_agent_messages(&state, session_id.as_deref()).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn list_agent_sessions(state: State<'_, AppState>) -> Result<Vec<AgentSessionSummary>, String> {
    agent::list_agent_sessions(&state).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn list_skills(state: State<'_, AppState>) -> Result<Vec<SkillManifest>, String> {
    let root_path = state
        .project_config
        .read()
        .map_err(|err| err.to_string())?
        .root_path
        .clone();
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    let project_root = (!root_path.trim().is_empty()).then(|| Path::new(&root_path));
    skill::refresh_skill_registry(&conn, &state.skills_dir, project_root)
        .map_err(|err| err.to_string())?;
    skill::list_skills(&conn)
}

#[tauri::command]
pub fn install_skill(
    state: State<'_, AppState>,
    skill: SkillManifest,
) -> Result<SkillManifest, String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    skill::install_skill(&conn, &skill)?;
    Ok(skill)
}

#[tauri::command]
pub fn enable_skill(
    state: State<'_, AppState>,
    skill_id: Option<String>,
    id: Option<String>,
    enabled: bool,
) -> Result<Option<SkillManifest>, String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    let target_id = skill_id.or(id).ok_or("missing skill id")?;
    skill::enable_skill(&conn, &target_id, enabled)
}

#[tauri::command]
pub fn list_providers(state: State<'_, AppState>) -> Result<Vec<ProviderConfig>, String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    provider::list_providers(&conn)
}

#[tauri::command]
pub fn add_provider(
    state: State<'_, AppState>,
    provider: Option<ProviderConfig>,
    config: Option<ProviderConfig>,
) -> Result<ProviderConfig, String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    let config = provider.or(config).ok_or("missing provider config")?;
    provider::add_provider(&conn, &config)?;
    Ok(config)
}

#[tauri::command]
pub fn update_provider(
    state: State<'_, AppState>,
    provider_id: Option<String>,
    patch: Option<serde_json::Value>,
    config: Option<ProviderConfig>,
) -> Result<Option<ProviderConfig>, String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;

    let final_config = if let Some(config) = config {
        config
    } else {
        let provider_id = provider_id.ok_or("missing provider id")?;
        let mut current = provider::get_provider(&conn, &provider_id)?;
        if let Some(patch) = patch {
            if let Some(name) = patch.get("name").and_then(|value| value.as_str()) {
                current.name = name.into();
            }
            if let Some(vendor) = patch.get("vendor").and_then(|value| value.as_str()) {
                current.vendor = vendor.into();
            }
            if let Some(base_url) = patch.get("baseUrl").and_then(|value| value.as_str()) {
                current.base_url = base_url.into();
            }
            if let Some(api_key) = patch.get("apiKey").and_then(|value| value.as_str()) {
                current.api_key = api_key.into();
            }
            if let Some(default_model) = patch.get("defaultModel").and_then(|value| value.as_str())
            {
                current.default_model = default_model.into();
            }
            if let Some(is_enabled) = patch.get("isEnabled").and_then(|value| value.as_bool()) {
                current.is_enabled = is_enabled;
            }
            if let Some(sort_order) = patch.get("sortOrder").and_then(|value| value.as_i64()) {
                current.sort_order = sort_order as i32;
            }
            if let Some(meta_json) = patch.get("metaJson").and_then(|value| value.as_str()) {
                current.meta_json = meta_json.into();
            }
        }
        current
    };

    provider::update_provider(&conn, &final_config)?;
    Ok(Some(final_config))
}

#[tauri::command]
pub fn delete_provider(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    provider::delete_provider(&conn, &id)
}

#[tauri::command]
pub async fn test_provider(app_handle: AppHandle, id: String) -> Result<TestResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().map_err(|err| err.to_string())?;
        let prov = provider::get_provider(&conn, &id)?;
        drop(conn);

        let start = Instant::now();
        let output = sidecar::run_sidecar(
            &state,
            "test-provider",
            &serde_json::json!({
                "vendor": prov.vendor,
                "baseUrl": prov.base_url,
                "apiKey": prov.api_key,
                "model": prov.default_model,
            })
            .to_string(),
        )
        .map_err(|err| err.to_string())?;
        let latency = start.elapsed().as_millis() as u64;

        if output.status.success() {
            Ok(TestResult {
                success: true,
                latency_ms: latency,
                error: None,
            })
        } else {
            Ok(TestResult {
                success: false,
                latency_ms: latency,
                error: Some(String::from_utf8_lossy(&output.stderr).to_string()),
            })
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> Result<Vec<ProfileConfig>, String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    profile::list_profiles(&conn)
}

#[tauri::command]
pub fn update_profile(state: State<'_, AppState>, config: ProfileConfig) -> Result<(), String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    profile::update_profile(&conn, &config)
}

#[tauri::command]
pub fn create_figure_brief(
    state: State<'_, AppState>,
    section_ref: Option<String>,
    file_path: Option<String>,
    selected_text: String,
) -> Result<FigureBriefDraft, String> {
    let section_ref = section_ref
        .or(file_path)
        .unwrap_or_else(|| "active-section".into());
    figure::create_brief(&state, &section_ref, &selected_text).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn run_figure_skill(
    state: State<'_, AppState>,
    brief_id: String,
) -> Result<FigureBriefDraft, String> {
    figure::run_figure_skill(&state, &brief_id).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn run_banana_generation(
    state: State<'_, AppState>,
    brief_id: String,
) -> Result<GeneratedAsset, String> {
    figure::run_banana_generation(&state, &brief_id).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn register_generated_asset(
    state: State<'_, AppState>,
    asset: GeneratedAsset,
) -> Result<GeneratedAsset, String> {
    figure::register_asset(&state, asset).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn insert_figure_snippet(
    state: State<'_, AppState>,
    file_path: String,
    asset_id: String,
    caption: String,
    line: usize,
) -> Result<serde_json::Value, String> {
    figure::insert_figure_snippet(&state, &file_path, &asset_id, &caption, line)
        .map(
            |(file_path, content)| serde_json::json!({ "filePath": file_path, "content": content }),
        )
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn get_usage_stats(state: State<'_, AppState>) -> Result<Vec<UsageRecord>, String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, provider_id, model, input_tokens, output_tokens, created_at FROM usage_logs ORDER BY created_at DESC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(UsageRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                provider_id: row.get(2)?,
                model: row.get(3)?,
                input_tokens: row.get(4)?,
                output_tokens: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn create_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), String> {
    let config = state.project_config.read().map_err(|err| err.to_string())?;
    let full_path = Path::new(&config.root_path).join(&path);
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(&full_path, &content).map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn create_folder(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let config = state.project_config.read().map_err(|err| err.to_string())?;
    let full_path = Path::new(&config.root_path).join(&path);
    fs::create_dir_all(&full_path).map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_file(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let config = state.project_config.read().map_err(|err| err.to_string())?;
    let full_path = Path::new(&config.root_path).join(&path);
    if full_path.is_dir() {
        fs::remove_dir_all(&full_path).map_err(|err| err.to_string())?;
    } else {
        fs::remove_file(&full_path).map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn read_pdf_binary(path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&path).map_err(|e| format!("failed to read PDF at {path}: {e}"))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn rename_file(
    state: State<'_, AppState>,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let config = state.project_config.read().map_err(|err| err.to_string())?;
    let root = Path::new(&config.root_path);
    let destination = root.join(&new_path);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::rename(root.join(&old_path), destination).map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn start_terminal(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalSessionInfo, String> {
    terminal::start_terminal(&window, &state, cwd.as_deref(), cols, rows)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<bool, String> {
    terminal::write_terminal(&state, &session_id, &data)
        .map(|_| true)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn resize_terminal(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<bool, String> {
    terminal::resize_terminal(&state, &session_id, cols, rows)
        .map(|_| true)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn close_terminal(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    terminal::close_terminal(&state, &session_id)
        .map(|_| true)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn prepare_worker_deploy_dir(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let app_root = crate::resolve_app_root(&app_handle);
    let template_dir = crate::resolve_worker_template_dir(&app_handle, &app_root);
    worker::prepare_worker_deploy_dir(&state, &template_dir)
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn cancel_agent(state: State<'_, AppState>) -> Result<bool, String> {
    agent::cancel_agent(&state).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn import_skill_from_git(
    app_handle: AppHandle,
    url: String,
) -> Result<SkillManifest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().map_err(|err| err.to_string())?;
        skill::import_skill_from_git(&conn, &state.app_data_dir, &url)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn remove_skill(
    state: State<'_, AppState>,
    skill_id: String,
    delete_files: Option<bool>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    skill::remove_skill(&conn, &skill_id, delete_files.unwrap_or(true))
}

#[tauri::command]
pub async fn detect_cli_agents(app_handle: AppHandle) -> Result<Vec<CliAgentStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let output =
            sidecar::run_sidecar(&state, "detect-cli", "").map_err(|err| err.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        serde_json::from_str::<Vec<CliAgentStatus>>(&stdout)
            .map_err(|err| format!("failed to parse CLI agent status: {err}"))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn detect_zotero_mcp(app_handle: AppHandle) -> Result<CliAgentStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let output =
            sidecar::run_sidecar(&state, "detect-zotero-mcp", "").map_err(|err| err.to_string())?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("failed to detect zotero-mcp: {stderr}"));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        serde_json::from_str::<CliAgentStatus>(&stdout)
            .map_err(|err| format!("failed to parse zotero-mcp status: {err}"))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn create_workspace_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn read_file_binary(app_handle: AppHandle, path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let root = state
            .project_config
            .read()
            .expect("project config lock poisoned")
            .root_path
            .clone();
        let absolute = Path::new(&root).join(&path);
        fs::read(&absolute).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn save_file_binary(
    app_handle: AppHandle,
    file_path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let root = state
            .project_config
            .read()
            .expect("project config lock poisoned")
            .root_path
            .clone();
        let absolute = Path::new(&root).join(&file_path);
        if let Some(parent) = absolute.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        fs::write(&absolute, &data).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

// ── Literature Management Commands ──

#[tauri::command]
pub fn list_literature(state: State<'_, AppState>) -> Result<Vec<LiteratureItem>, String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    literature::list_items(&conn)
}

#[tauri::command]
pub fn list_literature_inbox(
    state: State<'_, AppState>,
) -> Result<Vec<LiteratureCandidate>, String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    literature::list_inbox(&conn)
}

#[tauri::command]
pub fn list_literature_attachments(
    state: State<'_, AppState>,
    literature_id: String,
) -> Result<Vec<crate::models::LiteratureAttachment>, String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    literature::list_attachments(&conn, &literature_id)
}

#[tauri::command]
pub fn add_literature(state: State<'_, AppState>, item: LiteratureItem) -> Result<(), String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    literature::add_item(&conn, &item)
}

#[tauri::command]
pub async fn add_literature_with_pdf(
    app_handle: AppHandle,
    item: LiteratureItem,
    source_path: String,
) -> Result<LiteratureItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let root_path = state
            .project_config
            .read()
            .map_err(|err| err.to_string())?
            .root_path
            .clone();
        if root_path.trim().is_empty() {
            return Err("no active project".into());
        }

        let mut conn = state.db.lock().map_err(|err| err.to_string())?;
        literature::add_item_with_pdf(
            &mut conn,
            &item,
            Path::new(&source_path),
            Path::new(&root_path),
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn delete_literature(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    literature::delete_item(&conn, &id)
}

#[tauri::command]
pub fn add_literature_candidate(
    state: State<'_, AppState>,
    candidate: LiteratureCandidate,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    literature::add_to_inbox(&conn, &candidate)
}

#[tauri::command]
pub fn approve_literature_candidate(
    state: State<'_, AppState>,
    inbox_id: String,
) -> Result<LiteratureItem, String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    literature::approve_candidate(&conn, &inbox_id)
}

#[tauri::command]
pub fn update_literature_notes(
    state: State<'_, AppState>,
    id: String,
    notes: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    literature::update_notes(&conn, &id, &notes)
}

#[tauri::command]
pub fn search_literature(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<LiteratureSearchResult>, String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    literature::search(&conn, &query)
}

#[tauri::command]
pub async fn search_zotero_literature(
    app_handle: AppHandle,
    query: String,
) -> Result<Vec<ZoteroSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let payload = serde_json::json!({
            "query": query,
            "limit": 12,
        });

        let output = sidecar::run_sidecar(&state, "search-zotero-literature", &payload.to_string())
            .map_err(|err| format!("zotero search sidecar failed: {err}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("zotero search failed: {stderr}"));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        serde_json::from_str::<Vec<ZoteroSearchResult>>(&stdout)
            .map_err(|err| format!("invalid zotero search output: {err}"))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn import_zotero_literature(
    app_handle: AppHandle,
    item_key: String,
    library_id: Option<String>,
) -> Result<LiteratureItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let payload = serde_json::json!({
            "itemKey": item_key,
            "libraryId": library_id.unwrap_or_default(),
        });

        let output = sidecar::run_sidecar(&state, "import-zotero-literature", &payload.to_string())
            .map_err(|err| format!("zotero import sidecar failed: {err}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("zotero import failed: {stderr}"));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let imported: ZoteroImportPayload = serde_json::from_str(&stdout)
            .map_err(|err| format!("invalid zotero import output: {err}"))?;

        if imported.item_key.trim().is_empty() || imported.title.trim().is_empty() {
            return Err("zotero import returned incomplete metadata".into());
        }

        let notes_text = imported
            .notes
            .iter()
            .map(|note| note.trim())
            .filter(|note| !note.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");

        let candidate = LiteratureCandidate {
            id: uuid::Uuid::new_v4().to_string(),
            title: imported.title.clone(),
            authors: imported.authors.clone(),
            year: imported.year,
            doi: imported.doi.clone(),
            abstract_text: imported.abstract_text.clone(),
            source_context: format!("Zotero MCP: {}", imported.item_key),
            pdf_path: String::new(),
            dedup_status: String::new(),
            matched_item_id: String::new(),
            created_at: String::new(),
        };

        let conn = state.db.lock().map_err(|err| err.to_string())?;
        literature::add_to_inbox(&conn, &candidate)?;
        let item = literature::approve_candidate(&conn, &candidate.id)?;

        literature::merge_source_metadata(
            &conn,
            &item.id,
            &imported.journal,
            &imported.tags,
            &notes_text,
        )?;
        literature::upsert_sync_state(
            &conn,
            &item.id,
            if imported.library_id.trim().is_empty() {
                "local"
            } else {
                imported.library_id.trim()
            },
            &imported.item_key,
            imported.zotero_version,
            "pull",
        )?;

        if !imported.fulltext.trim().is_empty() {
            let attachment_path = format!("zotero://{}/fulltext", imported.item_key);
            literature::upsert_attachment(
                &conn,
                &item.id,
                "fulltext",
                &attachment_path,
                "zotero",
                "none",
            )?;
            let chunks = chunk_fulltext(&imported.fulltext, 1800);
            literature::save_chunks(&conn, &item.id, &chunks)?;
        }

        literature::list_items(&conn)?
            .into_iter()
            .find(|entry| entry.id == item.id)
            .ok_or_else(|| "imported item not found after save".to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn link_literature_to_task(
    state: State<'_, AppState>,
    literature_id: String,
    task_id: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    literature::link_to_task(&conn, &literature_id, &task_id)
}

#[tauri::command]
pub async fn import_literature_pdf(
    app_handle: AppHandle,
    literature_id: String,
    source_path: String,
) -> Result<crate::models::LiteratureAttachment, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let root_path = state
            .project_config
            .read()
            .map_err(|err| err.to_string())?
            .root_path
            .clone();
        if root_path.trim().is_empty() {
            return Err("no active project".into());
        }
        let conn = state.db.lock().map_err(|err| err.to_string())?;
        literature::import_pdf(
            &conn,
            &literature_id,
            Path::new(&source_path),
            Path::new(&root_path),
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn ingest_literature(
    app_handle: AppHandle,
    literature_id: String,
    pdf_path: String,
    title: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let root_path = state
            .project_config
            .read()
            .map_err(|err| err.to_string())?
            .root_path
            .clone();
        if root_path.trim().is_empty() {
            return Err("no active project".into());
        }

        let payload = serde_json::json!({
            "literatureId": literature_id,
            "pdfPath": pdf_path,
            "projectRoot": root_path,
            "title": title,
        });

        let output = crate::services::sidecar::run_sidecar(
            &state,
            "ingest-literature",
            &payload.to_string(),
        )
        .map_err(|err| format!("ingestion sidecar failed: {err}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ingestion failed: {stderr}"));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let result: serde_json::Value = serde_json::from_str(&stdout)
            .map_err(|err| format!("invalid ingestion output: {err}"))?;

        let conn = state.db.lock().map_err(|err| err.to_string())?;
        if let Some(chunks) = result.get("chunks").and_then(|v| v.as_array()) {
            let chunk_tuples: Vec<(i32, String)> = chunks
                .iter()
                .filter_map(|c| {
                    let idx = c.get("chunkIndex")?.as_i64()? as i32;
                    let content = c.get("content")?.as_str()?.to_string();
                    Some((idx, content))
                })
                .collect();

            literature::save_chunks(&conn, &literature_id, &chunk_tuples)?;
        }

        let ocr_status = result
            .get("ocrStatus")
            .and_then(|v| v.as_str())
            .unwrap_or("none");
        let attachments = literature::list_attachments(&conn, &literature_id)?;
        if let Some(pdf_attachment) = attachments
            .iter()
            .find(|attachment| attachment.kind == "pdf")
        {
            literature::update_attachment_ocr_status(&conn, &pdf_attachment.id, ocr_status)?;
        }

        if let Some(markdown_path) = result.get("markdownPath").and_then(|v| v.as_str()) {
            let attachment_source = if ocr_status == "done" {
                "ocr"
            } else {
                "manual"
            };
            literature::upsert_attachment(
                &conn,
                &literature_id,
                "markdown",
                markdown_path,
                attachment_source,
                ocr_status,
            )?;
        }

        Ok(result)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn export_paper_bank(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    literature::export_paper_bank(&conn)
}

#[tauri::command]
pub fn count_literature_for_task(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    literature::count_for_task(&conn, &task_id)
}

// ── Compute Node Commands ──

#[tauri::command]
pub fn load_compute_nodes() -> Result<crate::services::compute_node::ComputeNodeStore, String> {
    crate::services::compute_node::load_compute_nodes()
}

#[tauri::command]
pub fn save_compute_node(
    node: crate::services::compute_node::ComputeNodeConfig,
) -> Result<(), String> {
    crate::services::compute_node::save_compute_node(node)
}

#[tauri::command]
pub fn delete_compute_node(node_id: String) -> Result<(), String> {
    crate::services::compute_node::delete_compute_node(&node_id)
}

#[tauri::command]
pub fn set_active_compute_node(node_id: String) -> Result<(), String> {
    crate::services::compute_node::set_active_compute_node(&node_id)
}

#[tauri::command]
pub fn test_compute_node(node_id: String) -> Result<serde_json::Value, String> {
    crate::services::compute_node::test_compute_node(&node_id)
}

// ── WeChat Bridge Commands ──

use crate::services::wechat_bridge;

#[tauri::command]
pub fn load_wechat_config() -> Result<wechat_bridge::WeChatConfig, String> {
    wechat_bridge::load_wechat_config()
}

#[tauri::command]
pub fn save_wechat_config_cmd(config: wechat_bridge::WeChatConfig) -> Result<(), String> {
    wechat_bridge::save_wechat_config(&config)
}

#[tauri::command]
pub fn get_wechat_status(
    state: State<'_, wechat_bridge::WeChatBridgeState>,
) -> Result<wechat_bridge::WeChatStatus, String> {
    let status = state.status.lock().map_err(|e| e.to_string())?;
    Ok(status.clone())
}

#[tauri::command]
pub async fn start_wechat_binding(
    api_url: Option<String>,
) -> Result<wechat_bridge::QrCodeInfo, String> {
    let config = wechat_bridge::load_wechat_config()?;
    let url = api_url.unwrap_or(config.api_url);
    tauri::async_runtime::spawn_blocking(move || wechat_bridge::request_qr_code(&url))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn poll_wechat_binding_status(
    scan_ticket: String,
    api_url: Option<String>,
) -> Result<Option<String>, String> {
    let config = wechat_bridge::load_wechat_config()?;
    let url = api_url.unwrap_or(config.api_url);
    tauri::async_runtime::spawn_blocking(move || {
        wechat_bridge::poll_scan_status(&url, &scan_ticket)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn start_wechat_listener(
    app_handle: AppHandle,
    bridge_state: State<'_, wechat_bridge::WeChatBridgeState>,
) -> Result<(), String> {
    let config = wechat_bridge::load_wechat_config()?;
    if config.token.trim().is_empty() {
        return Err("WeChat token is not configured. Please bind via QR scan first.".into());
    }

    if bridge_state.running.load(Ordering::SeqCst) {
        return Ok(()); // Already running
    }

    bridge_state.running.store(true, Ordering::SeqCst);
    {
        let mut status = bridge_state.status.lock().map_err(|e| e.to_string())?;
        status.state = "connected".into();
        status.message = "Listening for WeChat messages...".into();
    }

    let running = bridge_state.running.clone();
    let status_ref = bridge_state.status.clone();
    let ctx_token_ref = bridge_state.context_token.clone();
    let offset_ref = bridge_state.update_offset.clone();
    let app = app_handle.clone();

    // Spawn the long-poll listener on a background thread.
    tauri::async_runtime::spawn_blocking(move || {
        while running.load(Ordering::SeqCst) {
            let offset = {
                let guard = offset_ref.lock().unwrap_or_else(|e| e.into_inner());
                *guard
            };

            match wechat_bridge::get_updates(
                &config.api_url,
                &config.token,
                offset,
                config.poll_timeout_ms,
            ) {
                Ok((messages, new_offset)) => {
                    {
                        let mut guard = offset_ref.lock().unwrap_or_else(|e| e.into_inner());
                        *guard = new_offset;
                    }

                    for msg in messages {
                        // Check allow_from whitelist
                        if !wechat_bridge::is_user_allowed(&config.allow_from, &msg.from_user) {
                            continue;
                        }

                        // Cache context_token for replies
                        if let Some(ref ctx) = msg.context_token {
                            let mut guard = ctx_token_ref.lock().unwrap_or_else(|e| e.into_inner());
                            *guard = Some(ctx.clone());
                        }

                        // Emit the incoming message to the frontend
                        let _ = app.emit("wechat:message", &msg);
                    }
                }
                Err(err) => {
                    let _ = app.emit("wechat:error", serde_json::json!({ "message": err }));
                    // Brief pause before retry on error
                    std::thread::sleep(Duration::from_secs(5));
                }
            }
        }

        // Update status when stopped
        if let Ok(mut status) = status_ref.lock() {
            status.state = "disconnected".into();
            status.message = "Listener stopped".into();
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_wechat_listener(
    bridge_state: State<'_, wechat_bridge::WeChatBridgeState>,
) -> Result<(), String> {
    bridge_state.running.store(false, Ordering::SeqCst);
    {
        let mut status = bridge_state.status.lock().map_err(|e| e.to_string())?;
        status.state = "disconnected".into();
        status.message = "Listener stopped".into();
    }
    Ok(())
}

#[tauri::command]
pub async fn send_wechat_reply(
    bridge_state: State<'_, wechat_bridge::WeChatBridgeState>,
    text: String,
) -> Result<(), String> {
    let config = wechat_bridge::load_wechat_config()?;
    if config.token.trim().is_empty() {
        return Err("WeChat token is not configured".into());
    }
    let ctx_token = {
        let guard = bridge_state
            .context_token
            .lock()
            .map_err(|e| e.to_string())?;
        guard.clone()
    };
    let api_url = config.api_url.clone();
    let token = config.token.clone();
    tauri::async_runtime::spawn_blocking(move || {
        wechat_bridge::send_message(&api_url, &token, &text, ctx_token.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}
