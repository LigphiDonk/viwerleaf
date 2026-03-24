mod commands;
mod db;
mod desktop_menu;
mod models;
mod services;
mod state;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use walkdir::WalkDir;

use tauri::Manager;

use state::{default_compile_result, empty_project_config, load_project_config, AppState};

enum LaunchWorkspace {
    Empty,
    Root(PathBuf),
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .menu(|app| desktop_menu::build_app_menu(app))
        .on_menu_event(|app, event| desktop_menu::handle_menu_event(app, event))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            desktop_menu::install_dock_menu(app.handle()).expect("failed to install Dock menu");

            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            let conn = db::init_db(&app_data_dir).expect("failed to init database");

            let app_root = resolve_app_root(app.handle());
            let sidecar_dir = resolve_sidecar_dir(app.handle(), &app_root);
            let skills_dir = resolve_skills_dir(app.handle(), &app_root);
            let workspace_root = match resolve_launch_workspace() {
                LaunchWorkspace::Empty => None,
                LaunchWorkspace::Root(root) if root.exists() => Some(root),
                LaunchWorkspace::Root(_) => None,
            };
            let project_config = workspace_root
                .as_ref()
                .map(|root| load_project_config(root))
                .unwrap_or_else(empty_project_config);

            services::skill::refresh_skill_registry(&conn, &skills_dir, workspace_root.as_deref())
                .expect("failed to refresh skills");

            let last_compile = workspace_root
                .as_ref()
                .map(|root| default_compile_result(root, &project_config.main_tex))
                .unwrap_or_else(|| {
                    default_compile_result(std::path::Path::new(""), &project_config.main_tex)
                });

            app.manage(AppState {
                db: Mutex::new(conn),
                project_config: RwLock::new(project_config),
                last_compile: RwLock::new(last_compile),
                terminals: Mutex::new(HashMap::new()),
                app_root,
                sidecar_dir,
                skills_dir,
                app_data_dir,
                active_sidecar: Mutex::new(None),
                sidecar_cancelled: std::sync::atomic::AtomicBool::new(false),
            });
            app.manage(services::wechat_bridge::WeChatBridgeState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_project,
            commands::read_file,
            commands::read_asset,
            commands::switch_project,
            commands::create_project,
            commands::ensure_research_scaffold,
            commands::initialize_research_stage,
            commands::apply_research_task_suggestion,
            commands::regenerate_pipeline_tasks,
            commands::launch_workspace_window,
            commands::sync_app_menu,
            commands::save_file,
            commands::update_project_config,
            commands::compile_project,
            commands::get_compile_environment,
            commands::forward_search,
            commands::reverse_search,
            commands::run_agent,
            commands::run_auto_experiment,
            commands::stop_auto_experiment,
            commands::is_experiment_running,
            commands::pause_auto_experiment,
            commands::resume_auto_experiment,
            commands::apply_agent_patch,
            commands::get_agent_messages,
            commands::list_agent_sessions,
            commands::list_skills,
            commands::install_skill,
            commands::enable_skill,
            commands::list_providers,
            commands::add_provider,
            commands::update_provider,
            commands::delete_provider,
            commands::test_provider,
            commands::list_profiles,
            commands::update_profile,
            commands::create_figure_brief,
            commands::run_figure_skill,
            commands::run_banana_generation,
            commands::register_generated_asset,
            commands::insert_figure_snippet,
            commands::get_usage_stats,
            commands::create_file,
            commands::create_folder,
            commands::delete_file,
            commands::rename_file,
            commands::read_pdf_binary,
            commands::start_terminal,
            commands::terminal_write,
            commands::resize_terminal,
            commands::close_terminal,
            commands::prepare_worker_deploy_dir,
            commands::cancel_agent,
            commands::import_skill_from_git,
            commands::remove_skill,
            commands::detect_cli_agents,
            commands::detect_zotero_mcp,
            commands::create_workspace_dir,
            commands::read_file_binary,
            commands::save_file_binary,
            // Literature management
            commands::list_literature,
            commands::list_literature_inbox,
            commands::list_literature_attachments,
            commands::add_literature,
            commands::add_literature_with_pdf,
            commands::add_literature_candidate,
            commands::delete_literature,
            commands::approve_literature_candidate,
            commands::update_literature_notes,
            commands::search_literature,
            commands::search_zotero_literature,
            commands::link_literature_to_task,
            commands::import_literature_pdf,
            commands::import_zotero_literature,
            commands::ingest_literature,
            commands::export_paper_bank,
            commands::count_literature_for_task,
            // Compute nodes
            commands::load_compute_nodes,
            commands::save_compute_node,
            commands::delete_compute_node,
            commands::set_active_compute_node,
            commands::test_compute_node,
            // WeChat remote bridge
            commands::load_wechat_config,
            commands::save_wechat_config_cmd,
            commands::get_wechat_status,
            commands::start_wechat_binding,
            commands::poll_wechat_binding_status,
            commands::start_wechat_listener,
            commands::stop_wechat_listener,
            commands::send_wechat_reply,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start ViewerLeaf");
}

fn resolve_launch_workspace() -> LaunchWorkspace {
    let mut args = std::env::args().skip(1);

    while let Some(argument) = args.next() {
        if argument == "--empty-window" {
            return LaunchWorkspace::Empty;
        }

        if argument == "--workspace" {
            if let Some(path) = args.next() {
                return LaunchWorkspace::Root(PathBuf::from(path));
            }
            continue;
        }

        if let Some(path) = argument.strip_prefix("--workspace=") {
            return LaunchWorkspace::Root(PathBuf::from(path));
        }
    }

    LaunchWorkspace::Empty
}

fn resolve_sidecar_dir(app: &tauri::AppHandle, app_root: &std::path::Path) -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(explicit) = std::env::var("VIEWERLEAF_SIDECAR_DIR") {
        let explicit = PathBuf::from(explicit.trim());
        if !explicit.as_os_str().is_empty() {
            candidates.push(explicit);
        }
    }
    candidates.push(app_root.join("sidecar"));
    candidates.push(app_root.join("src-tauri/resources/sidecar"));
    candidates.push(app_root.join("resources/sidecar"));

