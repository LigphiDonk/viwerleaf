//! WeChat Remote Agent Bridge
//!
//! Implements the ilink HTTP gateway protocol for personal WeChat integration.
//! Allows users to remotely control the local AI agent via WeChat messages.
//!
//! Protocol summary:
//!   - `get_bot_qrcode` → GET request to obtain QR code for WeChat scan login
//!   - `getUpdates` → long-poll for incoming messages
//!   - `sendMessage` → push agent replies back to WeChat

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
    /// Bearer token obtained after QR scan login.
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
    /// Cached context_token for message replies.
    pub context_token: Arc<Mutex<Option<String>>>,
    /// The getUpdates cursor (offset).
    pub update_offset: Arc<Mutex<i64>>,
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
            update_offset: Arc::new(Mutex::new(0)),
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

// ── ilink API helpers ───────────────────────────────────────

/// Request a QR code from the ilink gateway for WeChat scan login.
pub fn request_qr_code(api_url: &str) -> Result<QrCodeInfo, String> {
    let url = format!("{}/ilink/bot/get_bot_qrcode?bot_type=3", api_url.trim_end_matches('/'));
    let agent = make_agent(Duration::from_secs(30));

    let response = agent
        .get(&url)
        .call()
        .map_err(|e| format!("QR code request failed: {e}"))?;

    let response_body: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("Failed to parse QR response: {e}"))?;

    // Extract QR code URL and ticket from the ilink response.
    let qr_url = response_body
        .get("qrcode_img_content")
        .or_else(|| response_body.get("qrcode_url"))
        .or_else(|| response_body.get("url"))
        .and_then(|v: &serde_json::Value| v.as_str())
        .unwrap_or_default()
        .to_string();

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
/// Returns the bearer token on success.
pub fn poll_scan_status(api_url: &str, ticket: &str) -> Result<Option<String>, String> {
    let url = format!(
        "{}/ilink/bot/get_qrcode_status",
        api_url.trim_end_matches('/')
    );
    let agent = make_agent(Duration::from_secs(10));

    let body = serde_json::json!({
        "qrcode": ticket
    });

    let response = agent
        .post(&url)
        .send_json(&body)
        .map_err(|e| format!("Scan status poll failed: {e}"))?;

    let response_body: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("Failed to parse scan status: {e}"))?;

    // Check if login was confirmed
    let errcode = response_body
        .get("errcode")
        .and_then(|v: &serde_json::Value| v.as_i64())
        .unwrap_or(-1);

    if errcode == 0 {
        // Success — extract token
        let token = response_body
            .get("token")
            .or_else(|| response_body.get("access_token"))
            .and_then(|v: &serde_json::Value| v.as_str())
            .map(|s: &str| s.to_string());

        return Ok(token);
    }

    // Still waiting or error
    Ok(None)
}

/// Long-poll for new messages via getUpdates.
pub fn get_updates(
    api_url: &str,
    token: &str,
    offset: i64,
    timeout_ms: u64,
) -> Result<(Vec<WeChatIncomingMessage>, i64), String> {
    let url = format!(
        "{}/ilink/bot/getupdates",
        api_url.trim_end_matches('/')
    );

    let body = serde_json::json!({
        "offset": offset,
        "timeout": timeout_ms / 1000,
    });

    let total_timeout = Duration::from_millis(timeout_ms + 10_000);
    let agent = make_agent(total_timeout);

    let response = agent
        .post(&url)
        .set("Authorization", &format!("Bearer {}", token))
        .send_json(&body)
        .map_err(|e| format!("getUpdates failed: {e}"))?;

    let response_body: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("Failed to parse getUpdates response: {e}"))?;

    let errcode = response_body
        .get("errcode")
        .and_then(|v: &serde_json::Value| v.as_i64())
        .unwrap_or(0);

    if errcode != 0 {
        return Err(format!(
            "getUpdates returned errcode {}: {}",
            errcode,
            response_body
                .get("errmsg")
                .and_then(|v: &serde_json::Value| v.as_str())
                .unwrap_or("unknown error")
        ));
    }

    let mut messages = Vec::new();
    let mut new_offset = offset;

    if let Some(updates) = response_body.get("updates").and_then(|v: &serde_json::Value| v.as_array()) {
        for update in updates {
            let update_id = update
                .get("update_id")
                .and_then(|v: &serde_json::Value| v.as_i64())
                .unwrap_or(0);
            if update_id >= new_offset {
                new_offset = update_id + 1;
            }

            let msg = update.get("message").or_else(|| update.get("msg"));
            if let Some(msg) = msg {
                let from_user = msg
                    .get("from")
                    .and_then(|f: &serde_json::Value| f.get("id").or_else(|| f.get("user_id")))
                    .and_then(|v: &serde_json::Value| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                let content = msg
                    .get("text")
                    .or_else(|| msg.get("content"))
                    .and_then(|v: &serde_json::Value| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                let msg_type = msg
                    .get("type")
                    .or_else(|| msg.get("msg_type"))
                    .and_then(|v: &serde_json::Value| v.as_str())
                    .unwrap_or("text")
                    .to_string();

                let timestamp = msg
                    .get("timestamp")
                    .or_else(|| msg.get("create_time"))
                    .and_then(|v: &serde_json::Value| v.as_u64())
                    .unwrap_or(0);

                let context_token = msg
                    .get("context_token")
                    .and_then(|v: &serde_json::Value| v.as_str())
                    .map(|s: &str| s.to_string());

                if !content.is_empty() {
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
    }

    Ok((messages, new_offset))
}

/// Send a text message back to WeChat via sendMessage.
pub fn send_message(
    api_url: &str,
    token: &str,
    text: &str,
    context_token: Option<&str>,
) -> Result<(), String> {
    let url = format!(
        "{}/ilink/bot/sendmessage",
        api_url.trim_end_matches('/')
    );

    let mut body = serde_json::json!({
        "text": text,
    });

    if let Some(ctx) = context_token {
        body["context_token"] = serde_json::Value::String(ctx.to_string());
    }

    let agent = make_agent(Duration::from_secs(30));
    let response = agent
        .post(&url)
        .set("Authorization", &format!("Bearer {}", token))
        .send_json(&body)
        .map_err(|e| format!("sendMessage failed: {e}"))?;

    let status = response.status();
    if status != 200 {
        let response_body: serde_json::Value = response
            .into_json()
            .unwrap_or(serde_json::Value::Null);
        return Err(format!(
            "sendMessage returned status {}: {}",
            status, response_body
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
        assert!(is_user_allowed("alice@im.wechat,bob@im.wechat", "alice@im.wechat"));
        assert!(is_user_allowed("alice@im.wechat,bob@im.wechat", "bob@im.wechat"));
        assert!(!is_user_allowed("alice@im.wechat,bob@im.wechat", "eve@im.wechat"));
    }

    #[test]
    fn allow_from_trimming() {
        assert!(is_user_allowed(" alice@im.wechat , bob@im.wechat ", "alice@im.wechat"));
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
