use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub root_path: String,
    pub main_tex: String,
    pub engine: String,
    pub bib_tool: String,
    pub auto_compile: bool,
    pub forward_sync: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub path: String,
    pub language: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNode {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: String,
    pub file_type: Option<String>,
    pub is_text: Option<bool>,
    pub is_previewable: Option<bool>,
    pub size: Option<u64>,
    pub children: Option<Vec<ProjectNode>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    pub default_model: String,
    pub is_enabled: bool,
    pub sort_order: i32,
    #[serde(default)]
    pub meta_json: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProfileConfig {
    pub id: String,
    pub label: String,
    pub summary: String,
    pub stage: String,
    pub provider_id: String,
    pub model: String,
    pub skill_ids: Vec<String>,
    pub tool_allowlist: Vec<String>,
    pub output_mode: String,
    pub sort_order: i32,
    pub is_builtin: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub stages: Vec<String>,
    pub tools: Vec<String>,
    pub source: String,
    pub dir_path: String,
    pub is_enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub profile_id: String,
    pub tool_id: String,
    pub tool_args: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSummary {
    pub id: String,
    pub profile_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: i64,
    pub last_message_preview: String,
}



#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentSuggestedPatch {
    pub file_path: String,
    pub content: String,
    pub summary: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunResult {
    pub session_id: Option<String>,
    pub message: Option<AgentMessage>,
    pub suggested_patch: Option<AgentSuggestedPatch>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    pub status: String,
    pub pdf_path: Option<String>,
    pub synctex_path: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
    pub log_path: String,
    pub log_output: String,
    pub timestamp: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompileEnvironmentStatus {
    pub ready: bool,
    pub latexmk_available: bool,
    pub synctex_available: bool,
    pub available_engines: Vec<String>,
    pub missing_tools: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub file_path: String,
    pub line: usize,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncHighlight {
    pub page: usize,
    pub h: f64,
    pub v: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncLocation {
    pub file_path: String,
    pub line: usize,
    pub column: usize,
    pub page: usize,
    pub highlights: Vec<SyncHighlight>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AssetResource {
    pub path: String,
    pub absolute_path: String,
    pub resource_url: Option<String>,
    pub data: Option<Vec<u8>>,
    pub mime_type: String,
    pub size: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FigureBriefDraft {
    pub id: String,
    pub source_section_ref: String,
    pub brief_markdown: String,
    pub prompt_payload: String,
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedAsset {
    pub id: String,
    pub kind: String,
    pub file_path: String,
    pub source_brief_id: String,
    pub metadata: serde_json::Value,
    pub preview_uri: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub id: String,
    pub session_id: String,
    pub provider_id: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub success: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequest {
    pub session_id: String,
    pub remote_session_id: Option<String>,
    pub profile_id: String,
    pub provider: AgentProvider,
    #[serde(default)]
    pub system_prompt: String,
    pub user_message: String,
    pub context: AgentContext,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentProvider {
    pub vendor: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub permission_mode: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentContext {
    pub project_root: String,
    pub active_file_path: String,
    pub selected_text: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CliAgentStatus {
    pub name: String,
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StreamChunk {
    #[serde(rename = "thinking_delta")]
    ThinkingDelta { content: String },
    #[serde(rename = "thinking_clear")]
    ThinkingClear,
    #[serde(rename = "thinking_commit")]
    ThinkingCommit,
    #[serde(rename = "text_delta")]
    TextDelta { content: String },
    #[serde(rename = "tool_call_start")]
    ToolCallStart {
        tool_id: String,
        args: serde_json::Value,
    },
    #[serde(rename = "tool_call_result")]
    ToolCallResult {
        tool_id: String,
        output: String,
        status: Option<String>,
    },
    #[serde(rename = "patch")]
    Patch {
        file_path: String,
        start_line: u32,
        end_line: u32,
        new_content: String,
    },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "done")]
    Done {
        usage: UsageInfo,
        remote_session_id: Option<String>,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageInfo {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub model: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub session_id: String,
    pub cwd: String,
    pub shell: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    #[serde(rename = "output")]
    Output { session_id: String, data: String },
    #[serde(rename = "exit")]
    Exit {
        session_id: String,
        exit_code: Option<u32>,
        signal: Option<String>,
    },
    #[serde(rename = "error")]
    Error { session_id: String, message: String },
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResearchBootstrapState {
    pub status: String,
    pub message: String,
    pub has_instance: bool,
    pub has_templates: bool,
    pub has_skill_views: bool,
    pub has_brief: bool,
    pub has_tasks: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResearchTask {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub priority: String,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub task_type: String,
    #[serde(default)]
    pub inputs_needed: Vec<String>,
    #[serde(default)]
    pub suggested_skills: Vec<String>,
    #[serde(default)]
    pub next_action_prompt: String,
    #[serde(default)]
    pub artifact_paths: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResearchTaskCounts {
    pub total: usize,
    pub pending: usize,
    pub in_progress: usize,
    pub done: usize,
    pub review: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResearchStageSummary {
    pub stage: String,
    pub label: String,
    pub description: String,
    pub status: String,
    pub total_tasks: usize,
    pub done_tasks: usize,
    pub artifact_count: usize,
    pub artifact_paths: Vec<String>,
    pub missing_inputs: Vec<String>,
    pub suggested_skills: Vec<String>,
    pub next_task_id: Option<String>,
    pub task_counts: ResearchTaskCounts,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResearchCanvasSnapshot {
    pub bootstrap: ResearchBootstrapState,
    pub brief: Option<serde_json::Value>,
    pub tasks: Vec<ResearchTask>,
    pub current_stage: String,
    pub next_task: Option<ResearchTask>,
    pub stage_summaries: Vec<ResearchStageSummary>,
    pub artifact_paths: HashMap<String, Vec<String>>,
    pub handoff_to_writing: bool,
    pub pipeline_root: String,
    pub instance_path: Option<String>,
    pub brief_topic: String,
    pub brief_goal: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub project_config: ProjectConfig,
    pub tree: Vec<ProjectNode>,
    pub files: Vec<ProjectFile>,
    pub active_file: String,
    pub providers: Vec<ProviderConfig>,
    pub skills: Vec<SkillManifest>,
    pub profiles: Vec<ProfileConfig>,
    pub compile_result: CompileResult,
    pub figure_briefs: Vec<FigureBriefDraft>,
    pub assets: Vec<GeneratedAsset>,
    pub research: Option<ResearchCanvasSnapshot>,
}
