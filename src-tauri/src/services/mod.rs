use std::path::Path;

pub mod agent;
pub mod compile;
pub mod figure;
pub mod profile;
pub mod project;
pub mod provider;
pub mod skill;
pub mod sync;

/// Build a PATH string that includes common TeX installation directories.
/// When a macOS .app is launched from Finder the inherited PATH is minimal
/// (/usr/bin:/bin:/usr/sbin:/sbin), so latexmk/xelatex/synctex are not found.
pub(crate) fn enriched_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();

    let mut extra: Vec<String> = Vec::new();

    for dir in ["/Library/TeX/texbin", "/usr/local/bin"] {
        if Path::new(dir).is_dir() && !current.contains(dir) {
            extra.push(dir.to_string());
        }
    }

    if let Ok(entries) = std::fs::read_dir("/usr/local/texlive") {
        for entry in entries.flatten() {
            let bin_dir = entry.path().join("bin");
            if !bin_dir.is_dir() {
                continue;
            }
            if let Ok(sub) = std::fs::read_dir(&bin_dir) {
                for arch in sub.flatten() {
                    let p = arch.path();
                    let s = p.to_string_lossy().to_string();
                    if p.is_dir() && !current.contains(&s) {
                        extra.push(s);
                    }
                }
            }
        }
    }

    if let Some(home) = dirs::home_dir() {
        let tiny = home.join("Library/TinyTeX/bin");
        if tiny.is_dir() {
            if let Ok(sub) = std::fs::read_dir(&tiny) {
                for arch in sub.flatten() {
                    let p = arch.path();
                    let s = p.to_string_lossy().to_string();
                    if p.is_dir() && !current.contains(&s) {
                        extra.push(s);
                    }
                }
            }
        }
    }

    if extra.is_empty() {
        current
    } else {
        format!("{}:{}", extra.join(":"), current)
    }
}
