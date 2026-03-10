use anyhow::{Context, Result};
use std::fs;
use std::path::Path;

use walkdir::WalkDir;

use crate::models::{
    AssetResource, FigureBriefDraft, GeneratedAsset, ProjectConfig, ProjectFile, ProjectNode,
    WorkspaceSnapshot,
};
use crate::services::{figure, profile, provider, skill};
use crate::state::{
    default_compile_result, initialize_project, load_project_config, persist_recent_workspace,
    save_project_config, AppState,
};

fn detect_language(path: &str) -> String {
    match detect_file_type(path).as_str() {
        "latex" => "latex".into(),
        "bib" => "bib".into(),
        "json" => "json".into(),
        _ => "text".into(),
    }
}

fn detect_file_type(path: &str) -> String {
    let extension = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match extension.as_str() {
        "tex" | "sty" | "cls" => "latex".into(),
        "bib" => "bib".into(),
        "json" => "json".into(),
        "md" => "markdown".into(),
        "txt" | "log" => "text".into(),
        "yaml" | "yml" => "yaml".into(),
        "xml" => "xml".into(),
        "csv" => "csv".into(),
        "pdf" => "pdf".into(),
        "png" | "jpg" | "jpeg" | "svg" | "gif" | "webp" => "image".into(),
        _ => "unsupported".into(),
    }
}

fn is_text_file_type(file_type: &str) -> bool {
    matches!(
        file_type,
        "latex" | "bib" | "json" | "markdown" | "text" | "yaml" | "xml" | "csv"
    )
}

fn is_previewable_file_type(file_type: &str) -> bool {
    matches!(file_type, "pdf" | "image")
}

fn allowed_file_type(file_type: &str) -> bool {
    is_text_file_type(file_type) || is_previewable_file_type(file_type)
}

fn mime_type_for_path(path: &str) -> String {
    match Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "pdf" => "application/pdf".into(),
        "png" => "image/png".into(),
        "jpg" | "jpeg" => "image/jpeg".into(),
        "svg" => "image/svg+xml".into(),
        "gif" => "image/gif".into(),
        "webp" => "image/webp".into(),
        "json" => "application/json".into(),
        "md" => "text/markdown".into(),
        "yaml" | "yml" => "application/yaml".into(),
        "xml" => "application/xml".into(),
        "csv" => "text/csv".into(),
        "bib" => "text/x-bibtex".into(),
        "tex" | "sty" | "cls" => "text/x-tex".into(),
        _ => "application/octet-stream".into(),
    }
}

fn should_ignore_path(rel: &str) -> bool {
    rel.is_empty()
        || rel == "."
        || rel.starts_with(".git/")
        || rel.starts_with("node_modules/")
        || rel.starts_with("dist/")
        || rel.starts_with("src-tauri/target/")
        || rel.starts_with(".viewerleaf/")
}

fn build_tree(nodes: &[ProjectNode]) -> Vec<ProjectNode> {
    let mut roots = Vec::new();
    for node in nodes {
        let parts = node.path.split('/').collect::<Vec<_>>();
        insert_node(&mut roots, &parts, &node.path, node);
    }
    sort_nodes(&mut roots);
    roots
}

fn insert_node(nodes: &mut Vec<ProjectNode>, parts: &[&str], full_path: &str, source: &ProjectNode) {
    if parts.is_empty() {
        return;
    }

    let head = parts[0];
    let joined = full_path
        .split('/')
        .take(full_path.split('/').count() - parts.len() + 1)
        .collect::<Vec<_>>()
        .join("/");

    let idx = nodes.iter().position(|node| node.name == head);
    let entry = if let Some(idx) = idx {
        &mut nodes[idx]
    } else {
        nodes.push(ProjectNode {
            id: joined.clone(),
            name: head.into(),
            path: joined.clone(),
            kind: if parts.len() == 1 { source.kind.clone() } else { "directory".into() },
            file_type: if parts.len() == 1 {
                source.file_type.clone()
            } else {
                None
            },
            is_text: if parts.len() == 1 { source.is_text } else { None },
            is_previewable: if parts.len() == 1 {
                source.is_previewable
            } else {
                None
            },
            size: if parts.len() == 1 { source.size } else { None },
            children: if parts.len() == 1 { None } else { Some(Vec::new()) },
        });
        nodes.last_mut().expect("node inserted")
    };

    if parts.len() > 1 {
        if entry.children.is_none() {
            entry.children = Some(Vec::new());
        }
        insert_node(
            entry.children.as_mut().expect("children present"),
            &parts[1..],
            full_path,
            source,
        );
    }
}

