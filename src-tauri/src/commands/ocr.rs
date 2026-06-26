use crate::services::ocr::{OcrService, OcrResult};

#[tauri::command]
pub async fn perform_ocr(png_data: Vec<u8>) -> std::result::Result<OcrResult, String> {
    let start = std::time::Instant::now();
    let result = OcrService::recognize_from_png(&png_data)
        .map_err(|e| e.to_string())?;
    let qr = result.blocks.iter().filter(|b| b.kind == "qr").count();
    println!(
        "[{:?}] OCR found {} text blocks, {} QR/barcode(s)",
        start.elapsed(),
        result.blocks.len() - qr,
        qr
    );
    Ok(result)
}
