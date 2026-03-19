use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:warning=staging worker template resources");
    stage_worker_template().expect("failed to stage worker template resources");
    println!("cargo:warning=staging sidecar resources");
    stage_sidecar().expect("failed to stage sidecar resources");
    println!("cargo:warning=staged bundle resources");
    tauri_build::build()
}

fn stage_worker_template() -> io::Result<()> {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is missing"));
    let source_root = manifest_dir.join("../workers");
    let target_root = manifest_dir.join("resources/worker-template");

    let include_paths = [
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "wrangler.template.toml",
        "migrations",
        "scripts",
        "src",
    ];

    if target_root.exists() {
        fs::remove_dir_all(&target_root)?;
    }
    fs::create_dir_all(&target_root)?;

    for relative in include_paths {
        let source = source_root.join(relative);
        let target = target_root.join(relative);
        emit_rerun_markers(&source)?;
        copy_path(&source, &target)?;
    }

    Ok(())
}

fn stage_sidecar() -> io::Result<()> {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is missing"));
    let source_root = manifest_dir.join("../sidecar");
    let target_root = manifest_dir.join("resources/sidecar");
    // Only bundle the pre-built single-file output produced by `npm run sidecar:build`.
    // Shipping node_modules directly would exhaust disk space on Windows CI runners.
    let include_paths = ["dist/index.mjs"];

    if target_root.exists() {
        fs::remove_dir_all(&target_root)?;
    }
    fs::create_dir_all(&target_root)?;

    for relative in include_paths {
        let source = source_root.join(relative);
        let target = target_root.join(relative);
        emit_rerun_markers(&source)?;
        copy_path(&source, &target)?;
    }

    Ok(())
}

fn emit_rerun_markers(path: &Path) -> io::Result<()> {
    let mut pending = vec![path.to_path_buf()];

    while let Some(current) = pending.pop() {
        println!("cargo:rerun-if-changed={}", current.display());
        if !current.is_dir() {
            continue;
        }

        // Skip node_modules: tracked via package-lock.json, and recursing into
        // it emits tens-of-thousands of markers which hangs Cargo on Windows.
        if current.file_name().and_then(|n| n.to_str()) == Some("node_modules") {
            continue;
        }

        for entry in fs::read_dir(&current)? {
            pending.push(entry?.path());
        }
    }

    Ok(())
}

fn copy_path(source: &Path, target: &Path) -> io::Result<()> {
    let mut pending = vec![(source.to_path_buf(), target.to_path_buf())];

    while let Some((current_source, current_target)) = pending.pop() {
        if current_source.is_dir() {
            fs::create_dir_all(&current_target)?;
            for entry in fs::read_dir(&current_source)? {
                let entry = entry?;
                pending.push((entry.path(), current_target.join(entry.file_name())));
            }
            continue;
        }

        if let Some(parent) = current_target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&current_source, &current_target)?;
    }

    Ok(())
}
