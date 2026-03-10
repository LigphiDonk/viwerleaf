use std::fs;
use std::path::Path;
use std::time::Instant;

use tauri::{AppHandle, State};

use crate::models::{
    AgentMessage, AgentRunResult, FigureBriefDraft, GeneratedAsset, ProfileConfig, ProviderConfig,
    SkillManifest, TestResult, UsageRecord, WorkspaceSnapshot,
};
use crate::services::{agent, compile, figure, profile, project, provider, skill, sync};
use crate::state::AppState;

#[tauri::command]
pub fn open_project(state: State<'_, AppState>) -> Result<WorkspaceSnapshot, String> {
    project::load_project_snapshot(&state).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn save_file(
    state: State<'_, AppState>,
    file_path: String,
    content: String,
) -> Result<bool, String> {
    project::save_file(&state, &file_path, &content)
        .map(|_| true)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn compile_project(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<crate::models::CompileResult, String> {
    compile::compile_project(&state, &file_path).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn forward_search(
    state: State<'_, AppState>,
    file_path: String,
    line: usize,
) -> Result<crate::models::SyncLocation, String> {
    sync::forward_search(&state, &file_path, line).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn reverse_search(
    state: State<'_, AppState>,
    page: usize,
) -> Result<crate::models::SyncLocation, String> {
    sync::reverse_search(&state, page).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn run_agent(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    file_path: String,
    selected_text: String,
) -> Result<AgentRunResult, String> {
    agent::run_agent(&app_handle, &state, &profile_id, &file_path, &selected_text)
        .map_err(|err| err.to_string())
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
pub fn list_skills(state: State<'_, AppState>) -> Result<Vec<SkillManifest>, String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    skill::list_skills(&conn)
}

#[tauri::command]
pub fn install_skill(state: State<'_, AppState>, skill: SkillManifest) -> Result<SkillManifest, String> {
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
            if let Some(default_model) = patch.get("defaultModel").and_then(|value| value.as_str()) {
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
pub fn test_provider(state: State<'_, AppState>, id: String) -> Result<TestResult, String> {
    let conn = state.db.lock().map_err(|err| err.to_string())?;
    let prov = provider::get_provider(&conn, &id)?;
    drop(conn);

    let start = Instant::now();
    let output = std::process::Command::new("node")
        .arg(state.app_root.join("sidecar/index.mjs"))
        .args([
            "test-provider",
            &serde_json::json!({
                "vendor": prov.vendor,
                "baseUrl": prov.base_url,
                "apiKey": prov.api_key,
                "model": prov.default_model,
            })
            .to_string(),
        ])
        .current_dir(&state.app_root)
        .output()
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
    let section_ref = section_ref.or(file_path).unwrap_or_else(|| "active-section".into());
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
        .map(|(file_path, content)| serde_json::json!({ "filePath": file_path, "content": content }))
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
pub fn create_file(state: State<'_, AppState>, path: String, content: String) -> Result<(), String> {
    let config = state.project_config.read().map_err(|err| err.to_string())?;
    let full_path = Path::new(&config.root_path).join(&path);
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(&full_path, &content).map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_file(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let config = state.project_config.read().map_err(|err| err.to_string())?;
    let full_path = Path::new(&config.root_path).join(&path);
    fs::remove_file(&full_path).map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn rename_file(
    state: State<'_, AppState>,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let config = state.project_config.read().map_err(|err| err.to_string())?;
    let root = Path::new(&config.root_path);
    fs::rename(root.join(&old_path), root.join(&new_path)).map_err(|err| err.to_string())?;
    Ok(())
}