    if let Ok(resource_dir) = app.path().resource_dir() {
        push_bundled_resource_candidates(&mut candidates, &resource_dir, "sidecar");
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            push_bundled_resource_candidates(&mut candidates, parent, "sidecar");
            push_bundled_resource_candidates(
                &mut candidates,
                &parent.join("../Resources"),
                "sidecar",
            );
            push_bundled_resource_candidates(
                &mut candidates,
                &parent.join("../../Resources"),
                "sidecar",
            );
        }
    }

    let manifest_sidecar = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("sidecar");
    candidates.push(manifest_sidecar.clone());
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("sidecar"),
    );

    for candidate in candidates {
        if has_sidecar_entry(&candidate) {
            return candidate;
        }
    }

    manifest_sidecar
}

pub(crate) fn resolve_app_root(app: &tauri::AppHandle) -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(explicit) = std::env::var("VIEWERLEAF_APP_ROOT") {
        let explicit = PathBuf::from(explicit.trim());
        if !explicit.as_os_str().is_empty() {
            candidates.push(explicit);
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.to_path_buf());
            candidates.push(parent.join(".."));
            candidates.push(parent.join("../.."));
            candidates.push(parent.join("../../.."));
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir);
    }

    let manifest_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .to_path_buf();
    candidates.push(manifest_root.clone());

    for candidate in candidates {
        if has_root_markers(&candidate) {
            return candidate;
        }
    }

    manifest_root
}

