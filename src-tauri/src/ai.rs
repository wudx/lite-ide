//! AI provider chat-completion bridge (OpenAI-compatible endpoints).
//!
//! The webview cannot call provider APIs directly in desktop builds (CORS),
//! so the frontend routes requests through this module. Only the HTTPS scheme
//! is accepted (plus loopback HTTP for local gateways), and provider payloads
//! are proxied verbatim so Z.ai / DeepSeek specifics stay in the frontend.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;

const REQUEST_TIMEOUT_SECS: u64 = 120;
const CHAT_COMPLETIONS_SUFFIX: &str = "/chat/completions";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    /// Provider API root (e.g. `https://api.deepseek.com`); the chat
    /// completions path is appended unless already present.
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub system: Option<String>,
    pub user: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiChatResult {
    pub content: String,
}

/// Loopback hosts may use plain HTTP; the hostname must end at the match
/// (`http://localhost.evil.com` must not pass).
fn starts_with_loopback_host(trimmed: &str, host: &str) -> bool {
    match trimmed.strip_prefix(host) {
        Some(rest) => rest.chars().next().map_or(true, |c| c == ':' || c == '/'),
        None => false,
    }
}

/// Validates the configured base URL and joins the completions path.
pub fn build_chat_url(base_url: &str) -> Result<String, AppError> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::Ai("base URL is empty".into()));
    }
    let allowed = trimmed.starts_with("https://")
        || starts_with_loopback_host(trimmed, "http://localhost")
        || starts_with_loopback_host(trimmed, "http://127.0.0.1");
    if !allowed {
        return Err(AppError::Ai(
            "base URL must use https:// (http://localhost is allowed for local gateways)".into(),
        ));
    }
    if trimmed.ends_with(CHAT_COMPLETIONS_SUFFIX) {
        return Ok(trimmed.to_string());
    }
    Ok(format!("{trimmed}{CHAT_COMPLETIONS_SUFFIX}"))
}

/// Builds the OpenAI-compatible chat completion body (low temperature, no
/// streaming, bounded output — commit messages are short).
pub fn build_chat_body(request: &AiChatRequest) -> Value {
    let mut messages = Vec::new();
    if let Some(system) = request.system.as_deref() {
        let system = system.trim();
        if !system.is_empty() {
            messages.push(serde_json::json!({ "role": "system", "content": system }));
        }
    }
    messages.push(serde_json::json!({ "role": "user", "content": request.user }));
    serde_json::json!({
        "model": request.model,
        "messages": messages,
        "temperature": 0.2,
        "stream": false,
        "max_tokens": 4096,
    })
}

/// Extracts `error.message` / `message` from a provider error payload.
pub fn provider_error_message(payload: &Value) -> Option<String> {
    let record = payload.as_object()?;
    for key in ["error", "message"] {
        match record.get(key) {
            Some(Value::String(text)) if !text.trim().is_empty() => {
                return Some(text.trim().to_string())
            }
            Some(Value::Object(nested)) => {
                if let Some(Value::String(text)) = nested.get("message") {
                    if !text.trim().is_empty() {
                        return Some(text.trim().to_string());
                    }
                }
            }
            _ => {}
        }
    }
    None
}

fn extract_message_text(raw: Option<&Value>) -> Option<String> {
    match raw? {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => {
            let mut texts = Vec::new();
            for p in parts {
                let Some(text) = p.get("text").and_then(Value::as_str) else {
                    continue;
                };
                let ty = p.get("type").and_then(Value::as_str);
                if matches!(ty, None | Some("text") | Some("output_text")) {
                    texts.push(text);
                }
            }
            if texts.is_empty() {
                None
            } else {
                Some(texts.concat())
            }
        }
        _ => None,
    }
}

/// Extracts `choices[0].message.content` from a successful completion payload.
pub fn extract_content(payload: &Value) -> Result<String, AppError> {
    let detail = provider_error_message(payload);
    let missing = |fallback: &str| {
        AppError::Ai(detail.clone().unwrap_or_else(|| fallback.to_string()))
    };
    let choices = payload
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| missing("invalid completion response"))?;
    let first = choices
        .first()
        .ok_or_else(|| missing("completion response has no choices"))?;
    let finish_reason = first.get("finish_reason").and_then(Value::as_str);
    let content = extract_message_text(first.get("message").and_then(|m| m.get("content")));
    match content {
        Some(text) if !text.trim().is_empty() || finish_reason != Some("length") => Ok(text),
        _ if finish_reason == Some("length") => Err(AppError::Ai(
            "completion truncated at max_tokens before producing content (finish_reason=length)"
                .into(),
        )),
        _ => Err(AppError::Ai(
            "completion response has no message content".into(),
        )),
    }
}

