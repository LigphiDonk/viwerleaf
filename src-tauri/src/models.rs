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
    pub api_key: String,
    pub default_model: String,
    pub is_enabled: bool,
    pub sort_order: i32,
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
    pub profile_id: String,
    pub provider: AgentProvider,
    pub system_prompt: String,
    pub tools: Vec<String>,
    pub context: AgentContext,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentProvider {
    pub vendor: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentContext {
    pub project_root: String,
    pub active_file_path: String,
    pub selected_text: String,
    pub full_file_content: String,
    pub cursor_line: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamChunk {
    #[serde(rename = "text_delta")]
    TextDelta { content: String },
    #[serde(rename = "tool_call_start")]
    ToolCallStart {
        tool_id: String,
        args: serde_json::Value,
    },
    #[serde(rename = "tool_call_result")]
    ToolCallResult { tool_id: String, output: String },
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
    Done { usage: UsageInfo },
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
}
