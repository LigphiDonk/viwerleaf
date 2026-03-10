use std::path::Path;

use rusqlite::{params, Connection, Result as SqlResult};

pub fn init_db(app_data_dir: &Path) -> SqlResult<Connection> {
    std::fs::create_dir_all(app_data_dir).ok();
    let db_path = app_data_dir.join("viewerleaf.db");
    let conn = Connection::open(db_path)?;

    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    conn.execute_batch(include_str!("schema.sql"))?;

    let count: i64 = conn.query_row("SELECT COUNT(*) FROM providers", [], |row| row.get(0))?;
    if count == 0 {
        seed_providers(&conn)?;
        seed_profiles(&conn)?;
        seed_skills(&conn)?;
    }

    Ok(conn)
}

fn seed_providers(conn: &Connection) -> SqlResult<()> {
    let providers = vec![
        (
            "openai-main",
            "OpenAI",
            "openai",
            "https://api.openai.com/v1",
            "gpt-4.1",
        ),
        (
            "anthropic-main",
            "Anthropic",
            "anthropic",
            "https://api.anthropic.com",
            "claude-sonnet-4",
        ),
        (
            "openrouter-lab",
            "OpenRouter",
            "openrouter",
            "https://openrouter.ai/api/v1",
            "claude-3.7-sonnet",
        ),
        (
            "deepseek-main",
            "DeepSeek",
            "deepseek",
            "https://api.deepseek.com/v1",
            "deepseek-chat",
        ),
    ];

    for (id, name, vendor, url, model) in providers {
        conn.execute(
            "INSERT INTO providers (id, name, vendor, base_url, default_model) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, vendor, url, model],
        )?;
    }

    Ok(())
}

fn seed_profiles(conn: &Connection) -> SqlResult<()> {
    let profiles = vec![
        (
            "outline",
            "Outline",
            "Generate section structure",
            "planning",
            "openai-main",
            "gpt-4.1",
            r#"["academic-outline"]"#,
            r#"["read_section","list_sections","insert_at_line"]"#,
            "outline",
        ),
        (
            "draft",
            "Draft",
            "Expand notes into academic prose",
            "drafting",
            "anthropic-main",
            "claude-sonnet-4",
            r#"["academic-draft"]"#,
            r#"["read_section","apply_text_patch"]"#,
            "rewrite",
        ),
        (
            "polish",
            "Polish",
            "Tighten style and compress phrasing",
            "revision",
            "openrouter-lab",
            "claude-3.7-sonnet",
            r#"["academic-polish"]"#,
            r#"["read_section","apply_text_patch"]"#,
            "rewrite",
        ),
        (
            "de_ai",
            "De-AI",
            "Remove AI writing artifacts",
            "revision",
            "openai-main",
            "gpt-4.1-mini",
            r#"["academic-de-ai"]"#,
            r#"["read_section","apply_text_patch"]"#,
            "rewrite",
        ),
        (
            "review",
            "Review",
            "Critical review like a tough reviewer",
            "submission",
            "anthropic-main",
            "claude-sonnet-4",
            r#"["academic-review"]"#,
            r#"["read_section","search_project","read_bib_entries"]"#,
            "review",
        ),
    ];

    for (id, label, summary, stage, provider, model, skills, tools, mode) in profiles {
        conn.execute(
            "INSERT INTO profiles (id, label, summary, stage, provider_id, model, skill_ids_json, tool_allowlist_json, output_mode, is_builtin) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1)",
            params![id, label, summary, stage, provider, model, skills, tools, mode],
        )?;
    }

    Ok(())
}

fn seed_skills(conn: &Connection) -> SqlResult<()> {
    let skills = vec![
        (
            "academic-outline",
            "Academic Outline",
            r#"["planning"]"#,
            r#"["read_section","list_sections","insert_at_line"]"#,
        ),
        (
            "academic-draft",
            "Academic Draft",
            r#"["drafting"]"#,
            r#"["read_section","apply_text_patch"]"#,
        ),
        (
            "academic-polish",
            "Academic Polish",
            r#"["revision"]"#,
            r#"["read_section","apply_text_patch"]"#,
        ),
        (
            "academic-de-ai",
            "Academic De-AI",
            r#"["revision"]"#,
            r#"["read_section","apply_text_patch"]"#,
        ),
        (
            "academic-review",
            "Academic Review",
            r#"["submission"]"#,
            r#"["read_section","search_project","read_bib_entries"]"#,
        ),
        (
            "banana-figure",
            "Banana Figure",
            r#"["figures"]"#,
            r#"["read_section"]"#,
        ),
    ];

    for (id, name, stages, tools) in skills {
        conn.execute(
            "INSERT INTO skills (id, name, stages_json, tools_json, source) VALUES (?1,?2,?3,?4,'builtin')",
            params![id, name, stages, tools],
        )?;
    }

    Ok(())
}
