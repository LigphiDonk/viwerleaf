use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

use crate::models::{
    LiteratureAttachment, LiteratureCandidate, LiteratureItem, LiteratureSearchResult,
};

const ITEM_SELECT_SQL: &str = "SELECT id, title, authors_json, year, journal, doi, abstract, tags_json, notes, dedup_hash, linked_task_ids_json, added_at, updated_at FROM literature_items";

/// Compute a dedup hash from normalized title and year.
pub fn compute_dedup_hash(title: &str, year: i32) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let normalized = title
        .trim()
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric(), "");
    let mut hasher = DefaultHasher::new();
    normalized.hash(&mut hasher);
    year.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn parse_json_vec(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn to_json_vec(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".into())
}

fn truncate_preview(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut preview = trimmed.chars().take(max_chars).collect::<String>();
    if trimmed.chars().count() > max_chars {
        preview.push_str("...");
    }
    preview
}

fn normalized_tokens(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .map(|token| token.trim().to_lowercase())
        .filter(|token| !token.is_empty())
        .collect()
}

fn matches_tokens(text: &str, tokens: &[String]) -> bool {
    if tokens.is_empty() {
        return false;
    }

    let lower = text.to_lowercase();
    tokens.iter().all(|token| lower.contains(token))
}

fn build_match_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|token| token.trim())
        .filter(|token| !token.is_empty())
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<LiteratureItem> {
    let authors_json: String = row.get(2)?;
    let tags_json: String = row.get(7)?;
    let linked_json: String = row.get(10)?;
    Ok(LiteratureItem {
        id: row.get(0)?,
        title: row.get(1)?,
        authors: parse_json_vec(&authors_json),
        year: row.get(3)?,
        journal: row.get(4)?,
        doi: row.get(5)?,
        abstract_text: row.get(6)?,
        tags: parse_json_vec(&tags_json),
        notes: row.get(8)?,
        dedup_hash: row.get(9)?,
        linked_task_ids: parse_json_vec(&linked_json),
        added_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn get_item(conn: &Connection, id: &str) -> Result<LiteratureItem, String> {
    conn.query_row(
        &format!("{ITEM_SELECT_SQL} WHERE id=?1"),
        params![id],
        row_to_item,
    )
    .map_err(|err| err.to_string())
}

fn get_item_rowid(conn: &Connection, id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT rowid FROM literature_items WHERE id=?1",
        params![id],
        |row| row.get(0),
    )
    .map_err(|err| err.to_string())
}

fn remove_search_index(conn: &Connection, id: &str) -> Result<(), String> {
    let rowid = match get_item_rowid(conn, id) {
        Ok(rowid) => rowid,
        Err(_) => return Ok(()),
    };

    conn.execute("DELETE FROM literature_fts WHERE rowid=?1", params![rowid])
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn index_item(conn: &Connection, id: &str) -> Result<(), String> {
    let rowid = get_item_rowid(conn, id)?;
    let item = get_item(conn, id)?;
    let authors = item.authors.join(", ");
    let chunk_content: String = conn
        .query_row(
            "SELECT COALESCE(GROUP_CONCAT(content, ' '), '') FROM (SELECT content FROM literature_chunks WHERE literature_id=?1 ORDER BY chunk_index)",
            params![id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;

    conn.execute("DELETE FROM literature_fts WHERE rowid=?1", params![rowid])
        .map_err(|err| err.to_string())?;
    conn.execute(
        "INSERT INTO literature_fts (rowid, title, authors, abstract, chunk_content, notes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            rowid,
            item.title,
            authors,
            item.abstract_text,
            chunk_content,
            item.notes
        ],
    )
    .map_err(|err| err.to_string())?;

    Ok(())
}

fn ensure_search_index(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id FROM literature_items")
        .map_err(|err| err.to_string())?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    for id in ids {
        index_item(conn, &id)?;
    }

    conn.execute(
        "DELETE FROM literature_fts WHERE rowid NOT IN (SELECT rowid FROM literature_items)",
        [],
    )
    .map_err(|err| err.to_string())?;

    Ok(())
}

fn unique_pdf_filename(source_path: &Path, literature_id: &str) -> String {
    let stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(literature_id)
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let stem = if stem.is_empty() {
        literature_id.to_string()
    } else {
        stem
    };
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("pdf");
    let suffix = uuid::Uuid::new_v4().simple().to_string();

    format!("{stem}-{}.{}", &suffix[..8], extension)
}

fn stage_pdf_copy(
    source_path: &Path,
    project_root: &Path,
    literature_id: &str,
) -> Result<(String, PathBuf), String> {
    if !source_path.is_file() {
        return Err(format!(
            "PDF source does not exist: {}",
            source_path.to_string_lossy()
        ));
    }

    let lit_dir = project_root
        .join(".viewerleaf")
        .join("literature")
        .join("pdfs");
    std::fs::create_dir_all(&lit_dir).map_err(|err| err.to_string())?;

    let filename = unique_pdf_filename(source_path, literature_id);
    let dest = lit_dir.join(&filename);
    std::fs::copy(source_path, &dest).map_err(|err| format!("failed to copy PDF: {err}"))?;

    Ok((format!(".viewerleaf/literature/pdfs/{filename}"), dest))
}

fn insert_pdf_attachment(
    conn: &Connection,
    literature_id: &str,
    file_path: &str,
    source: &str,
) -> Result<LiteratureAttachment, String> {
    let attachment = LiteratureAttachment {
        id: uuid::Uuid::new_v4().to_string(),
        literature_id: literature_id.to_string(),
        kind: "pdf".to_string(),
        file_path: file_path.to_string(),
        ocr_status: "none".to_string(),
        source: source.to_string(),
        created_at: String::new(),
    };

    conn.execute(
        "INSERT INTO literature_attachments (id, literature_id, kind, file_path, source) VALUES (?1, ?2, 'pdf', ?3, ?4)",
        params![attachment.id, attachment.literature_id, attachment.file_path, attachment.source],
    )
    .map_err(|err| err.to_string())?;

    Ok(attachment)
}

fn attachment_exists(
    conn: &Connection,
    literature_id: &str,
    file_path: &str,
) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM literature_attachments WHERE literature_id=?1 AND file_path=?2",
            params![literature_id, file_path],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    Ok(count > 0)
}

fn load_candidate(conn: &Connection, inbox_id: &str) -> Result<LiteratureCandidate, String> {
    conn.query_row(
        "SELECT id, title, authors_json, year, doi, abstract, source_context, pdf_path, dedup_status, matched_item_id, created_at FROM literature_inbox WHERE id=?1",
        params![inbox_id],
        |row| {
            let authors_json: String = row.get(2)?;
            Ok(LiteratureCandidate {
                id: row.get(0)?,
                title: row.get(1)?,
                authors: parse_json_vec(&authors_json),
                year: row.get(3)?,
                doi: row.get(4)?,
                abstract_text: row.get(5)?,
                source_context: row.get(6)?,
                pdf_path: row.get(7)?,
                dedup_status: row.get(8)?,
                matched_item_id: row.get(9)?,
                created_at: row.get(10)?,
            })
        },
    )
    .map_err(|err| format!("inbox item not found: {err}"))
}

fn merge_candidate_into_item(
    conn: &Connection,
    candidate: &LiteratureCandidate,
    item_id: &str,
) -> Result<LiteratureItem, String> {
    let mut item = get_item(conn, item_id)?;
    let merged_authors = if item.authors.is_empty() && !candidate.authors.is_empty() {
        candidate.authors.clone()
    } else {
        item.authors.clone()
    };
    let merged_year = if item.year == 0 && candidate.year != 0 {
        candidate.year
    } else {
        item.year
    };
    let merged_doi = if item.doi.trim().is_empty() && !candidate.doi.trim().is_empty() {
        candidate.doi.clone()
    } else {
        item.doi.clone()
    };
    let merged_abstract =
        if item.abstract_text.trim().is_empty() && !candidate.abstract_text.trim().is_empty() {
            candidate.abstract_text.clone()
        } else {
            item.abstract_text.clone()
        };

    if merged_authors != item.authors
        || merged_year != item.year
        || merged_doi != item.doi
        || merged_abstract != item.abstract_text
    {
        conn.execute(
            "UPDATE literature_items SET authors_json=?1, year=?2, doi=?3, abstract=?4, updated_at=datetime('now') WHERE id=?5",
            params![
                to_json_vec(&merged_authors),
                merged_year,
                merged_doi,
                merged_abstract,
                item_id
            ],
        )
        .map_err(|err| err.to_string())?;
        item = get_item(conn, item_id)?;
        index_item(conn, item_id)?;
    }

    if !candidate.pdf_path.trim().is_empty()
        && !attachment_exists(conn, item_id, &candidate.pdf_path)?
    {
        insert_pdf_attachment(conn, item_id, &candidate.pdf_path, "manual")?;
    }

    Ok(item)
}

fn find_matching_chunk(
    conn: &Connection,
    literature_id: &str,
    token: &str,
) -> Result<Option<(i32, String)>, String> {
    let pattern = format!("%{}%", token.to_lowercase());

    let result = conn
        .query_row(
            "SELECT chunk_index, content FROM literature_chunks WHERE literature_id=?1 AND LOWER(content) LIKE ?2 ORDER BY chunk_index LIMIT 1",
            params![literature_id, pattern],
            |row| Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?)),
        )
        .ok();

    Ok(result)
}

pub fn list_items(conn: &Connection) -> Result<Vec<LiteratureItem>, String> {
    let mut stmt = conn
        .prepare(&format!("{ITEM_SELECT_SQL} ORDER BY added_at DESC"))
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], row_to_item)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

