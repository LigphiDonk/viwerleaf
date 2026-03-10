mod commands;
mod db;
mod models;
mod services;
mod state;

use std::sync::{Mutex, RwLock};

use tauri::Manager;

use state::{
    default_compile_result, empty_project_config, load_project_config, resolve_initial_workspace,
    AppState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            let conn = db::init_db(&app_data_dir).expect("failed to init database");

            let app_root = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            let workspace_root = resolve_initial_workspace(&app_data_dir);
            let project_config = workspace_root
                .as_ref()
                .map(|root| load_project_config(root))
                .unwrap_or_else(empty_project_config);

            services::skill::discover_skills(
                &conn,
                &[app_root.join("skills")],
                "builtin",
            )
            .expect("failed to discover builtin skills");
            if let Some(workspace_root) = workspace_root.as_ref() {
                services::skill::discover_skills(
                    &conn,
                    &[workspace_root.join("skills")],
                    "project",
                )
                .expect("failed to discover project skills");
            }

            let last_compile = workspace_root
                .as_ref()
                .map(|root| default_compile_result(root, &project_config.main_tex))
                .unwrap_or_else(|| default_compile_result(std::path::Path::new(""), &project_config.main_tex));

            app.manage(AppState {
                db: Mutex::new(conn),
                project_config: RwLock::new(project_config),
                last_compile: RwLock::new(last_compile),
                app_root,
                app_data_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_project,
            commands::read_file,
            commands::read_asset,
            commands::switch_project,
            commands::create_project,
            commands::save_file,
            commands::update_project_config,
            commands::compile_project,
            commands::forward_search,
            commands::reverse_search,
            commands::run_agent,
            commands::apply_agent_patch,
            commands::get_agent_messages,
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
            commands::delete_file,
            commands::rename_file
        ])
        .run(tauri::generate_context!())
        .expect("failed to start ViewerLeaf");
}
