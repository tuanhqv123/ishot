use crate::services::ocr::{OcrService, OcrResult};

/// OCR a PNG passed as the invoke RAW body (Tauri v2 transfers Uint8Array as
/// binary — no `Array.from` / JSON serialization of millions of numbers).
#[tauri::command]
pub async fn perform_ocr(
    request: tauri::ipc::Request<'_>,
) -> std::result::Result<OcrResult, String> {
    let start = std::time::Instant::now();
    let png_data: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.as_slice(),
        _ => return Err("perform_ocr expects raw PNG bytes".into()),
    };
    let result = OcrService::recognize_from_png(png_data)
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
