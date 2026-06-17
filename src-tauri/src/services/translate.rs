use crate::error::{AppError, Result};

pub struct TranslateService;

impl TranslateService {
    /// Translate text using Google Translate's free endpoint.
    /// Auto-detects source language, translates to `target_lang` (e.g. "en", "vi", "ja").
    pub async fn translate(text: &str, target_lang: &str) -> Result<TranslateResult> {
        let url = format!(
            "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl={}&dt=t&q={}",
            target_lang,
            urlencoding(text)
        );

        // Use reqwest (rustls) with a browser User-Agent. The previous `curl`
        // call sent NO User-Agent, which Google often answers with an empty
        // body or an HTML block page → "Parse translation response: expected
        // value at line 1 column 1". A UA makes the gtx endpoint reply with the
        // expected JSON array.
        let client = reqwest::Client::builder()
            .user_agent(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
                 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
            )
            .timeout(std::time::Duration::from_secs(12))
            .build()
            .map_err(|e| AppError::ScreenCapture(format!("translation client: {}", e)))?;

        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::ScreenCapture(format!("translation request failed: {}", e)))?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| AppError::ScreenCapture(format!("read translation: {}", e)))?;

        // The gtx endpoint returns a JSON ARRAY. Anything else (empty body,
        // HTML block page, rate-limit notice) means the service didn't answer —
        // surface a readable error instead of a confusing parse failure.
        let trimmed = body.trim_start();
        if trimmed.is_empty() || !trimmed.starts_with('[') {
            return Err(AppError::ScreenCapture(format!(
                "translation unavailable (HTTP {}). Try again in a moment.",
                status.as_u16()
            )));
        }

        // Response is a nested JSON array: [[["translated","original","",""],null,"detected_lang"]]
        let parsed: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| AppError::ScreenCapture(format!("Parse translation response: {}", e)))?;

        let mut translated_text = String::new();
        if let Some(sentences) = parsed.get(0).and_then(|v| v.as_array()) {
            for sentence in sentences {
                if let Some(t) = sentence.get(0).and_then(|v| v.as_str()) {
                    translated_text.push_str(t);
                }
            }
        }

        let detected_lang = parsed.get(2)
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        Ok(TranslateResult {
            translated: translated_text,
            source_lang: detected_lang,
            target_lang: target_lang.to_string(),
        })
    }
}

impl TranslateService {
    /// Translate via the user's own AI key (OpenAI-compatible). Preferred over
    /// the Google free endpoint: it authenticates by key, so it isn't rate-
    /// limited by shared IPs (e.g. Cloudflare WARP exit nodes that Google
    /// answers with HTTP 429), and the quality is higher.
    pub async fn translate_ai(
        base_url: &str,
        api_key: &str,
        model: &str,
        text: &str,
        target_lang: &str,
    ) -> Result<TranslateResult> {
        use crate::services::ai_chat::{complete_chat, ChatMessage};
        let lang = lang_name(target_lang);
        let system = format!(
            "You are a translation engine. Translate the user's text into {}. \
             Output ONLY the translation — no quotes, no explanations, no language \
             labels — and preserve the original line breaks.",
            lang
        );
        let messages = vec![
            ChatMessage { role: "system".into(), content: system },
            ChatMessage { role: "user".into(), content: text.to_string() },
        ];
        let out = complete_chat(base_url, api_key, model, messages)
            .await
            .map_err(|e| AppError::ScreenCapture(format!("AI translate: {}", e)))?;
        Ok(TranslateResult {
            translated: out.trim().to_string(),
            source_lang: "auto".to_string(),
            target_lang: target_lang.to_string(),
        })
    }
}

/// Map a UI language code to an English name for the AI prompt.
fn lang_name(code: &str) -> &'static str {
    match code {
        "en" => "English",
        "vi" => "Vietnamese",
        "zh" => "Simplified Chinese",
        "zh-TW" => "Traditional Chinese",
        "ja" => "Japanese",
        "ko" => "Korean",
        "es" => "Spanish",
        "fr" => "French",
        "de" => "German",
        "ru" => "Russian",
        "th" => "Thai",
        "id" => "Indonesian",
        "pt" => "Portuguese",
        "ar" => "Arabic",
        _ => "English",
    }
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct TranslateResult {
    pub translated: String,
    pub source_lang: String,
    pub target_lang: String,
}

/// Simple URL encoding for query parameters
fn urlencoding(s: &str) -> String {
    let mut result = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(b as char);
            }
            b' ' => result.push_str("%20"),
            _ => result.push_str(&format!("%{:02X}", b)),
        }
    }
    result
}
