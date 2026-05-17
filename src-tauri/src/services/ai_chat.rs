// OpenAI-compatible chat completion streaming client.
//
// We stream SSE (Server-Sent Events) chunk-by-chunk so the UI can render
// tokens as they arrive instead of waiting for the full body. The endpoint
// returns lines like:
//
//   data: {"choices":[{"delta":{"content":"Hel"}}]}
//   data: {"choices":[{"delta":{"content":"lo"}}]}
//   data: [DONE]
//
// Multiple SSE events can land in the same TCP chunk, and a single event can
// be split across chunks, so we maintain a buffer and split on "\n\n".

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
}

pub async fn stream_chat(
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: Vec<ChatMessage>,
    on_token: impl Fn(&str) + Send + 'static,
    on_done: impl FnOnce() + Send + 'static,
    on_error: impl FnOnce(String) + Send + 'static,
) {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let client = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(e) => {
            on_error(format!("client init: {}", e));
            return;
        }
    };

    let body = ChatRequest { model, messages: &messages, stream: true };

    let resp = match client
        .post(&url)
        .bearer_auth(api_key)
        .header("Accept", "text/event-stream")
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            on_error(format!("network: {}", e));
            return;
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        // Read body to surface useful error context (e.g. invalid key, model).
        let text = resp.text().await.unwrap_or_default();
        on_error(format!("HTTP {}: {}", status, truncate(&text, 400)));
        return;
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                on_error(format!("stream: {}", e));
                return;
            }
        };
        buf.push_str(&String::from_utf8_lossy(&bytes));

        // Process complete SSE events. An event ends at "\n\n"; anything after
        // the last terminator is incomplete and stays in the buffer.
        loop {
            let Some(idx) = buf.find("\n\n") else { break };
            let event: String = buf.drain(..idx + 2).collect();
            for line in event.lines() {
                let line = line.trim_start();
                if !line.starts_with("data:") {
                    continue;
                }
                let data = line["data:".len()..].trim();
                if data == "[DONE]" {
                    on_done();
                    return;
                }
                if data.is_empty() {
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(data) {
                    Ok(v) => {
                        if let Some(content) = v
                            .get("choices")
                            .and_then(|c| c.get(0))
                            .and_then(|c| c.get("delta"))
                            .and_then(|d| d.get("content"))
                            .and_then(|c| c.as_str())
                        {
                            if !content.is_empty() {
                                on_token(content);
                            }
                        }
                    }
                    Err(_) => {
                        // Skip malformed event but don't abort the whole stream.
                        // Some providers emit comments / keep-alives.
                    }
                }
            }
        }
    }

    // Stream ended without an explicit [DONE]. Treat as a clean finish.
    on_done();
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max { s.to_string() } else { format!("{}…", &s[..max]) }
}
