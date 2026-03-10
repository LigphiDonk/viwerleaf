use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use rusqlite::Connection;

use crate::models::{CompileResult, ProjectConfig};

pub struct AppState {
    pub db: Mutex<Connection>,
    pub project_config: RwLock<ProjectConfig>,
    pub last_compile: RwLock<CompileResult>,
    pub app_root: PathBuf,
    pub app_data_dir: PathBuf,
}

pub fn default_compile_result(project_root: &Path, main_tex: &str) -> CompileResult {
    if project_root.as_os_str().is_empty() {
        return CompileResult {
            status: "idle".into(),
            pdf_path: None,
            synctex_path: None,
            diagnostics: Vec::new(),
            log_path: String::new(),
            log_output: "No project opened.".into(),
            timestamp: iso_now(),
        };
    }

    CompileResult {
        status: "idle".into(),
        pdf_path: Some(
            project_root
                .join(main_tex.replace(".tex", ".pdf"))
                .to_string_lossy()
                .to_string(),
        ),
        synctex_path: Some(
            project_root
                .join(main_tex.replace(".tex", ".synctex.gz"))
                .to_string_lossy()
                .to_string(),
        ),
        diagnostics: Vec::new(),
        log_path: project_root
            .join(".viewerleaf/logs/latest.log")
            .to_string_lossy()
            .to_string(),
        log_output: "Compile service is idle.".into(),
        timestamp: iso_now(),
    }
}

pub fn empty_project_config() -> ProjectConfig {
    ProjectConfig {
        root_path: String::new(),
        main_tex: "main.tex".into(),
        engine: "xelatex".into(),
        bib_tool: "biber".into(),
        auto_compile: false,
        forward_sync: true,
    }
}

pub fn save_project_config(root: &Path, config: &ProjectConfig) -> std::io::Result<()> {
    if root.as_os_str().is_empty() {
        return Ok(());
    }

    let config_path = root.join(".viewerleaf").join("project.json");
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)?;
    }

    fs::write(config_path, serde_json::to_string_pretty(config)?)
}

pub fn resolve_initial_workspace(app_data_dir: &Path) -> Option<PathBuf> {
    load_recent_workspace(app_data_dir).filter(|path| path.exists())
}

pub fn load_recent_workspace(app_data_dir: &Path) -> Option<PathBuf> {
    let state_path = app_data_dir.join("workspace-state.json");
    let raw = fs::read_to_string(state_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("rootPath")
        .and_then(|item| item.as_str())
        .map(PathBuf::from)
}

pub fn persist_recent_workspace(app_data_dir: &Path, root: &Path) -> std::io::Result<()> {
    fs::create_dir_all(app_data_dir)?;
    fs::write(
        app_data_dir.join("workspace-state.json"),
        serde_json::to_string_pretty(&serde_json::json!({ "rootPath": root }))?,
    )
}

pub fn load_project_config(root: &Path) -> ProjectConfig {
    if root.as_os_str().is_empty() {
        return empty_project_config();
    }

    let config_path = root.join(".viewerleaf").join("project.json");
    if let Ok(raw) = fs::read_to_string(&config_path) {
        if let Ok(config) = serde_json::from_str::<ProjectConfig>(&raw) {
            return config;
        }
    }

    ProjectConfig {
        root_path: root.to_string_lossy().to_string(),
        main_tex: infer_main_tex(root),
        engine: "xelatex".into(),
        bib_tool: "biber".into(),
        auto_compile: false,
        forward_sync: true,
    }
}

fn infer_main_tex(root: &Path) -> String {
    if root.join("main.tex").exists() {
        return "main.tex".into();
    }

    let Ok(entries) = fs::read_dir(root) else {
        return "main.tex".into();
    };

    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("tex") {
                path.file_name().map(|name| name.to_string_lossy().to_string())
            } else {
                None
            }
        })
        .next()
        .unwrap_or_else(|| "main.tex".into())
}

pub fn initialize_project(root: &Path, project_name: &str) -> std::io::Result<()> {
    fs::create_dir_all(root.join("sections"))?;
    fs::create_dir_all(root.join("refs"))?;
    fs::create_dir_all(root.join(".viewerleaf"))?;

    let title = if project_name.trim().is_empty() {
        root.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "ViewerLeaf Project".into())
    } else {
        project_name.trim().to_string()
    };

    write_if_missing(
        &root.join("main.tex"),
        &format!(
            "\\documentclass[11pt]{{article}}\n\\usepackage{{graphicx}}\n\\usepackage{{booktabs}}\n\\usepackage{{hyperref}}\n\\usepackage{{biblatex}}\n\\addbibresource{{refs/references.bib}}\n\\title{{{title}}}\n\\author{{}}\n\\begin{{document}}\n\\maketitle\n\\input{{sections/abstract}}\n\\input{{sections/introduction}}\n\\printbibliography\n\\end{{document}}\n"
        ),
    )?;

    write_if_missing(
        &root.join("sections/abstract.tex"),
        "\\begin{abstract}\nWrite your abstract here.\n\\end{abstract}\n",
    )?;

    write_if_missing(
        &root.join("sections/introduction.tex"),
        "\\section{Introduction}\nStart drafting here.\n",
    )?;

    write_if_missing(
        &root.join("refs/references.bib"),
        "@article{example2026,\n  title={Example Reference},\n  author={Author, Example},\n  year={2026}\n}\n",
    )?;

    save_project_config(
        root,
        &ProjectConfig {
            root_path: root.to_string_lossy().to_string(),
            main_tex: "main.tex".into(),
            engine: "xelatex".into(),
            bib_tool: "biber".into(),
            auto_compile: false,
            forward_sync: true,
        },
    )?;

    Ok(())
}

fn write_if_missing(path: &Path, contents: &str) -> std::io::Result<()> {
    if path.exists() {
        return Ok(());
    }
    fs::write(path, contents)
}

fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|dur| dur.as_secs())
        .unwrap_or_default();
    secs.to_string()
}
