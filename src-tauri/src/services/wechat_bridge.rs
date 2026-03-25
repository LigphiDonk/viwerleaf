//! WeChat Remote Agent Bridge
//!
//! Implements the ilink HTTP gateway protocol for personal WeChat integration.
//! Allows users to remotely control the local AI agent via WeChat messages.
//!
//! Protocol based on the official iLink Bot API (same as cc-connect / wechatbot SDK):
//!   - `get_bot_qrcode` → GET request to obtain QR code for WeChat scan login
//!   - `get_qrcode_status` → GET request to poll scan status
//!   - `getupdates` → POST long-poll for incoming messages (with `get_updates_buf` cursor)
//!   - `sendmessage` → POST push agent replies back to WeChat (structured `msg` body)

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

// ── Data Types ──────────────────────────────────────────────

/// Persisted WeChat bridge configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeChatConfig {
    /// Bearer token obtained after QR scan login (`bot_token` from iLink).
    pub token: String,
    /// ilink gateway base URL.
    #[serde(default = "default_api_url")]
    pub api_url: String,
    /// Comma-separated list of allowed WeChat user IDs, or "*" for any.
    #[serde(default)]
    pub allow_from: String,
    /// Whether the listener is auto-started on app launch.
    #[serde(default)]
    pub auto_start: bool,
    /// Long-poll timeout in milliseconds.
    #[serde(default = "default_poll_timeout")]
    pub poll_timeout_ms: u64,
}

fn default_api_url() -> String {
    "https://ilinkai.weixin.qq.com".into()
}

fn default_poll_timeout() -> u64 {
    35_000
}

impl Default for WeChatConfig {
    fn default() -> Self {
        Self {
            token: String::new(),
            api_url: default_api_url(),
            allow_from: String::new(),
            auto_start: false,
            poll_timeout_ms: default_poll_timeout(),
        }
    }
}

/// Connection status reported to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeChatStatus {
    /// One of: "disconnected", "scanning", "connected", "error"
    pub state: String,
    /// Human-readable status message.
    pub message: String,
    /// The bound user name (if connected).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bound_user: Option<String>,
}

/// QR code info returned when initiating a scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QrCodeInfo {
    /// URL to the QR code image (or data URI).
    pub qr_url: String,
    /// Unique scan session identifier for polling.
    pub scan_ticket: String,
}

/// A message received from WeChat via getUpdates.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeChatIncomingMessage {
    pub from_user: String,
    pub content: String,
    pub msg_type: String,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_token: Option<String>,
}

/// Runtime state for the WeChat bridge (not persisted).
pub struct WeChatBridgeState {
    /// Whether the listener loop is active.
    pub running: Arc<AtomicBool>,
    /// Current status.
    pub status: Arc<Mutex<WeChatStatus>>,
    /// Cached context_token for message replies (per-user cache).
    pub context_token: Arc<Mutex<Option<String>>>,
    /// The getUpdates cursor (opaque `get_updates_buf` string from iLink).
    pub update_cursor: Arc<Mutex<String>>,
}

impl Default for WeChatBridgeState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            status: Arc::new(Mutex::new(WeChatStatus {
                state: "disconnected".into(),
                message: "Not connected".into(),
                bound_user: None,
            })),
            context_token: Arc::new(Mutex::new(None)),
            update_cursor: Arc::new(Mutex::new(String::new())),
        }
    }
}

// ── Config persistence ──────────────────────────────────────

fn config_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".viewerleaf").join("wechat-bridge.json")
}

pub fn load_wechat_config() -> Result<WeChatConfig, String> {
    let path = config_path();
    match fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str(&json).map_err(|e| e.to_string()),
        Err(_) => Ok(WeChatConfig::default()),
    }
}

pub fn save_wechat_config(config: &WeChatConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(0o600);
        fs::set_permissions(&path, perms).ok();
    }
    Ok(())
}

// ── HTTP agent factory ──────────────────────────────────────

fn make_agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(timeout).build()
}

// ── iLink protocol helpers ──────────────────────────────────

/// Generate a random X-WECHAT-UIN header value.
/// Per protocol: random uint32 → decimal string → base64.
/// We do a simplified manual base64 since we don't want to add a crate dependency.
fn random_wechat_uin() -> String {
    use std::time::SystemTime;
    let seed = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u32;
    let decimal = seed.to_string();
    // Simple base64 encoding for short ASCII strings
    simple_base64(decimal.as_bytes())
}

/// Minimal base64 encoder (standard alphabet, with padding).
fn simple_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Channel version identifier for base_info.
const CHANNEL_VERSION: &str = "viewerleaf/1.0";

// ── ilink API helpers ───────────────────────────────────────

