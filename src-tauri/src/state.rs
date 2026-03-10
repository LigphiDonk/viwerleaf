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
}

pub fn default_compile_result(project_root: &Path, main_tex: &str) -> CompileResult {
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

pub fn ensure_workspace_root() -> PathBuf {
    if let Ok(current_dir) = std::env::current_dir() {
        if looks_like_dev_workspace(&current_dir) {
            return current_dir;
        }
    }

    let base_dir = dirs::document_dir()
        .or_else(dirs::home_dir)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let root = base_dir.join("ViewerLeaf Demo");

    if let Err(err) = seed_demo_workspace(&root) {
        eprintln!("failed to prepare demo workspace at {}: {err}", root.display());
    }

    root
}

pub fn load_project_config(root: &Path) -> ProjectConfig {
    let config_path = root.join(".viewerleaf").join("project.json");
    if let Ok(raw) = fs::read_to_string(&config_path) {
        if let Ok(config) = serde_json::from_str::<ProjectConfig>(&raw) {
            return config;
        }
    }

    ProjectConfig {
        root_path: root.to_string_lossy().to_string(),
        main_tex: "main.tex".into(),
        engine: "xelatex".into(),
        bib_tool: "biber".into(),
        auto_compile: true,
        forward_sync: true,
    }
}

fn looks_like_dev_workspace(path: &Path) -> bool {
    path.join("package.json").exists() && path.join("src-tauri").exists()
}

fn seed_demo_workspace(root: &Path) -> std::io::Result<()> {
    fs::create_dir_all(root.join("sections"))?;
    fs::create_dir_all(root.join("refs"))?;
    fs::create_dir_all(root.join(".viewerleaf"))?;

    write_if_missing(
        &root.join("main.tex"),
        r"\documentclass[11pt]{article}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{hyperref}
\usepackage{biblatex}
\addbibresource{refs/references.bib}
\title{ViewerLeaf Demo Paper}
\author{ViewerLeaf}
\begin{document}
\maketitle
\input{sections/abstract}
\input{sections/introduction}
\printbibliography
\end{document}
",
    )?;

    write_if_missing(
        &root.join("sections/abstract.tex"),
        r"\begin{abstract}
ViewerLeaf ships with a writable demo workspace so the installed app opens into a valid project instead of an empty shell.
\end{abstract}
",
    )?;

    write_if_missing(
        &root.join("sections/introduction.tex"),
        r"\section{Introduction}
This sample project is created automatically for packaged builds.

\subsection{Why it exists}
Desktop apps launched from Finder do not start inside your repository, so ViewerLeaf needs its own default workspace.
",
    )?;

    write_if_missing(
        &root.join("refs/references.bib"),
        r"@article{viewerleaf2026,
  title={ViewerLeaf Demo Workspace},
  author={ViewerLeaf},
  year={2026}
}
",
    )?;

    let config = serde_json::json!({
        "rootPath": root.to_string_lossy(),
        "mainTex": "main.tex",
        "engine": "xelatex",
        "bibTool": "biber",
        "autoCompile": true,
        "forwardSync": true
    });
    write_if_missing(
        &root.join(".viewerleaf/project.json"),
        &serde_json::to_string_pretty(&config).unwrap_or_else(|_| "{}".into()),
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
