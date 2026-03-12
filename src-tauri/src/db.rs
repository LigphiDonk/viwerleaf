use std::path::Path;

use rusqlite::{params, Connection, Result as SqlResult};

const DEFAULT_CHAT_TOOLS: &str = r#"["tool_search","list","read","glob","grep","edit","write","apply_patch","list_sections","read_section","read_bib_entries","list_files","search_project","apply_text_patch","insert_at_line"]"#;

const REQUIRED_CHAT_TOOLS: &[&str] = &[
    "tool_search",
    "list",
    "read",
    "glob",
    "grep",
    "edit",
    "write",
    "apply_patch",
    "list_sections",
    "read_section",
    "read_bib_entries",
];

pub fn init_db(app_data_dir: &Path) -> SqlResult<Connection> {
    std::fs::create_dir_all(app_data_dir).ok();
    let db_path = app_data_dir.join("viewerleaf.db");
    let conn = Connection::open(db_path)?;

    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

    // Recreate profiles table without restrictive CHECK constraints if needed.
    migrate_profiles_table(&conn)?;

    conn.execute_batch(include_str!("schema.sql"))?;

    let count: i64 = conn.query_row("SELECT COUNT(*) FROM providers", [], |row| row.get(0))?;
    if count == 0 {
        seed_providers(&conn)?;
        seed_profiles(&conn)?;
        seed_skills(&conn)?;
    } else {
        migrate_profiles(&conn)?;
    }

    Ok(conn)
}

/// Drop and recreate the profiles table if it still has the old strict CHECK constraints.
/// Detected by attempting to insert a 'chat' stage into a temp row.
fn migrate_profiles_table(conn: &rusqlite::Connection) -> SqlResult<()> {
    // Check if the profiles table exists at all first
    let table_exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='profiles'",
        [],
        |row| row.get(0),
    )?;
    if table_exists == 0 {
        return Ok(()); // will be created by schema.sql
    }

    // Probe whether the current table accepts 'chat' stage
    let check_ok = conn.execute_batch(
        "SAVEPOINT probe;
         INSERT INTO profiles (id,label,stage,provider_id,model,output_mode,is_builtin)
           VALUES ('__probe__','probe','chat','__none__','','chat',0);
         DELETE FROM profiles WHERE id='__probe__';
         RELEASE SAVEPOINT probe;",
    );

    if check_ok.is_ok() {
        return Ok(()); // constraint already allows 'chat'
    }

    // Rollback the failed savepoint
    let _ = conn.execute_batch("ROLLBACK TO SAVEPOINT probe; RELEASE SAVEPOINT probe;");

    // Rebuild the table without the old CHECK constraints
    conn.execute_batch(
        "PRAGMA foreign_keys=OFF;
         BEGIN;
         CREATE TABLE profiles_new (
             id                   TEXT PRIMARY KEY,
             label                TEXT NOT NULL,
             summary              TEXT NOT NULL DEFAULT '',
             stage                TEXT NOT NULL DEFAULT 'chat',
             provider_id          TEXT NOT NULL,
             model                TEXT NOT NULL,
             skill_ids_json       TEXT NOT NULL DEFAULT '[]',
             tool_allowlist_json  TEXT NOT NULL DEFAULT '[]',
             output_mode          TEXT NOT NULL DEFAULT 'chat',
             sort_order           INTEGER NOT NULL DEFAULT 0,
             is_builtin           INTEGER NOT NULL DEFAULT 0
         );
         INSERT INTO profiles_new SELECT id,label,summary,stage,provider_id,model,
             skill_ids_json,tool_allowlist_json,output_mode,sort_order,is_builtin FROM profiles;
         DROP TABLE profiles;
         ALTER TABLE profiles_new RENAME TO profiles;
         COMMIT;
         PRAGMA foreign_keys=ON;",
    )?;

    Ok(())
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
    conn.execute(
        "INSERT INTO profiles (id, label, summary, stage, provider_id, model, skill_ids_json, tool_allowlist_json, output_mode, is_builtin) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1)",
        params!["chat", "Chat", "General assistant", "chat", "anthropic-main", "claude-sonnet-4", "[]", DEFAULT_CHAT_TOOLS, "chat"],
    )?;
    Ok(())
}

/// Replace legacy academic profiles with a single generic chat profile.
fn migrate_profiles(conn: &Connection) -> SqlResult<()> {
    let old_ids = ["outline", "draft", "polish", "de_ai", "review"];
    let chat_exists: i64 =
        conn.query_row("SELECT COUNT(*) FROM profiles WHERE id='chat'", [], |row| {
            row.get(0)
        })?;

    // Remove old builtin profiles
    for id in &old_ids {
        conn.execute(
            "DELETE FROM profiles WHERE id=?1 AND is_builtin=1",
            params![id],
        )?;
    }

    // Insert chat profile if not already present
    if chat_exists == 0 {
        // Pick the first enabled provider as default
        let provider_id: String = conn
            .query_row(
                "SELECT id FROM providers WHERE is_enabled=1 ORDER BY sort_order LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| "anthropic-main".to_string());
        conn.execute(
            "INSERT INTO profiles (id, label, summary, stage, provider_id, model, skill_ids_json, tool_allowlist_json, output_mode, is_builtin) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1)",
            params!["chat", "Chat", "General assistant", "chat", provider_id, "", "[]", DEFAULT_CHAT_TOOLS, "chat"],
        )?;
    } else {
        ensure_builtin_chat_tools(conn, REQUIRED_CHAT_TOOLS)?;
    }

    Ok(())
}

fn ensure_builtin_chat_tools(conn: &Connection, tool_ids: &[&str]) -> SqlResult<()> {
    let current: Option<String> = conn
        .query_row(
            "SELECT tool_allowlist_json FROM profiles WHERE id='chat' AND is_builtin=1 LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();
    let Some(current) = current else {
        return Ok(());
    };

    let mut tools: Vec<String> = serde_json::from_str(&current).unwrap_or_default();
    let mut changed = false;
    for tool_id in tool_ids {
        if tools.iter().any(|item| item == tool_id) {
            continue;
        }
        tools.push((*tool_id).to_string());
        changed = true;
    }

    if !changed {
        return Ok(());
    }
    let tools_json = serde_json::to_string(&tools).unwrap_or_else(|_| current.clone());
    conn.execute(
        "UPDATE profiles SET tool_allowlist_json=?1 WHERE id='chat' AND is_builtin=1",
        params![tools_json],
    )?;
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