pub async fn chat(request: AiChatRequest) -> Result<AiChatResult, AppError> {
    if request.api_key.trim().is_empty() {
        return Err(AppError::Ai("API key is empty".into()));
    }
    if request.model.trim().is_empty() {
        return Err(AppError::Ai("model name is empty".into()));
    }
    let url = build_chat_url(&request.base_url)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| AppError::Ai(format!("failed to create HTTP client: {e}")))?;
    let response = client
        .post(&url)
        .bearer_auth(request.api_key.trim())
        .json(&build_chat_body(&request))
        .send()
        .await
        .map_err(|e| AppError::Ai(format!("request failed: {e}")))?;

    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|e| AppError::Ai(format!("HTTP {status}: invalid response body ({e})")))?;
    if !status.is_success() {
        let detail = provider_error_message(&payload).unwrap_or_else(|| "request rejected".into());
        return Err(AppError::Ai(format!("HTTP {status}: {detail}")));
    }
    Ok(AiChatResult {
        content: extract_content(&payload)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_chat_urls_with_scheme_allowlist() {
        assert_eq!(
            build_chat_url("https://api.deepseek.com").unwrap(),
            "https://api.deepseek.com/chat/completions"
        );
        assert_eq!(
            build_chat_url("https://api.z.ai/api/paas/v4/").unwrap(),
            "https://api.z.ai/api/paas/v4/chat/completions"
        );
        // Already-complete endpoint passes through untouched.
        assert_eq!(
            build_chat_url("https://example.com/v1/chat/completions").unwrap(),
            "https://example.com/v1/chat/completions"
        );
        assert_eq!(
            build_chat_url("http://127.0.0.1:8080/api").unwrap(),
            "http://127.0.0.1:8080/api/chat/completions"
        );
        assert!(build_chat_url("").is_err());
        assert!(build_chat_url("ftp://example.com").is_err());
        assert!(build_chat_url("http://example.com").is_err());
        // Loopback allowlist must not admit suffixed remote hostnames.
        assert!(build_chat_url("http://localhost.evil.com").is_err());
        assert!(build_chat_url("http://127.0.0.1.evil.com").is_err());
        assert!(build_chat_url("http://localhost:8080/v1").is_ok());
    }

    #[test]
    fn builds_body_with_optional_system_message() {
        let request = AiChatRequest {
            base_url: "https://api.deepseek.com".into(),
            api_key: "k".into(),
            model: "deepseek-chat".into(),
            system: Some("be terse".into()),
            user: "hi".into(),
        };
        let body = build_chat_body(&request);
        assert_eq!(body["model"], "deepseek-chat");
        assert_eq!(body["stream"], false);
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["role"], "user");

        let without_system = AiChatRequest {
            system: Some("   ".into()),
            ..request
        };
        let body = build_chat_body(&without_system);
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["role"], "user");
    }

    #[test]
    fn extracts_content_and_provider_errors() {
        let ok = json!({
            "choices": [{ "message": { "role": "assistant", "content": "feat: x" } }]
        });
        assert_eq!(extract_content(&ok).unwrap(), "feat: x");

        let err = json!({ "error": { "message": "bad key" } });
        assert_eq!(extract_content(&err).unwrap_err().to_string(), "ai error: bad key");
        assert_eq!(provider_error_message(&err).as_deref(), Some("bad key"));

        let empty = json!({ "choices": [] });
        assert!(extract_content(&empty).is_err());
        let no_content = json!({ "choices": [{ "message": {} }] });
        assert!(extract_content(&no_content).is_err());

        let truncated = json!({
            "choices": [{
                "finish_reason": "length",
                "message": { "role": "assistant", "content": "" }
            }]
        });
        assert!(extract_content(&truncated)
            .unwrap_err()
            .to_string()
            .contains("finish_reason=length"));

        let parts = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "text": "secret" },
                        { "type": "output_text", "text": "fix: " },
                        { "type": "text", "text": "ok" }
                    ]
                }
            }]
        });
        assert_eq!(extract_content(&parts).unwrap(), "fix: ok");

        let empty_parts = json!({ "choices": [{ "message": { "content": [] } }] });
        assert!(extract_content(&empty_parts).is_err());

        let blank_parts_truncated = json!({
            "choices": [{
                "finish_reason": "length",
                "message": { "content": [{ "type": "text", "text": "  " }] }
            }]
        });
        assert!(extract_content(&blank_parts_truncated)
            .unwrap_err()
            .to_string()
            .contains("finish_reason=length"));
    }
}
