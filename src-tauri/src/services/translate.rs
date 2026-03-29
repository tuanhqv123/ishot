use crate::error::{AppError, Result};
use std::process::Command;

pub struct TranslateService;

impl TranslateService {
    /// Translate text using Google Translate free endpoint.
    /// Auto-detects source language, translates to `target_lang` (e.g. "en", "vi", "ja").
    pub fn translate(text: &str, target_lang: &str) -> Result<TranslateResult> {
        // Use curl to call Google Translate's free API
        let encoded_text = urlencoding(text);
        let url = format!(
            "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl={}&dt=t&q={}",
            target_lang, encoded_text
        );

        let output = Command::new("curl")
            .args(["-s", "-L", &url])
            .output()
            .map_err(|e| AppError::ScreenCapture(format!("curl failed: {}", e)))?;

        if !output.status.success() {
            return Err(AppError::ScreenCapture("Translation request failed".to_string()));
        }

        let body = String::from_utf8_lossy(&output.stdout);
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