pub fn add_item(conn: &Connection, item: &LiteratureItem) -> Result<(), String> {
    let dedup_hash = if item.dedup_hash.is_empty() {
        compute_dedup_hash(&item.title, item.year)
    } else {
        item.dedup_hash.clone()
    };

    conn.execute(
        "INSERT INTO literature_items (id, title, authors_json, year, journal, doi, abstract, tags_json, notes, dedup_hash, linked_task_ids_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            item.id,
            item.title,
            to_json_vec(&item.authors),
            item.year,
            item.journal,
            item.doi,
            item.abstract_text,
            to_json_vec(&item.tags),
            item.notes,
            dedup_hash,
            to_json_vec(&item.linked_task_ids)
        ],
    )
    .map_err(|err| err.to_string())?;
    index_item(conn, &item.id)?;

    Ok(())
}

pub fn add_item_with_pdf(
    conn: &mut Connection,
    item: &LiteratureItem,
    source_path: &Path,
    project_root: &Path,
) -> Result<LiteratureItem, String> {
    let (relative_path, absolute_path) = stage_pdf_copy(source_path, project_root, &item.id)?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;

    let result = (|| -> Result<(), String> {
        add_item(&tx, item)?;
        insert_pdf_attachment(&tx, &item.id, &relative_path, "manual")?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(())
    })();

    if let Err(err) = result {
        let _ = std::fs::remove_file(&absolute_path);
        return Err(err);
    }

    get_item(conn, &item.id)
}