fn sort_nodes(nodes: &mut [ProjectNode]) {
    nodes.sort_by(|left, right| match (left.kind.as_str(), right.kind.as_str()) {
        ("directory", "directory") | ("file", "file") | ("asset", "asset") => left.name.cmp(&right.name),
        ("directory", _) => std::cmp::Ordering::Less,
        (_, "directory") => std::cmp::Ordering::Greater,
        ("file", "asset") => std::cmp::Ordering::Less,
        ("asset", "file") => std::cmp::Ordering::Greater,
        _ => left.name.cmp(&right.name),
    });

    for node in nodes.iter_mut() {
        if let Some(children) = node.children.as_mut() {
            sort_nodes(children);
        }
    }
}

fn load_assets_and_briefs(state: &AppState) -> Result<(Vec<FigureBriefDraft>, Vec<GeneratedAsset>)> {
    let conn = state.db.lock().expect("db lock poisoned");
    let briefs = figure::list_briefs(&conn).map_err(anyhow::Error::msg)?;
    let assets = figure::list_assets(&conn).map_err(anyhow::Error::msg)?;
    Ok((briefs, assets))
}

fn collect_file_nodes(root: &Path) -> Vec<ProjectNode> {
    let mut nodes = Vec::new();

    for entry in WalkDir::new(root).into_iter().filter_map(|entry| entry.ok()) {
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");

        if should_ignore_path(&rel) {
            continue;
        }

        if path.is_dir() {
            nodes.push(ProjectNode {
                id: rel.clone(),
                name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| rel.clone()),
                path: rel,
                kind: "directory".into(),
                file_type: None,
                is_text: None,
                is_previewable: None,
                size: None,
                children: Some(Vec::new()),
            });
            continue;
        }

        if !path.is_file() {
            continue;
        }

        let file_type = detect_file_type(&rel);
        if !allowed_file_type(&file_type) {
            continue;
        }

        let metadata = fs::metadata(path).ok();
        let is_text = is_text_file_type(&file_type);
        nodes.push(ProjectNode {
            id: rel.clone(),
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| rel.clone()),
            path: rel,
            kind: if is_text { "file".into() } else { "asset".into() },
            file_type: Some(file_type.clone()),
            is_text: Some(is_text),
            is_previewable: Some(is_previewable_file_type(&file_type)),
            size: metadata.map(|meta| meta.len()),
            children: None,
        });
    }

    nodes.sort_by(|left, right| left.path.cmp(&right.path));
    nodes
}

fn choose_active_text_file(nodes: &[ProjectNode], main_tex: &str) -> String {
    nodes.iter()
        .find(|node| node.is_text == Some(true) && node.path.ends_with("introduction.tex"))
        .or_else(|| nodes.iter().find(|node| node.is_text == Some(true) && node.path == main_tex))
        .or_else(|| nodes.iter().find(|node| node.is_text == Some(true)))
        .map(|node| node.path.clone())
        .unwrap_or_default()
}

pub fn load_project_snapshot(state: &AppState) -> Result<WorkspaceSnapshot> {
    let root_path = {
        let current = state.project_config.read().expect("project config lock poisoned");
        current.root_path.clone()
    };
    if root_path.trim().is_empty() {
        return empty_snapshot(state);
    }
    let root = Path::new(&root_path);

    let config = load_project_config(root);
    {
        let mut current = state.project_config.write().expect("project config lock poisoned");
        *current = config.clone();
    }

    let mut file_nodes = collect_file_nodes(root);

    let (briefs, assets) = load_assets_and_briefs(state)?;
    for asset in &assets {
        let file_type = detect_file_type(&asset.file_path);
        file_nodes.push(ProjectNode {
            id: asset.file_path.clone(),
            name: Path::new(&asset.file_path)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| asset.file_path.clone()),
            path: asset.file_path.clone(),
            kind: "asset".into(),
            file_type: Some(file_type.clone()),
            is_text: Some(false),
            is_previewable: Some(is_previewable_file_type(&file_type)),
            size: None,
            children: None,
        });
    }
    file_nodes.sort_by(|left, right| left.path.cmp(&right.path));

    let conn = state.db.lock().expect("db lock poisoned");
    let providers = provider::list_providers(&conn).map_err(anyhow::Error::msg)?;
    let profiles = profile::list_profiles(&conn).map_err(anyhow::Error::msg)?;
    let skills = skill::list_skills(&conn).map_err(anyhow::Error::msg)?;
    drop(conn);

    let compile_result = state
        .last_compile
        .read()
        .expect("compile result lock poisoned")
        .clone();
    let active_file = choose_active_text_file(&file_nodes, &config.main_tex);

    Ok(WorkspaceSnapshot {
        project_config: config,
        tree: build_tree(&file_nodes),
        files: Vec::new(),
        active_file,
        providers,
        skills,
        profiles,
        compile_result,
        figure_briefs: briefs,
        assets,
    })
}

