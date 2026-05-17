use crate::services::ai_chat::{stream_chat, ChatMessage};
use tauri::{AppHandle, Emitter};

// TODO: replace env-var fallback once services::settings + services::keychain
// land. The main settings work will wire those in; for now we read from env so
// the chat feature is testable in isolation.
fn load_ai_config() -> (String, String, String) {
    let base_url = std::env::var("OPENAI_BASE_URL")
        .unwrap_or_else(|_| "https://api.openai.com/v1".to_string());
    let api_key = std::env::var("OPENAI_API_KEY").unwrap_or_default();
    let model = std::env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-4o-mini".to_string());
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
        let msg = "AI API key not configured. Set OPENAI_API_KEY or configure in Settings.";
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