pub fn update_notes(conn: &Connection, id: &str, notes: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE literature_items SET notes=?1, updated_at=datetime('now') WHERE id=?2",
        params![notes, id],
    )
    .map_err(|err| err.to_string())?;
    index_item(conn, id)?;

    Ok(())
}

pub fn merge_source_metadata(
    conn: &Connection,
    id: &str,
    journal: &str,
    tags: &[String],
    notes: &str,
) -> Result<(), String> {
    let item = get_item(conn, id)?;

    let merged_journal = if item.journal.trim().is_empty() && !journal.trim().is_empty() {
        journal.trim().to_string()
    } else {
        item.journal.clone()
    };

    let mut merged_tags = item.tags.clone();
    for tag in tags {
        let normalized = tag.trim();
        if normalized.is_empty() || merged_tags.iter().any(|existing| existing == normalized) {
            continue;
        }
        merged_tags.push(normalized.to_string());
    }

    let merged_notes = if item.notes.trim().is_empty() && !notes.trim().is_empty() {
        notes.trim().to_string()
    } else if !notes.trim().is_empty() && !item.notes.contains(notes.trim()) {
        format!("{}\n\n{}", item.notes.trim(), notes.trim())
            .trim()
            .to_string()
    } else {
        item.notes.clone()
    };

    conn.execute(
        "UPDATE literature_items SET journal=?1, tags_json=?2, notes=?3, updated_at=datetime('now') WHERE id=?4",
        params![merged_journal, to_json_vec(&merged_tags), merged_notes, id],
    )
    .map_err(|err| err.to_string())?;
    index_item(conn, id)?;

    Ok(())
}

