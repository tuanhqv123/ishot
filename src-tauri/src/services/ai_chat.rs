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

/// Non-streaming chat completion — returns the full assistant message. Used by
/// features that just need the final text (e.g. translation), not token-by-token.
pub async fn complete_chat(
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("client init: {}", e))?;
    let body = ChatRequest { model, messages: &messages, stream: false };
    let resp = client
        .post(&url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("network: {}", e))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, truncate(&text, 300)));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("decode: {}", e))?;
    let content = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    Ok(content)
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
    // Raw byte buffer for incomplete UTF-8 at chunk boundaries. A multi-byte
    // char (Vietnamese diacritics, CJK, emoji…) can be split across two TCP
    // chunks; decoding each chunk independently with from_utf8_lossy turns the
    // split halves into `�`. We instead accumulate bytes and only move the
    // VALID UTF-8 prefix into `buf`, holding any trailing partial char back.
    let mut byte_buf: Vec<u8> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                on_error(format!("stream: {}", e));
                return;
            }
        };
        byte_buf.extend_from_slice(&bytes);
        drain_valid_utf8(&mut byte_buf, &mut buf);

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

/// Move every COMPLETE UTF-8 char from `byte_buf` into `out`, leaving any
/// trailing incomplete multi-byte char in `byte_buf` for the next chunk.
/// Genuinely invalid bytes are dropped (lossy) so a bad byte can't wedge it.
fn drain_valid_utf8(byte_buf: &mut Vec<u8>, out: &mut String) {
    loop {
        match std::str::from_utf8(byte_buf) {
            Ok(s) => {
                out.push_str(s);
                byte_buf.clear();
                return;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                if valid > 0 {
                    // SAFETY: bytes [..valid] are valid UTF-8 per from_utf8.
                    out.push_str(unsafe {
                        std::str::from_utf8_unchecked(&byte_buf[..valid])
                    });
                }
                match e.error_len() {
                    // Incomplete trailing char — keep the tail for next chunk.
                    None => {
                        byte_buf.drain(..valid);
                        return;
                    }
                    // Genuinely invalid bytes — drop them and keep going.
                    Some(bad) => {
                        byte_buf.drain(..valid + bad);
                    }
                }
            }
        }
    }
}

fn truncate(s: &str, max: usize) -> String {
    // Count/cut by CHARS, not bytes — slicing `&s[..max]` panics if `max`
    // lands inside a multi-byte char (e.g. an error message in Vietnamese).
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{}…", cut)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Vietnamese text whose multi-byte chars get split at every byte
    /// boundary must still reassemble perfectly — this is the streaming bug
    /// that turned diacritics into `�`.
    #[test]
    fn drain_utf8_reassembles_split_vietnamese() {
        let text = "Tiếng Việt: chào bạn, hôm nay thế nào? 日本語 🎉";
        let bytes = text.as_bytes();
        let mut byte_buf = Vec::new();
        let mut out = String::new();
        // Feed ONE byte at a time — the worst-case chunk boundary.
        for &b in bytes {
            byte_buf.push(b);
            drain_valid_utf8(&mut byte_buf, &mut out);
        }
        assert!(byte_buf.is_empty(), "no trailing bytes should remain");
        assert_eq!(out, text);
    }

    #[test]
    fn drain_utf8_holds_incomplete_tail() {
        // "ế" is 3 bytes (E1 BA BF). After 2 bytes nothing should emit yet.
        let full = "ế".as_bytes();
        let mut byte_buf = full[..2].to_vec();
        let mut out = String::new();
        drain_valid_utf8(&mut byte_buf, &mut out);
        assert_eq!(out, "");
        assert_eq!(byte_buf.len(), 2);
        // Completing the char emits it and empties the buffer.
        byte_buf.push(full[2]);
        drain_valid_utf8(&mut byte_buf, &mut out);
        assert_eq!(out, "ế");
        assert!(byte_buf.is_empty());
    }

    #[test]
    fn truncate_is_char_safe() {
        // Cutting Vietnamese mid-string must not panic on a byte boundary.
        let s = "Lỗi mạng khi kết nối đến máy chủ";
        let t = truncate(s, 5);
        assert!(t.ends_with('…'));
        assert_eq!(t.chars().count(), 6); // 5 chars + ellipsis
    }
}
