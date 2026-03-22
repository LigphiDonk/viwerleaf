CREATE TABLE IF NOT EXISTS providers (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    vendor        TEXT NOT NULL,
    base_url      TEXT NOT NULL,
    api_key       TEXT NOT NULL DEFAULT '',
    default_model TEXT NOT NULL DEFAULT '',
    is_enabled    INTEGER NOT NULL DEFAULT 1,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    meta_json     TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profiles (
    id                   TEXT PRIMARY KEY,
    label                TEXT NOT NULL,
    summary              TEXT NOT NULL DEFAULT '',
    stage                TEXT NOT NULL DEFAULT 'chat',
    provider_id          TEXT NOT NULL DEFAULT '',
    model                TEXT NOT NULL,
    skill_ids_json       TEXT NOT NULL DEFAULT '[]',
    tool_allowlist_json  TEXT NOT NULL DEFAULT '[]',
    output_mode          TEXT NOT NULL DEFAULT 'chat',
    sort_order           INTEGER NOT NULL DEFAULT 0,
    is_builtin           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skills (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    version             TEXT NOT NULL DEFAULT '1.0.0',
    stages_json         TEXT NOT NULL DEFAULT '[]',
    tools_json          TEXT NOT NULL DEFAULT '[]',
    description         TEXT NOT NULL DEFAULT '',
    summary             TEXT NOT NULL DEFAULT '',
    primary_intent      TEXT NOT NULL DEFAULT '',
    intents_json        TEXT NOT NULL DEFAULT '[]',
    capabilities_json   TEXT NOT NULL DEFAULT '[]',
    domains_json        TEXT NOT NULL DEFAULT '[]',
    keywords_json       TEXT NOT NULL DEFAULT '[]',
    source              TEXT NOT NULL CHECK(source IN ('builtin','local','project','git','zip')),
    status              TEXT NOT NULL DEFAULT '',
    upstream_json       TEXT NOT NULL DEFAULT '{}',
    resource_flags_json TEXT NOT NULL DEFAULT '{}',
    dir_path            TEXT NOT NULL DEFAULT '',
    is_enabled          INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    profile_id  TEXT NOT NULL,
    remote_session_id TEXT NOT NULL DEFAULT '',
    project_dir TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
    content     TEXT NOT NULL,
    profile_id  TEXT NOT NULL DEFAULT '',
    tool_id     TEXT NOT NULL DEFAULT '',
    tool_args   TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS usage_logs (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL DEFAULT '',
    provider_id   TEXT NOT NULL DEFAULT '',
    model         TEXT NOT NULL DEFAULT '',
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS figure_briefs (
    id             TEXT PRIMARY KEY,
    source_section TEXT NOT NULL DEFAULT '',
    brief_markdown TEXT NOT NULL DEFAULT '',
    prompt_payload TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','generated')),
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assets (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL DEFAULT 'figure' CHECK(kind IN ('figure','table','diagram')),
    file_path       TEXT NOT NULL,
    source_brief_id TEXT NOT NULL DEFAULT '',
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Literature Management ──

CREATE TABLE IF NOT EXISTS literature_items (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    authors_json   TEXT NOT NULL DEFAULT '[]',
    year           INTEGER NOT NULL DEFAULT 0,
    journal        TEXT NOT NULL DEFAULT '',
    doi            TEXT NOT NULL DEFAULT '',
    abstract       TEXT NOT NULL DEFAULT '',
    tags_json      TEXT NOT NULL DEFAULT '[]',
    notes          TEXT NOT NULL DEFAULT '',
    dedup_hash     TEXT NOT NULL DEFAULT '',
    linked_task_ids_json TEXT NOT NULL DEFAULT '[]',
    added_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS literature_attachments (
    id              TEXT PRIMARY KEY,
    literature_id   TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'pdf' CHECK(kind IN ('pdf','markdown','fulltext')),
    file_path       TEXT NOT NULL DEFAULT '',
    ocr_status      TEXT NOT NULL DEFAULT 'none' CHECK(ocr_status IN ('none','pending','done','failed')),
    source          TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','zotero','ocr')),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (literature_id) REFERENCES literature_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS literature_chunks (
    id              TEXT PRIMARY KEY,
    literature_id   TEXT NOT NULL,
    chunk_index     INTEGER NOT NULL DEFAULT 0,
    content         TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (literature_id) REFERENCES literature_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS literature_sync (
    literature_id   TEXT PRIMARY KEY,
    zotero_library  TEXT NOT NULL DEFAULT '',
    zotero_key      TEXT NOT NULL DEFAULT '',
    zotero_version  INTEGER NOT NULL DEFAULT 0,
    sync_direction  TEXT NOT NULL DEFAULT 'pull' CHECK(sync_direction IN ('pull','push','synced')),
    last_synced_at  TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (literature_id) REFERENCES literature_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS literature_inbox (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL DEFAULT '',
    authors_json   TEXT NOT NULL DEFAULT '[]',
    year           INTEGER NOT NULL DEFAULT 0,
    doi            TEXT NOT NULL DEFAULT '',
    abstract       TEXT NOT NULL DEFAULT '',
    source_context TEXT NOT NULL DEFAULT '',
    pdf_path       TEXT NOT NULL DEFAULT '',
    dedup_status   TEXT NOT NULL DEFAULT 'pending' CHECK(dedup_status IN ('pending','duplicate','unique')),
    matched_item_id TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS literature_fts USING fts5(
    title, authors, abstract, chunk_content, notes,
    tokenize='unicode61'
);
