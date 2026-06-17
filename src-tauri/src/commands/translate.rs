use crate::services::translate::{TranslateService, TranslateResult};
use crate::services::{keychain, settings};

#[tauri::command]
pub async fn translate_text(text: String, target_lang: String) -> std::result::Result<TranslateResult, String> {
    let start = std::time::Instant::now();

    // Prefer the user's AI key (works behind VPNs / shared IPs that Google
    // rate-limits). Fall back to Google's free endpoint only if no key is set
    // or the AI call fails.
    let api_key = keychain::get_api_key().unwrap_or_default();
    if !api_key.trim().is_empty() {
        let s = settings::load_cached();
        match TranslateService::translate_ai(&s.ai.base_url, &api_key, &s.ai.model, &text, &target_lang).await {
            Ok(result) => {
                println!("[{:?}] Translate (AI) → {}: {} chars", start.elapsed(), result.target_lang, result.translated.len());
                return Ok(result);
            }
            Err(e) => eprintln!("[translate] AI failed ({}); falling back to Google", e),
        }
    }

    let result = TranslateService::translate(&text, &target_lang)
        .await
        .map_err(|e| e.to_string())?;
    println!("[{:?}] Translate (Google) {} → {}: {} chars", start.elapsed(), result.source_lang, result.target_lang, result.translated.len());
    Ok(result)
}