pub(crate) fn resolve_worker_template_dir(
    app: &tauri::AppHandle,
    app_root: &std::path::Path,
) -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(explicit) = std::env::var("VIEWERLEAF_WORKER_TEMPLATE_DIR") {
        let explicit = PathBuf::from(explicit.trim());
        if !explicit.as_os_str().is_empty() {
            candidates.push(explicit);
        }
    }

    candidates.push(app_root.join("src-tauri/resources/worker-template"));
    candidates.push(app_root.join("resources/worker-template"));
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("worker-template"),
    );

    if let Ok(resource_dir) = app.path().resource_dir() {
        push_bundled_resource_candidates(&mut candidates, &resource_dir, "worker-template");
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            push_bundled_resource_candidates(&mut candidates, parent, "worker-template");
            push_bundled_resource_candidates(
                &mut candidates,
                &parent.join("../Resources"),
                "worker-template",
            );
            push_bundled_resource_candidates(
                &mut candidates,
                &parent.join("../../Resources"),
                "worker-template",
            );
        }
    }

    for candidate in candidates {
        if candidate.join("wrangler.template.toml").is_file() {
            return candidate;
        }
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("worker-template")
}

fn has_root_markers(path: &Path) -> bool {
    has_sidecar_entry(&path.join("sidecar"))
        || path.join("skills").is_dir()
        || path.join("src-tauri").is_dir()
}

fn has_sidecar_entry(path: &Path) -> bool {
    path.join("dist").join("index.mjs").is_file()
}

fn has_skills_entry(path: &Path) -> bool {
    path.is_dir()
        && WalkDir::new(path)
            .min_depth(1)
            .max_depth(2)
            .into_iter()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name() == "SKILL.md")
}

pub(crate) fn resolve_skills_dir(app: &tauri::AppHandle, app_root: &std::path::Path) -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(explicit) = std::env::var("VIEWERLEAF_SKILLS_DIR") {
        let explicit = PathBuf::from(explicit.trim());
        if !explicit.as_os_str().is_empty() {
            candidates.push(explicit);
        }
    }

    candidates.push(app_root.join("skills"));
    candidates.push(app_root.join("src-tauri/resources/skills"));
    candidates.push(app_root.join("resources/skills"));

    if let Ok(resource_dir) = app.path().resource_dir() {
        push_bundled_resource_candidates(&mut candidates, &resource_dir, "skills");
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            push_bundled_resource_candidates(&mut candidates, parent, "skills");
            push_bundled_resource_candidates(
                &mut candidates,
                &parent.join("../Resources"),
                "skills",
            );
            push_bundled_resource_candidates(
                &mut candidates,
                &parent.join("../../Resources"),
                "skills",
            );
        }
    }

    let manifest_skills = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("skills");
    candidates.push(manifest_skills.clone());
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("skills"),
    );

    for candidate in candidates {
        if has_skills_entry(&candidate) {
            return candidate;
        }
    }

    manifest_skills
}

fn push_bundled_resource_candidates(candidates: &mut Vec<PathBuf>, base: &Path, resource: &str) {
    candidates.push(base.join(resource));
    candidates.push(base.join("resources").join(resource));
    candidates.push(base.join("_up_").join(resource));
}

#[cfg(test)]
mod tests {
    use super::{has_root_markers, has_sidecar_entry};
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("viewerleaf-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).expect("failed to create temp dir");
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn recognizes_sidecar_dist_entry() {
        let temp = TempDir::new();
        let sidecar_dir = temp.path.join("sidecar");
        fs::create_dir_all(sidecar_dir.join("dist")).expect("failed to create sidecar dist dir");
        fs::write(sidecar_dir.join("dist/index.mjs"), "export {};\n")
            .expect("failed to write sidecar entry");

        assert!(has_sidecar_entry(&sidecar_dir));
    }

    #[test]
    fn root_markers_accept_built_sidecar_layout() {
        let temp = TempDir::new();
        let sidecar_dir = temp.path.join("sidecar");
        fs::create_dir_all(sidecar_dir.join("dist")).expect("failed to create sidecar dist dir");
        fs::write(sidecar_dir.join("dist/index.mjs"), "export {};\n")
            .expect("failed to write sidecar entry");

        assert!(has_root_markers(&temp.path));
    }
}
