use rusqlite::{params, Connection};

use crate::models::ProviderConfig;

pub fn list_providers(conn: &Connection) -> Result<Vec<ProviderConfig>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, vendor, base_url, api_key, default_model, is_enabled, sort_order, meta_json FROM providers ORDER BY sort_order, name",
        )
        .map_err(|err| err.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(ProviderConfig {
                id: row.get(0)?,
                name: row.get(1)?,
                vendor: row.get(2)?,
                base_url: row.get(3)?,
                api_key: row.get(4)?,
                default_model: row.get(5)?,
                is_enabled: row.get::<_, i32>(6)? != 0,
                sort_order: row.get(7)?,
                meta_json: row.get(8)?,
            })
        })
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

pub fn add_provider(conn: &Connection, config: &ProviderConfig) -> Result<(), String> {
    conn.execute(
        "INSERT INTO providers (id, name, vendor, base_url, api_key, default_model, is_enabled, sort_order, meta_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            config.id,
            config.name,
            config.vendor,
            config.base_url,
            config.api_key,
            config.default_model,
            config.is_enabled as i32,
            config.sort_order,
            config.meta_json
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn update_provider(conn: &Connection, config: &ProviderConfig) -> Result<(), String> {
    conn.execute(
        "UPDATE providers SET name=?2, vendor=?3, base_url=?4, api_key=?5, default_model=?6, is_enabled=?7, sort_order=?8, meta_json=?9, updated_at=datetime('now') WHERE id=?1",
        params![
            config.id,
            config.name,
            config.vendor,
            config.base_url,
            config.api_key,
            config.default_model,
            config.is_enabled as i32,
            config.sort_order,
            config.meta_json
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn delete_provider(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM providers WHERE id=?1", params![id])
        .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn get_provider(conn: &Connection, id: &str) -> Result<ProviderConfig, String> {
    conn.query_row(
        "SELECT id, name, vendor, base_url, api_key, default_model, is_enabled, sort_order, meta_json FROM providers WHERE id=?1",
        params![id],
        |row| {
            Ok(ProviderConfig {
                id: row.get(0)?,
                name: row.get(1)?,
                vendor: row.get(2)?,
                base_url: row.get(3)?,
                api_key: row.get(4)?,
                default_model: row.get(5)?,
                is_enabled: row.get::<_, i32>(6)? != 0,
                sort_order: row.get(7)?,
                meta_json: row.get(8)?,
            })
        },
    )
    .map_err(|err| err.to_string())
}

pub fn find_first_by_vendor(conn: &Connection, vendor: &str) -> Result<ProviderConfig, String> {
    conn.query_row(
        "SELECT id, name, vendor, base_url, api_key, default_model, is_enabled, sort_order, meta_json FROM providers WHERE vendor=?1 AND is_enabled=1 ORDER BY sort_order, name LIMIT 1",
        params![vendor],
        |row| {
            Ok(ProviderConfig {
                id: row.get(0)?,
                name: row.get(1)?,
                vendor: row.get(2)?,
                base_url: row.get(3)?,
                api_key: row.get(4)?,
                default_model: row.get(5)?,
                is_enabled: row.get::<_, i32>(6)? != 0,
                sort_order: row.get(7)?,
                meta_json: row.get(8)?,
            })
        },
    )
    .map_err(|err| err.to_string())
}
