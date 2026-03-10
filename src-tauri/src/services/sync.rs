use anyhow::{Context, Result};
use regex::Regex;
use std::path::Path;
use std::process::Command;

use crate::models::SyncLocation;
use crate::services::enriched_path;
use crate::state::AppState;

pub fn forward_search(state: &AppState, file_path: &str, line: usize) -> Result<SyncLocation> {
    let config = state.project_config.read().expect("project config lock poisoned");
    let root_path = config.root_path.clone();
    let main_tex = config.main_tex.clone();
    drop(config);

    let root = Path::new(&root_path);
    let pdf_path = root.join(main_tex.replace(".tex", ".pdf"));
    let file_absolute = root.join(file_path);

    let output = Command::new("synctex")
        .args([
            "view",
            "-i",
            &format!("{line}:1:{}", file_absolute.to_string_lossy()),
            "-o",
            &pdf_path.to_string_lossy(),
        ])
        .env("PATH", enriched_path())
        .current_dir(root)
        .output()
        .context("failed to run synctex view")?;

    let text = String::from_utf8_lossy(&output.stdout);
    let page_re = Regex::new(r"Page:(?P<page>\d+)").expect("valid regex");
    let page = page_re
        .captures(&text)
        .and_then(|caps| caps.name("page"))
        .and_then(|m| m.as_str().parse::<usize>().ok())
        .unwrap_or(1);

    Ok(SyncLocation {
        file_path: file_path.into(),
        line,
        column: 1,
        page,
    })
}

pub fn reverse_search(state: &AppState, page: usize) -> Result<SyncLocation> {
    let config = state.project_config.read().expect("project config lock poisoned");
    let root_path = config.root_path.clone();
    let main_tex = config.main_tex.clone();
    drop(config);

    let root = Path::new(&root_path);
    let pdf_path = root.join(main_tex.replace(".tex", ".pdf"));

    let output = Command::new("synctex")
        .args(["edit", "-o", &format!("{page}:0:0:{}", pdf_path.to_string_lossy())])
        .env("PATH", enriched_path())
        .current_dir(root)
        .output()
        .context("failed to run synctex edit")?;

    let text = String::from_utf8_lossy(&output.stdout);
    let file_re = Regex::new(r"Input:(?P<file>.+)").expect("valid regex");
    let line_re = Regex::new(r"Line:(?P<line>\d+)").expect("valid regex");

    let file_path = file_re
        .captures(&text)
        .and_then(|caps| caps.name("file"))
        .map(|m| {
            Path::new(m.as_str())
                .strip_prefix(root)
                .unwrap_or_else(|_| Path::new(m.as_str()))
                .to_string_lossy()
                .replace('\\', "/")
        })
        .unwrap_or_else(|| "main.tex".into());
    let line = line_re
        .captures(&text)
        .and_then(|caps| caps.name("line"))
        .and_then(|m| m.as_str().parse::<usize>().ok())
        .unwrap_or(1);

    Ok(SyncLocation {
        file_path,
        line,
        column: 1,
        page,
    })
}
