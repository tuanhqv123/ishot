use crate::services::ai_chat::{stream_chat, ChatMessage};
use crate::services::{keychain, settings};
use tauri::{AppHandle, Emitter};

/// Hit `{base_url}/models` (OpenAI-compatible spec) and return the model ids.
/// Lets the Settings panel populate a dropdown instead of forcing the user to
/// type the model name. Callers pass an explicit `base_url` + `api_key` rather
/// than reading from settings so they can test arbitrary providers BEFORE
/// saving them.
#[tauri::command]
pub async fn list_ai_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    let trimmed = base_url.trim_end_matches('/');
    let url = format!("{}/models", trimmed);
    let key = if api_key.is_empty() {
        keychain::get_api_key().unwrap_or_default()
    } else {
        api_key
    };

    let client = reqwest::Client::new();
    let mut req = client
        .get(&url)
        .header("Accept", "application/json")
        .header("User-Agent", "iShot/0.1");
    if !key.is_empty() {
        req = req.bearer_auth(key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, body.trim()));
    }

    // OpenAI shape: { "data": [ { "id": "..." }, ... ] }
    // Some providers (Ollama) use a flat array; handle both.
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("parse error: {}", e))?;
    let arr = json
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| json.as_array())
        .ok_or_else(|| "unexpected response shape".to_string())?;
    let mut ids: Vec<String> = arr
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();
    ids.sort();
    Ok(ids)
}

/// Read AI configuration from the persisted Settings file (`services::settings`)
/// and the API key from the macOS Keychain (`services::keychain`). User edits
/// these via the Settings panel.
fn load_ai_config() -> (String, String, String) {
    let s = settings::load_cached();
    let base_url = s.ai.base_url.clone();
    let model = s.ai.model.clone();
    let api_key = keychain::get_api_key().unwrap_or_default();
    (base_url, api_key, model)
}

#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    request_id: String,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    let (base_url, api_key, model) = load_ai_config();
    if api_key.is_empty() {
        let msg = "AI API key not configured. Open Settings to add one.";
        let _ = app.emit(&format!("ai-error:{}", request_id), serde_json::json!({ "message": msg }));
        return Err(msg.to_string());
    }

    let app_for_token = app.clone();
    let token_req = request_id.clone();
    let app_for_done = app.clone();
    let done_req = request_id.clone();
    let app_for_err = app.clone();
    let err_req = request_id.clone();

    // Spawn so the command returns quickly; the long-lived SSE work runs
    // on the tauri async runtime and emits events as tokens arrive.
    tauri::async_runtime::spawn(async move {
        stream_chat(
            &base_url,
            &api_key,
            &model,
            messages,
            move |token| {
                let _ = app_for_token.emit(
                    &format!("ai-token:{}", token_req),
                    serde_json::json!({ "text": token }),
                );
            },
            move || {
                let _ = app_for_done.emit(
                    &format!("ai-done:{}", done_req),
                    serde_json::json!({}),
                );
            },
            move |err| {
                let _ = app_for_err.emit(
                    &format!("ai-error:{}", err_req),
                    serde_json::json!({ "message": err }),
                );
            },
        )
        .await;
    });

    Ok(())
}