pub fn delete_item(conn: &Connection, id: &str) -> Result<(), String> {
    remove_search_index(conn, id)?;
    conn.execute("DELETE FROM literature_items WHERE id=?1", params![id])
        .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn link_to_task(conn: &Connection, literature_id: &str, task_id: &str) -> Result<(), String> {
    let current: String = conn
        .query_row(
            "SELECT linked_task_ids_json FROM literature_items WHERE id=?1",
            params![literature_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;

    let mut ids = parse_json_vec(&current);
    if !ids.iter().any(|id| id == task_id) {
        ids.push(task_id.to_string());
    }

    conn.execute(
        "UPDATE literature_items SET linked_task_ids_json=?1, updated_at=datetime('now') WHERE id=?2",
        params![to_json_vec(&ids), literature_id],
    )
    .map_err(|err| err.to_string())?;

    Ok(())
}

/// Check dedup: DOI > dedup_hash (normalized title+year).
/// Returns Some(existing_id) if duplicate found.
pub fn check_dedup(
    conn: &Connection,
    doi: &str,
    title: &str,
    year: i32,
) -> Result<Option<String>, String> {
    if !doi.is_empty() {
        let result: Option<String> = conn
            .query_row(
                "SELECT id FROM literature_items WHERE doi=?1 AND doi!='' LIMIT 1",
                params![doi],
                |row| row.get(0),
            )
            .ok();
        if let Some(id) = result {
            return Ok(Some(id));
        }
    }

    let hash = compute_dedup_hash(title, year);
    let result: Option<String> = conn
        .query_row(
            "SELECT id FROM literature_items WHERE dedup_hash=?1 AND dedup_hash!='' LIMIT 1",
            params![hash],
            |row| row.get(0),
        )
        .ok();

    Ok(result)
}

pub fn list_inbox(conn: &Connection) -> Result<Vec<LiteratureCandidate>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, authors_json, year, doi, abstract, source_context, pdf_path, dedup_status, matched_item_id, created_at FROM literature_inbox ORDER BY created_at DESC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let authors_json: String = row.get(2)?;
            Ok(LiteratureCandidate {
                id: row.get(0)?,
                title: row.get(1)?,
                authors: parse_json_vec(&authors_json),
                year: row.get(3)?,
                doi: row.get(4)?,
                abstract_text: row.get(5)?,
                source_context: row.get(6)?,
                pdf_path: row.get(7)?,
                dedup_status: row.get(8)?,
                matched_item_id: row.get(9)?,
                created_at: row.get(10)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

pub fn add_to_inbox(conn: &Connection, candidate: &LiteratureCandidate) -> Result<(), String> {
    let dedup_result = check_dedup(conn, &candidate.doi, &candidate.title, candidate.year)?;
    let (dedup_status, matched_id) = match dedup_result {
        Some(id) => ("duplicate".to_string(), id),
        None => ("unique".to_string(), String::new()),
    };

    conn.execute(
        "INSERT INTO literature_inbox (id, title, authors_json, year, doi, abstract, source_context, pdf_path, dedup_status, matched_item_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            candidate.id,
            candidate.title,
            to_json_vec(&candidate.authors),
            candidate.year,
            candidate.doi,
            candidate.abstract_text,
            candidate.source_context,
            candidate.pdf_path,
            dedup_status,
            matched_id
        ],
    )
    .map_err(|err| err.to_string())?;

    Ok(())
}

/// Approve inbox candidate → move to main library or merge into an existing item.
pub fn approve_candidate(conn: &Connection, inbox_id: &str) -> Result<LiteratureItem, String> {
    let candidate = load_candidate(conn, inbox_id)?;

    let item = if candidate.dedup_status == "duplicate" && !candidate.matched_item_id.is_empty() {
        merge_candidate_into_item(conn, &candidate, &candidate.matched_item_id)?
    } else {
        let item = LiteratureItem {
            id: uuid::Uuid::new_v4().to_string(),
            title: candidate.title.clone(),
            authors: candidate.authors.clone(),
            year: candidate.year,
            journal: String::new(),
            doi: candidate.doi.clone(),
            abstract_text: candidate.abstract_text.clone(),
            tags: Vec::new(),
            notes: String::new(),
            dedup_hash: String::new(),
            linked_task_ids: Vec::new(),
            added_at: String::new(),
            updated_at: String::new(),
        };

        add_item(conn, &item)?;
        if !candidate.pdf_path.trim().is_empty() {
            insert_pdf_attachment(conn, &item.id, &candidate.pdf_path, "manual")?;
        }
        get_item(conn, &item.id)?
    };

    conn.execute(
        "DELETE FROM literature_inbox WHERE id=?1",
        params![inbox_id],
    )
    .map_err(|err| err.to_string())?;

    Ok(item)
}

pub fn search(conn: &Connection, query: &str) -> Result<Vec<LiteratureSearchResult>, String> {
    let tokens = normalized_tokens(query);
    let match_query = build_match_query(query);
    if tokens.is_empty() || match_query.is_empty() {
        return Ok(Vec::new());
    }

    ensure_search_index(conn)?;

    let mut stmt = conn
        .prepare(
            "SELECT li.id, li.title, li.authors_json, li.year, li.journal, li.doi, li.abstract, li.tags_json, li.notes, li.dedup_hash, li.linked_task_ids_json, li.added_at, li.updated_at, literature_fts.title, literature_fts.authors, literature_fts.abstract, literature_fts.chunk_content, literature_fts.notes, bm25(literature_fts) AS score FROM literature_fts JOIN literature_items li ON li.rowid = literature_fts.rowid WHERE literature_fts MATCH ?1 ORDER BY score LIMIT 50",
        )
        .map_err(|err| err.to_string())?;

    let rows = stmt
        .query_map(params![match_query], |row| {
            Ok((
                row_to_item(row)?,
                row.get::<_, String>(13)?,
                row.get::<_, String>(14)?,
                row.get::<_, String>(15)?,
                row.get::<_, String>(16)?,
                row.get::<_, String>(17)?,
                row.get::<_, f64>(18)?,
            ))
        })
        .map_err(|err| err.to_string())?;

    let mut results = Vec::new();
    for row in rows {
        let (item, title_text, authors_text, abstract_text, chunk_text, notes_text, _score) =
            row.map_err(|err| err.to_string())?;

        let match_field = if matches_tokens(&title_text, &tokens) {
            "title"
        } else if matches_tokens(&authors_text, &tokens) {
            "authors"
        } else if matches_tokens(&abstract_text, &tokens) {
            "abstract"
        } else if matches_tokens(&notes_text, &tokens) {
            "notes"
        } else {
            "chunk"
        };

        let mut snippet = match match_field {
            "title" => title_text,
            "authors" => authors_text,
            "abstract" => truncate_preview(&abstract_text, 160),
            "notes" => truncate_preview(&notes_text, 160),
            _ => truncate_preview(&chunk_text, 160),
        };
        let mut chunk_index = None;
        if match_field == "chunk" {
            if let Some((idx, content)) = find_matching_chunk(conn, &item.id, &tokens[0])? {
                chunk_index = Some(idx);
                snippet = truncate_preview(&content, 160);
            }
        }

        results.push(LiteratureSearchResult {
            item,
            match_field: match_field.to_string(),
            snippet,
            chunk_index,
            rank: results.len() as i32,
        });
    }

    Ok(results)
}

pub fn list_attachments(
    conn: &Connection,
    literature_id: &str,
) -> Result<Vec<LiteratureAttachment>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, literature_id, kind, file_path, ocr_status, source, created_at FROM literature_attachments WHERE literature_id=?1",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![literature_id], |row| {
            Ok(LiteratureAttachment {
                id: row.get(0)?,
                literature_id: row.get(1)?,
                kind: row.get(2)?,
                file_path: row.get(3)?,
                ocr_status: row.get(4)?,
                source: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

pub fn upsert_attachment(
    conn: &Connection,
    literature_id: &str,
    kind: &str,
    file_path: &str,
    source: &str,
    ocr_status: &str,
) -> Result<LiteratureAttachment, String> {
    let existing_id: Option<String> = conn
        .query_row(
            "SELECT id FROM literature_attachments WHERE literature_id=?1 AND kind=?2 LIMIT 1",
            params![literature_id, kind],
            |row| row.get(0),
        )
        .ok();

    match existing_id {
        Some(attachment_id) => {
            conn.execute(
                "UPDATE literature_attachments SET file_path=?1, source=?2, ocr_status=?3 WHERE id=?4",
                params![file_path, source, ocr_status, attachment_id],
            )
            .map_err(|err| err.to_string())?;

            conn.query_row(
                "SELECT id, literature_id, kind, file_path, ocr_status, source, created_at FROM literature_attachments WHERE id=?1",
                params![attachment_id],
                |row| {
                    Ok(LiteratureAttachment {
                        id: row.get(0)?,
                        literature_id: row.get(1)?,
                        kind: row.get(2)?,
                        file_path: row.get(3)?,
                        ocr_status: row.get(4)?,
                        source: row.get(5)?,
                        created_at: row.get(6)?,
                    })
                },
            )
            .map_err(|err| err.to_string())
        }
        None => {
            let attachment = LiteratureAttachment {
                id: uuid::Uuid::new_v4().to_string(),
                literature_id: literature_id.to_string(),
                kind: kind.to_string(),
                file_path: file_path.to_string(),
                ocr_status: ocr_status.to_string(),
                source: source.to_string(),
                created_at: String::new(),
            };

            conn.execute(
                "INSERT INTO literature_attachments (id, literature_id, kind, file_path, ocr_status, source) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    attachment.id,
                    attachment.literature_id,
                    attachment.kind,
                    attachment.file_path,
                    attachment.ocr_status,
                    attachment.source
                ],
            )
            .map_err(|err| err.to_string())?;

            Ok(attachment)
        }
    }
}

/// Import a PDF: copy to .viewerleaf/literature/pdfs/, create attachment record.
pub fn import_pdf(
    conn: &Connection,
    literature_id: &str,
    source_path: &Path,
    project_root: &Path,
) -> Result<LiteratureAttachment, String> {
    let (relative_path, absolute_path) = stage_pdf_copy(source_path, project_root, literature_id)?;
    let result = insert_pdf_attachment(conn, literature_id, &relative_path, "manual");
    if result.is_err() {
        let _ = std::fs::remove_file(&absolute_path);
    }
    result
}

/// Save extracted chunks for a literature item, replacing any existing ones.
pub fn save_chunks(
    conn: &Connection,
    literature_id: &str,
    chunks: &[(i32, String)],
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM literature_chunks WHERE literature_id=?1",
        params![literature_id],
    )
    .map_err(|err| err.to_string())?;

    for (index, content) in chunks {
        let chunk_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO literature_chunks (id, literature_id, chunk_index, content) VALUES (?1, ?2, ?3, ?4)",
            params![chunk_id, literature_id, index, content],
        )
        .map_err(|err| err.to_string())?;
    }

    // Re-index to include new chunk content
    index_item(conn, literature_id)?;
    Ok(())
}

/// Update the OCR status on an attachment record.
pub fn update_attachment_ocr_status(
    conn: &Connection,
    attachment_id: &str,
    status: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE literature_attachments SET ocr_status=?1 WHERE id=?2",
        params![status, attachment_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn upsert_sync_state(
    conn: &Connection,
    literature_id: &str,
    zotero_library: &str,
    zotero_key: &str,
    zotero_version: i64,
    sync_direction: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO literature_sync (literature_id, zotero_library, zotero_key, zotero_version, sync_direction, last_synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
         ON CONFLICT(literature_id) DO UPDATE SET
           zotero_library=excluded.zotero_library,
           zotero_key=excluded.zotero_key,
           zotero_version=excluded.zotero_version,
           sync_direction=excluded.sync_direction,
           last_synced_at=datetime('now')",
        params![
            literature_id,
            zotero_library,
            zotero_key,
            zotero_version,
            sync_direction
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// Export literature items as a paper_bank.json projection for the research pipeline.
pub fn export_paper_bank(conn: &Connection) -> Result<serde_json::Value, String> {
    let items = list_items(conn)?;
    let papers: Vec<serde_json::Value> = items
        .iter()
        .map(|item| {
            serde_json::json!({
                "id": item.id,
                "title": item.title,
                "authors": item.authors,
                "year": item.year,
                "journal": item.journal,
                "doi": item.doi,
                "abstract": item.abstract_text,
                "tags": item.tags,
                "linkedTaskIds": item.linked_task_ids,
            })
        })
        .collect();
    Ok(serde_json::json!({ "papers": papers }))
}

/// Get count of literature items linked to a research task.
pub fn count_for_task(conn: &Connection, task_id: &str) -> Result<i64, String> {
    let pattern = format!("%\"{}\"%", task_id);
    conn.query_row(
        "SELECT COUNT(*) FROM literature_items WHERE linked_task_ids_json LIKE ?1",
        params![pattern],
        |row| row.get(0),
    )
    .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(include_str!("../schema.sql"))
            .expect("apply schema");
        conn
    }

    fn make_item(id: &str, title: &str, year: i32, doi: &str, authors: &[&str]) -> LiteratureItem {
        LiteratureItem {
            id: id.into(),
            title: title.into(),
            authors: authors.iter().map(|value| (*value).to_string()).collect(),
            year,
            journal: String::new(),
            doi: doi.into(),
            abstract_text: String::new(),
            tags: Vec::new(),
            notes: String::new(),
            dedup_hash: String::new(),
            linked_task_ids: Vec::new(),
            added_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn approve_duplicate_candidate_reuses_existing_item() {
        let conn = init_conn();
        let existing = make_item("existing", "Paper", 2024, "10.1000/demo", &["Ada"]);
        add_item(&conn, &existing).expect("seed item");

        let candidate = LiteratureCandidate {
            id: "candidate".into(),
            title: "Paper".into(),
            authors: vec!["Ada".into()],
            year: 2024,
            doi: "10.1000/demo".into(),
            abstract_text: "abstract".into(),
            source_context: "ai".into(),
            pdf_path: String::new(),
            dedup_status: "pending".into(),
            matched_item_id: String::new(),
            created_at: String::new(),
        };
        add_to_inbox(&conn, &candidate).expect("seed inbox");

        let approved = approve_candidate(&conn, "candidate").expect("approve candidate");
        let items = list_items(&conn).expect("list items");

        assert_eq!(approved.id, "existing");
        assert_eq!(items.len(), 1);
        assert!(list_inbox(&conn).expect("list inbox").is_empty());
    }

    #[test]
    fn import_pdf_generates_unique_paths_for_same_filename() {
        let conn = init_conn();
        add_item(&conn, &make_item("lit-a", "Paper A", 2024, "", &[])).expect("add item a");
        add_item(&conn, &make_item("lit-b", "Paper B", 2024, "", &[])).expect("add item b");

        let root = std::env::temp_dir().join(format!("viewerleaf-lit-{}", uuid::Uuid::new_v4()));
        let source_a_dir = root.join("source-a");
        let source_b_dir = root.join("source-b");
        std::fs::create_dir_all(&source_a_dir).expect("create source a");
        std::fs::create_dir_all(&source_b_dir).expect("create source b");
        let source_a = source_a_dir.join("paper.pdf");
        let source_b = source_b_dir.join("paper.pdf");
        std::fs::write(&source_a, b"a").expect("write pdf a");
        std::fs::write(&source_b, b"b").expect("write pdf b");

        let att_a = import_pdf(&conn, "lit-a", &source_a, &root).expect("import pdf a");
        let att_b = import_pdf(&conn, "lit-b", &source_b, &root).expect("import pdf b");

        assert_ne!(att_a.file_path, att_b.file_path);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_matches_authors_via_fts_index() {
        let conn = init_conn();
        add_item(
            &conn,
            &make_item(
                "lit-search",
                "Analytical Engine Notes",
                1843,
                "",
                &["Ada Lovelace"],
            ),
        )
        .expect("add search item");

        let results = search(&conn, "Lovelace").expect("search");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].match_field, "authors");
    }
}
