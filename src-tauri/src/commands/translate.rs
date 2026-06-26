use crate::services::translate::{TranslateResult, TranslateService};
use crate::services::{keychain, settings};

/// Max characters per translation request. Google's free endpoint rejects very
/// long inputs, and a single AI call can hit the model's output cap — so we
/// split long text into chunks (on line boundaries), translate each, and rejoin.
const CHUNK_MAX: usize = 3500;

#[tauri::command]
pub async fn translate_text(
    text: String,
    target_lang: String,
) -> std::result::Result<TranslateResult, String> {
    let start = std::time::Instant::now();

    // Prefer the user's AI key (works behind VPNs / shared IPs that Google
    // rate-limits). Fall back to Google's free endpoint per chunk if no key is
    // set or the AI call fails.
    let api_key = keychain::get_api_key().unwrap_or_default();
    let use_ai = !api_key.trim().is_empty();
    let s = settings::load_cached();

    let chunks = chunk_text(&text, CHUNK_MAX);
    let mut translated = String::new();
    let mut source_lang = "auto".to_string();

    for (i, chunk) in chunks.iter().enumerate() {
        if i > 0 {
            translated.push('\n');
        }
        if chunk.trim().is_empty() {
            translated.push_str(chunk);
            continue;
        }
        let r = if use_ai {
            match TranslateService::translate_ai(
                &s.ai.base_url,
                &api_key,
                &s.ai.model,
                chunk,
                &target_lang,
            )
            .await
            {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[translate] AI failed ({}); falling back to Google", e);
                    TranslateService::translate(chunk, &target_lang)
                        .await
                        .map_err(|e| e.to_string())?
                }
            }
        } else {
            TranslateService::translate(chunk, &target_lang)
                .await
                .map_err(|e| e.to_string())?
        };
        if i == 0 {
            source_lang = r.source_lang.clone();
        }
        translated.push_str(&r.translated);
    }

    println!(
        "[{:?}] Translate ({}) → {}: {} chunk(s), {} chars",
        start.elapsed(),
        if use_ai { "AI" } else { "Google" },
        target_lang,
        chunks.len(),
        translated.len()
    );
    Ok(TranslateResult {
        translated,
        source_lang,
        target_lang,
    })
}

/// Split text into ≤`max`-char chunks on line boundaries (hard-splitting any
/// single line that's longer than `max`, on UTF-8 char boundaries).
fn chunk_text(text: &str, max: usize) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut cur = String::new();
    for line in text.split('\n') {
        if !cur.is_empty() && cur.len() + 1 + line.len() > max {
            chunks.push(std::mem::take(&mut cur));
        }
        if line.len() > max {
            if !cur.is_empty() {
                chunks.push(std::mem::take(&mut cur));
            }
            let bytes = line.as_bytes();
            let mut start = 0;
            while start < line.len() {
                let mut end = (start + max).min(line.len());
                while end < line.len() && (bytes[end] & 0xC0) == 0x80 {
                    end -= 1; // back up to a UTF-8 char boundary
                }
                chunks.push(line[start..end].to_string());
                start = end;
            }
        } else {
            if !cur.is_empty() {
                cur.push('\n');
            }
            cur.push_str(line);
        }
    }
    if !cur.is_empty() {
        chunks.push(cur);
    }
    if chunks.is_empty() {
        chunks.push(String::new());
    }
    chunks
}
