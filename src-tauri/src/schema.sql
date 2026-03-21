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
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    version     TEXT NOT NULL DEFAULT '1.0.0',
    stages_json TEXT NOT NULL DEFAULT '[]',
    tools_json  TEXT NOT NULL DEFAULT '[]',
    source      TEXT NOT NULL CHECK(source IN ('builtin','local','project','git')),
    dir_path    TEXT NOT NULL DEFAULT '',
    is_enabled  INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
