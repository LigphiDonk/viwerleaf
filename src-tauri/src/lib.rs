mod commands;
mod db;
mod models;
mod services;
mod state;

use std::sync::{Mutex, RwLock};

use tauri::Manager;

use state::{default_compile_result, ensure_workspace_root, load_project_config, AppState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            let conn = db::init_db(&app_data_dir).expect("failed to init database");

            let app_root = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            let workspace_root = ensure_workspace_root();
            let project_config = load_project_config(&workspace_root);

            services::skill::discover_skills(
                &conn,
                &[app_root.join("skills")],
                "builtin",
            )
            .expect("failed to discover builtin skills");
            services::skill::discover_skills(
                &conn,
                &[workspace_root.join("skills")],
                "project",
            )
            .expect("failed to discover project skills");

            let last_compile = default_compile_result(&workspace_root, &project_config.main_tex);

            app.manage(AppState {
                db: Mutex::new(conn),
                project_config: RwLock::new(project_config),
                last_compile: RwLock::new(last_compile),
                app_root,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_project,
            commands::save_file,
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
