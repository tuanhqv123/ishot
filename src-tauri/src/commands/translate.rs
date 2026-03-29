use crate::services::translate::{TranslateService, TranslateResult};

#[tauri::command]
pub async fn translate_text(text: String, target_lang: String) -> std::result::Result<TranslateResult, String> {
    let start = std::time::Instant::now();
    let result = TranslateService::translate(&text, &target_lang)
        .map_err(|e| e.to_string())?;
    println!("[{:?}] Translate {} → {}: {} chars", start.elapsed(), result.source_lang, result.target_lang, result.translated.len());
    Ok(result)
}