/// Request a QR code from the ilink gateway for WeChat scan login.
/// GET /ilink/bot/get_bot_qrcode?bot_type=3
pub fn request_qr_code(api_url: &str) -> Result<QrCodeInfo, String> {
    let url = format!(
        "{}/ilink/bot/get_bot_qrcode?bot_type=3",
        api_url.trim_end_matches('/')
    );
    let agent = make_agent(Duration::from_secs(30));

    let response = agent
        .get(&url)
        .call()
        .map_err(|e| format!("QR code request failed: {e}"))?;

    let response_body: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("Failed to parse QR response: {e}"))?;

    eprintln!(
        "[WeChat iLink] get_bot_qrcode raw response: {}",
        serde_json::to_string_pretty(&response_body).unwrap_or_default()
    );

    // iLink returns: { "qrcode": "<ticket>", "qrcode_img_content": "<url_or_base64>" }
    let qr_url_raw = response_body
        .get("qrcode_img_content")
        .or_else(|| response_body.get("qrcode_url"))
        .or_else(|| response_body.get("url"))
        .and_then(|v: &serde_json::Value| v.as_str())
        .unwrap_or_default()
        .to_string();

    // If it looks like raw base64 (not a URL or data URI), prepend the
    // data URI prefix so the frontend <img src="..."> can render it.
    let qr_url = if !qr_url_raw.is_empty()
        && !qr_url_raw.starts_with("http")
        && !qr_url_raw.starts_with("data:")
    {
        format!("data:image/png;base64,{}", qr_url_raw)
    } else {
        qr_url_raw
    };

    // "qrcode" field is the ticket used for polling status
    let scan_ticket = response_body
        .get("qrcode")
        .or_else(|| response_body.get("ticket"))
        .and_then(|v: &serde_json::Value| v.as_str())
        .unwrap_or_default()
        .to_string();

    if qr_url.is_empty() {
        return Err(format!(
            "QR code URL not found in response: {}",
            response_body
        ));
    }

    Ok(QrCodeInfo {
        qr_url,
        scan_ticket,
    })
}

/// Poll ilink to check if the QR scan was completed.
/// GET /ilink/bot/get_qrcode_status?qrcode=<ticket>
///
/// Returns (bot_token, optional_new_baseurl) on success.
/// Returns None if still waiting.
pub fn poll_scan_status(api_url: &str, ticket: &str) -> Result<Option<String>, String> {
    let url = format!(
        "{}/ilink/bot/get_qrcode_status?qrcode={}",
        api_url.trim_end_matches('/'),
        ticket
    );
    let agent = make_agent(Duration::from_secs(10));

    let response = agent
        .get(&url)
        .set("iLink-App-ClientVersion", "1")
        .call()
        .map_err(|e| format!("Scan status poll failed: {e}"))?;

    let response_body: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("Failed to parse scan status: {e}"))?;

    eprintln!(
        "[WeChat iLink] get_qrcode_status raw response: {}",
        serde_json::to_string_pretty(&response_body).unwrap_or_default()
    );

    // iLink status machine: "wait" → "scaned" → "confirmed" (or "expired")
    let status = response_body
        .get("status")
        .and_then(|v: &serde_json::Value| v.as_str())
        .unwrap_or("wait");

    match status {
        "confirmed" => {
            // Try each possible token field and log which one we found
            let (token, source) = if let Some(t) = response_body.get("bot_token").and_then(|v| v.as_str()) {
                (Some(t.to_string()), "bot_token")
            } else if let Some(t) = response_body.get("token").and_then(|v| v.as_str()) {
                (Some(t.to_string()), "token")
            } else if let Some(t) = response_body.get("access_token").and_then(|v| v.as_str()) {
                (Some(t.to_string()), "access_token")
            } else {
                (None, "none")
            };

            eprintln!("[WeChat iLink] ✅ Confirmed! Token source field: '{}'", source);
            if let Some(ref t) = token {
                let preview = if t.len() > 40 { format!("{}…", &t[..40]) } else { t.clone() };
                eprintln!("[WeChat iLink]   token value: {}", preview);
            }

            // Log additional useful info
            if let Some(bot_id) = response_body.get("ilink_bot_id").and_then(|v| v.as_str()) {
                eprintln!("[WeChat iLink]   ilink_bot_id: {}", bot_id);
            }
            if let Some(base) = response_body.get("baseurl").and_then(|v| v.as_str()) {
                eprintln!("[WeChat iLink]   baseurl: {}", base);
            }
            if let Some(uid) = response_body.get("ilink_user_id").and_then(|v| v.as_str()) {
                eprintln!("[WeChat iLink]   ilink_user_id: {}", uid);
            }

            Ok(token)
        }
        "expired" => {
            Err("QR code expired, please retry".into())
        }
        // "wait" or "scaned" — still in progress
        _ => Ok(None),
    }
}

