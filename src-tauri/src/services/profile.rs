use rusqlite::{params, Connection};

use crate::models::ProfileConfig;

pub fn list_profiles(conn: &Connection) -> Result<Vec<ProfileConfig>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, label, summary, stage, provider_id, model, skill_ids_json, tool_allowlist_json, output_mode, sort_order, is_builtin FROM profiles ORDER BY sort_order, label",
        )
        .map_err(|err| err.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let skill_ids_raw: String = row.get(6)?;
            let tool_allowlist_raw: String = row.get(7)?;
            Ok(ProfileConfig {
                id: row.get(0)?,
                label: row.get(1)?,
                summary: row.get(2)?,
                stage: row.get(3)?,
                provider_id: row.get(4)?,
                model: row.get(5)?,
                skill_ids: serde_json::from_str(&skill_ids_raw).unwrap_or_default(),
                tool_allowlist: serde_json::from_str(&tool_allowlist_raw).unwrap_or_default(),
                output_mode: row.get(8)?,
                sort_order: row.get(9)?,
                is_builtin: row.get::<_, i32>(10)? != 0,
            })
        })
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

pub fn get_profile(conn: &Connection, id: &str) -> Result<ProfileConfig, String> {
    conn.query_row(
        "SELECT id, label, summary, stage, provider_id, model, skill_ids_json, tool_allowlist_json, output_mode, sort_order, is_builtin FROM profiles WHERE id=?1",
        params![id],
        |row| {
            let skill_ids_raw: String = row.get(6)?;
            let tool_allowlist_raw: String = row.get(7)?;
            Ok(ProfileConfig {
                id: row.get(0)?,
                label: row.get(1)?,
                summary: row.get(2)?,
                stage: row.get(3)?,
                provider_id: row.get(4)?,
                model: row.get(5)?,
                skill_ids: serde_json::from_str(&skill_ids_raw).unwrap_or_default(),
                tool_allowlist: serde_json::from_str(&tool_allowlist_raw).unwrap_or_default(),
                output_mode: row.get(8)?,
                sort_order: row.get(9)?,
                is_builtin: row.get::<_, i32>(10)? != 0,
            })
        },
    )
    .map_err(|err| err.to_string())
}

pub fn update_profile(conn: &Connection, config: &ProfileConfig) -> Result<(), String> {
    let skill_ids_json = serde_json::to_string(&config.skill_ids).unwrap_or_else(|_| "[]".into());
    let tool_allowlist_json =
        serde_json::to_string(&config.tool_allowlist).unwrap_or_else(|_| "[]".into());

    conn.execute(
        "UPDATE profiles SET label=?2, summary=?3, stage=?4, provider_id=?5, model=?6, skill_ids_json=?7, tool_allowlist_json=?8, output_mode=?9, sort_order=?10 WHERE id=?1",
        params![
            config.id,
            config.label,
            config.summary,
            config.stage,
            config.provider_id,
            config.model,
            skill_ids_json,
            tool_allowlist_json,
            config.output_mode,
            config.sort_order
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}
