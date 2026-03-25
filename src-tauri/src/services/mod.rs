use std::path::Path;

pub mod agent;
pub mod cli_agent;
pub mod compile;
pub mod compute_node;
pub mod experiment;
pub mod figure;
pub mod literature;
pub mod profile;
pub mod project;
pub mod provider;
pub mod research;
pub mod sidecar;
pub mod skill;
pub mod sync;
pub mod terminal;
pub mod wechat_bridge;
pub mod worker;

/// Build a PATH string that includes common TeX installation directories.
/// When a macOS .app is launched from Finder the inherited PATH is minimal
/// (/usr/bin:/bin:/usr/sbin:/sbin), so latexmk/xelatex/synctex are not found.
pub(crate) fn enriched_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let mut extra: Vec<String> = Vec::new();

    #[cfg(target_os = "macos")]
    {
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
    }

    #[cfg(target_os = "linux")]
    {
        for dir in ["/usr/local/bin", "/usr/bin"] {
            if Path::new(dir).is_dir() && !current.contains(dir) {
                extra.push(dir.to_string());
            }
        }

        if let Ok(entries) = std::fs::read_dir("/usr/local/texlive") {
            for entry in entries.flatten() {
                let bin_dir = entry.path().join("bin");
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
            let tiny = home.join(".TinyTeX/bin");
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
    }

    #[cfg(windows)]
    {
        // MiKTeX default install locations
        let miktex_candidates = [
            r"C:\Program Files\MiKTeX\miktex\bin\x64",
            r"C:\Program Files\MiKTeX\miktex\bin",
            r"C:\Program Files (x86)\MiKTeX\miktex\bin",
        ];
        for dir in miktex_candidates {
            if Path::new(dir).is_dir() && !current.contains(dir) {
                extra.push(dir.to_string());
            }
        }

        // TeX Live for Windows: C:\texlive\YYYY\bin\windows
        if let Ok(entries) = std::fs::read_dir(r"C:\texlive") {
            for entry in entries.flatten() {
                let bin_dir = entry.path().join("bin").join("windows");
                let s = bin_dir.to_string_lossy().to_string();
                if bin_dir.is_dir() && !current.contains(&s) {
                    extra.push(s);
                }
            }
        }

        // TinyTeX on Windows: %APPDATA%\TinyTeX\bin\windows
        if let Some(appdata) = std::env::var("APPDATA").ok().map(std::path::PathBuf::from) {
            let tiny = appdata.join("TinyTeX").join("bin").join("windows");
            let s = tiny.to_string_lossy().to_string();
            if tiny.is_dir() && !current.contains(&s) {
                extra.push(s);
            }
        }
    }

    if extra.is_empty() {
        current
    } else {
        let sep = if cfg!(windows) { ";" } else { ":" };
        format!("{}{}{}", extra.join(sep), sep, current)
    }
}