fn empty_snapshot(state: &AppState) -> Result<WorkspaceSnapshot> {
    let conn = state.db.lock().expect("db lock poisoned");
    let providers = provider::list_providers(&conn).map_err(anyhow::Error::msg)?;
    let profiles = profile::list_profiles(&conn).map_err(anyhow::Error::msg)?;
    let skills = skill::list_skills(&conn).map_err(anyhow::Error::msg)?;
    drop(conn);

    let config = state
        .project_config
        .read()
        .expect("project config lock poisoned")
        .clone();
    let compile_result = state
        .last_compile
        .read()
        .expect("compile result lock poisoned")
        .clone();

    Ok(WorkspaceSnapshot {
        project_config: config,
        tree: Vec::new(),
        files: Vec::new(),
        active_file: String::new(),
        providers,
        skills,
        profiles,
        compile_result,
        figure_briefs: Vec::new(),
        assets: Vec::new(),
    })
}

pub fn read_file(state: &AppState, file_path: &str) -> Result<ProjectFile> {
    let root = {
        let config = state.project_config.read().expect("project config lock poisoned");
        config.root_path.clone()
    };

    let absolute = Path::new(&root).join(file_path);
    let file_type = detect_file_type(file_path);
    if !is_text_file_type(&file_type) {
        anyhow::bail!("file is not editable text: {file_path}");
    }

    let content = fs::read_to_string(&absolute).context("failed to read project file")?;
    Ok(ProjectFile {
        path: file_path.into(),
        language: detect_language(file_path),
        content,
    })
}

pub fn read_asset(state: &AppState, file_path: &str) -> Result<AssetResource> {
    let root = {
        let config = state.project_config.read().expect("project config lock poisoned");
        config.root_path.clone()
    };

    let absolute = Path::new(&root).join(file_path);
    let metadata = fs::metadata(&absolute).context("failed to read asset metadata")?;
    let mime_type = mime_type_for_path(file_path);
    let data = if mime_type == "application/pdf" {
        Some(fs::read(&absolute).context("failed to read pdf asset")?)
    } else {
        None
    };

    Ok(AssetResource {
        path: file_path.into(),
        absolute_path: absolute.to_string_lossy().to_string(),
        resource_url: None,
        data,
        mime_type,
        size: Some(metadata.len()),
    })
}

pub fn switch_project(state: &AppState, root: &Path) -> Result<WorkspaceSnapshot> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if !root.exists() || !root.is_dir() {
        anyhow::bail!("project directory does not exist: {}", root.display());
    }

    let config = load_project_config(&root);
    {
        let mut project_config = state
            .project_config
            .write()
            .expect("project config lock poisoned");
        *project_config = config.clone();
    }
    {
        let mut last_compile = state
            .last_compile
            .write()
            .expect("compile result lock poisoned");
        *last_compile = default_compile_result(&root, &config.main_tex);
    }
    persist_recent_workspace(&state.app_data_dir, &root)
        .context("failed to persist recent workspace")?;

    let conn = state.db.lock().expect("db lock poisoned");
    skill::discover_skills(&conn, &[root.join("skills")], "project").map_err(anyhow::Error::msg)?;
    drop(conn);

    load_project_snapshot(state)
}

pub fn create_project(
    state: &AppState,
    parent_dir: &Path,
    project_name: &str,
) -> Result<WorkspaceSnapshot> {
    let folder_name = if project_name.trim().is_empty() {
        "ViewerLeaf Project"
    } else {
        project_name.trim()
    };
    let root = parent_dir.join(folder_name);
    initialize_project(&root, folder_name).context("failed to initialize project")?;
    switch_project(state, &root)
}

pub fn save_file(state: &AppState, file_path: &str, content: &str) -> Result<()> {
    let root = {
        let config = state.project_config.read().expect("project config lock poisoned");
        config.root_path.clone()
    };
    let absolute = Path::new(&root).join(file_path);
    if let Some(parent) = absolute.parent() {
        fs::create_dir_all(parent).context("failed to create parent directory")?;
    }
    fs::write(absolute, content).context("failed to write project file")?;
    Ok(())
}

pub fn update_project_config(state: &AppState, config: &ProjectConfig) -> Result<ProjectConfig> {
    let root = Path::new(&config.root_path);
    save_project_config(root, config).context("failed to persist project config")?;

    {
        let mut current = state
            .project_config
            .write()
            .expect("project config lock poisoned");
        *current = config.clone();
    }

    Ok(config.clone())
}