/// Long-poll for new messages via getUpdates.
///
/// POST /ilink/bot/getupdates
/// Body: { "get_updates_buf": "<cursor>", "base_info": { "channel_version": "..." } }
///
/// Returns (messages, new_cursor).
pub fn get_updates(
    api_url: &str,
    token: &str,
    cursor: &str,
    timeout_ms: u64,
) -> Result<(Vec<WeChatIncomingMessage>, String), String> {
    let url = format!("{}/ilink/bot/getupdates", api_url.trim_end_matches('/'));

    let body = serde_json::json!({
        "get_updates_buf": cursor,
        "base_info": { "channel_version": CHANNEL_VERSION }
    });

    let total_timeout = Duration::from_millis(timeout_ms + 10_000);
    let agent = make_agent(total_timeout);

    let response = agent
        .post(&url)
        .set("Content-Type", "application/json")
        .set("AuthorizationType", "ilink_bot_token")
        .set("Authorization", &format!("Bearer {}", token))
        .set("X-WECHAT-UIN", &random_wechat_uin())
        .send_json(&body)
        .map_err(|e| format!("getUpdates failed: {e}"))?;

    let response_body: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("Failed to parse getUpdates response: {e}"))?;

    // Log full response for first few calls and whenever messages arrive
    let msg_count = response_body.get("msgs").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    if msg_count > 0 || cursor.is_empty() {
        eprintln!(
            "[WeChat iLink] getUpdates response (msgs={}):\n{}",
            msg_count,
            serde_json::to_string_pretty(&response_body).unwrap_or_default()
        );
    }

    let ret = response_body
        .get("ret")
        .and_then(|v: &serde_json::Value| v.as_i64())
        .unwrap_or(0);

    let errcode = response_body
        .get("errcode")
        .and_then(|v: &serde_json::Value| v.as_i64())
        .unwrap_or(0);

    // errcode -14 means session expired
    if errcode == -14 {
        return Err("Session expired (errcode -14). Please re-scan QR code.".into());
    }

    if ret != 0 {
        let errmsg = response_body
            .get("errmsg")
            .and_then(|v: &serde_json::Value| v.as_str())
            .unwrap_or("unknown error");
        // Log but don't fail for non-zero ret (it may be transient)
        eprintln!(
            "[WeChat iLink] getUpdates ret={}, errcode={}, errmsg={}",
            ret, errcode, errmsg
        );
    }

    // Extract the new cursor
    let new_cursor = response_body
        .get("get_updates_buf")
        .and_then(|v: &serde_json::Value| v.as_str())
        .unwrap_or(cursor)
        .to_string();

    // Parse messages from "msgs" array (iLink format)
    let mut messages = Vec::new();
    if let Some(msgs) = response_body
        .get("msgs")
        .and_then(|v: &serde_json::Value| v.as_array())
    {
        for msg in msgs {
            // Skip bot messages (message_type == 2)
            let message_type = msg
                .get("message_type")
                .and_then(|v: &serde_json::Value| v.as_i64())
                .unwrap_or(0);
            if message_type == 2 {
                continue; // Skip our own bot replies
            }

            let from_user = msg
                .get("from_user_id")
                .and_then(|v: &serde_json::Value| v.as_str())
                .unwrap_or_default()
                .to_string();

            // Extract text content from item_list
            let mut content = String::new();
            if let Some(items) = msg
                .get("item_list")
                .and_then(|v: &serde_json::Value| v.as_array())
            {
                for item in items {
                    let item_type = item
                        .get("type")
                        .and_then(|v: &serde_json::Value| v.as_i64())
                        .unwrap_or(0);

                    match item_type {
                        1 => {
                            // Text item
                            if let Some(text) = item
                                .get("text_item")
                                .and_then(|ti| ti.get("text"))
                                .and_then(|v: &serde_json::Value| v.as_str())
                            {
                                if !content.is_empty() {
                                    content.push('\n');
                                }
                                content.push_str(text);
                            }
                        }
                        3 => {
                            // Voice item — try to get transcribed text
                            if let Some(text) = item
                                .get("voice_item")
                                .and_then(|vi| vi.get("text"))
                                .and_then(|v: &serde_json::Value| v.as_str())
                            {
                                if !text.is_empty() {
                                    if !content.is_empty() {
                                        content.push('\n');
                                    }
                                    content.push_str(text);
                                }
                            }
                        }
                        _ => {
                            // Image (2), File (4), Video (5) — skip for now
                        }
                    }
                }
            }

            // Also check for ref_msg (quoted messages)
            // Fallback: try "text" or "content" fields for simpler formats
            if content.is_empty() {
                if let Some(text) = msg
                    .get("text")
                    .or_else(|| msg.get("content"))
                    .and_then(|v: &serde_json::Value| v.as_str())
                {
                    content = text.to_string();
                }
            }

            let msg_type = match message_type {
                1 => "text",
                _ => "unknown",
            }
            .to_string();

            let timestamp = msg
                .get("create_time_ms")
                .and_then(|v: &serde_json::Value| v.as_u64())
                .unwrap_or(0);

            let context_token = msg
                .get("context_token")
                .and_then(|v: &serde_json::Value| v.as_str())
                .map(|s: &str| s.to_string());

            if !content.is_empty() || context_token.is_some() {
                messages.push(WeChatIncomingMessage {
                    from_user,
                    content,
                    msg_type,
                    timestamp,
                    context_token,
                });
            }
        }
    }

    Ok((messages, new_cursor))
}

/// Send a text message back to WeChat via sendMessage.
///
/// POST /ilink/bot/sendmessage
/// Body: { "msg": { ... structured message ... }, "base_info": { ... } }
pub fn send_message(
    api_url: &str,
    token: &str,
    text: &str,
    context_token: Option<&str>,
) -> Result<(), String> {
    let url = format!("{}/ilink/bot/sendmessage", api_url.trim_end_matches('/'));

    // Generate a random client_id for deduplication
    let client_id = format!("vl-{}", uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("0000"));

    let ctx = context_token.unwrap_or_default();
    if ctx.is_empty() {
        return Err("Cannot send message: no context_token available. User must message the bot first.".into());
    }

    let body = serde_json::json!({
        "msg": {
            "from_user_id": "",
            "to_user_id": "",
            "client_id": client_id,
            "message_type": 2,       // 2 = bot message
            "message_state": 2,      // 2 = finished
            "item_list": [
                {
                    "type": 1,       // 1 = text
                    "text_item": {
                        "text": text
                    }
                }
            ],
            "context_token": ctx
        },
        "base_info": {
            "channel_version": CHANNEL_VERSION
        }
    });

    let agent = make_agent(Duration::from_secs(30));
    let response = agent
        .post(&url)
        .set("Content-Type", "application/json")
        .set("AuthorizationType", "ilink_bot_token")
        .set("Authorization", &format!("Bearer {}", token))
        .set("X-WECHAT-UIN", &random_wechat_uin())
        .send_json(&body)
        .map_err(|e| format!("sendMessage failed: {e}"))?;

    let status = response.status();
    let response_body: serde_json::Value = response
        .into_json()
        .unwrap_or(serde_json::Value::Null);

    let ret = response_body
        .get("ret")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    if status != 200 || ret != 0 {
        let errmsg = response_body
            .get("errmsg")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        return Err(format!(
            "sendMessage failed: http={}, ret={}, errmsg={}",
            status, ret, errmsg
        ));
    }

    Ok(())
}

// ── allow_from check ────────────────────────────────────────

/// Check if a user ID is allowed by the allow_from whitelist.
pub fn is_user_allowed(allow_from: &str, user_id: &str) -> bool {
    let trimmed = allow_from.trim();
    if trimmed.is_empty() || trimmed == "*" {
        return true;
    }
    trimmed
        .split(',')
        .any(|allowed| allowed.trim().eq_ignore_ascii_case(user_id))
}

// ── Unit tests ──────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_from_wildcard() {
        assert!(is_user_allowed("*", "anyone"));
        assert!(is_user_allowed("", "anyone"));
        assert!(is_user_allowed("  ", "anyone"));
    }

    #[test]
    fn allow_from_whitelist() {
        assert!(is_user_allowed(
            "alice@im.wechat,bob@im.wechat",
            "alice@im.wechat"
        ));
        assert!(is_user_allowed(
            "alice@im.wechat,bob@im.wechat",
            "bob@im.wechat"
        ));
        assert!(!is_user_allowed(
            "alice@im.wechat,bob@im.wechat",
            "eve@im.wechat"
        ));
    }

    #[test]
    fn allow_from_trimming() {
        assert!(is_user_allowed(
            " alice@im.wechat , bob@im.wechat ",
            "alice@im.wechat"
        ));
    }

    #[test]
    fn default_config_values() {
        let config = WeChatConfig::default();
        assert_eq!(config.api_url, "https://ilinkai.weixin.qq.com");
        assert_eq!(config.poll_timeout_ms, 35_000);
        assert!(config.token.is_empty());
        assert!(!config.auto_start);
    }

    #[test]
    fn config_serialization_roundtrip() {
        let config = WeChatConfig {
            token: "test-token".into(),
            api_url: "https://example.com".into(),
            allow_from: "user1,user2".into(),
            auto_start: true,
            poll_timeout_ms: 30_000,
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: WeChatConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.token, "test-token");
        assert_eq!(parsed.allow_from, "user1,user2");
        assert!(parsed.auto_start);
    }
}
