use crate::error::{AppError, Result};
use std::process::Command;
use std::sync::Once;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextBlock {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrResult {
    pub blocks: Vec<TextBlock>,
    pub full_text: String,
}

static COMPILE_ONCE: Once = Once::new();
const OCR_BINARY: &str = "/tmp/ishot_ocr_v3";
const OCR_SWIFT: &str = "/tmp/ishot_ocr_v3.swift";

pub struct OcrService;

impl OcrService {
    /// Compile Swift OCR binary once
    fn ensure_binary() -> Result<()> {
        let mut compile_error: Option<String> = None;
        
        COMPILE_ONCE.call_once(|| {
            // Remove old binary to force recompile with new languages
            let _ = std::fs::remove_file(OCR_BINARY);
            let _ = std::fs::remove_file(OCR_SWIFT);
            
            let swift_code = r#"
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else { print("[]"); exit(0) }

let imagePath = args[1]
guard let image = NSImage(contentsOfFile: imagePath),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("[]"); exit(0)
}

let imageHeight = Double(cgImage.height)
let imageWidth = Double(cgImage.width)
var results: [[String: Any]] = []

let request = VNRecognizeTextRequest { request, error in
    guard let observations = request.results as? [VNRecognizedTextObservation] else { return }
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let box = observation.boundingBox
        results.append([
            "text": candidate.string,
            "x": box.origin.x * imageWidth,
            "y": (1 - box.origin.y - box.height) * imageHeight,
            "width": box.width * imageWidth,
            "height": box.height * imageHeight,
            "confidence": Double(candidate.confidence)
        ])
    }
}

request.recognitionLevel = .accurate
request.automaticallyDetectsLanguage = true
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try? handler.perform([request])

if let jsonData = try? JSONSerialization.data(withJSONObject: results),
   let jsonString = String(data: jsonData, encoding: .utf8) {
    print(jsonString)
} else { print("[]") }
"#;
            // Write and compile
            if let Err(e) = std::fs::write(OCR_SWIFT, swift_code) {
                compile_error = Some(format!("Write failed: {}", e));
                return;
            }
            
            let output = Command::new("swiftc")
                .args(["-O", "-o", OCR_BINARY, OCR_SWIFT])
                .output();
            
            match output {
                Ok(o) if !o.status.success() => {
                    compile_error = Some(format!("Compile failed: {}", String::from_utf8_lossy(&o.stderr)));
                }
                Err(e) => {
                    compile_error = Some(format!("swiftc failed: {}", e));
                }
                _ => {
                    println!("[OCR] Binary compiled");
                }
            }
        });
        
        if let Some(e) = compile_error {
            return Err(AppError::OcrError(e));
        }
        
        // Check binary exists
        if !std::path::Path::new(OCR_BINARY).exists() {
            return Err(AppError::OcrError("OCR binary not found".into()));
        }
        
        Ok(())
    }

    /// Perform OCR on image using macOS Vision framework
    pub fn recognize_text(image_path: &str) -> Result<OcrResult> {
        Self::ensure_binary()?;
        
        let output = Command::new(OCR_BINARY)
            .arg(image_path)
            .output()
            .map_err(|e| AppError::OcrError(format!("OCR failed: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::OcrError(format!("OCR failed: {}", stderr)));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let blocks: Vec<TextBlock> = serde_json::from_str(stdout.trim())
            .unwrap_or_default();

        let full_text = blocks.iter()
            .map(|b| b.text.clone())
            .collect::<Vec<_>>()
            .join("\n");

        Ok(OcrResult { blocks, full_text })
    }

    /// OCR from PNG bytes
    pub fn recognize_from_png(png_data: &[u8]) -> Result<OcrResult> {
        let temp_path = "/tmp/ishot_ocr_input.png";
        std::fs::write(temp_path, png_data)
            .map_err(|e| AppError::OcrError(format!("Failed to write image: {}", e)))?;
        
        let result = Self::recognize_text(temp_path);
        let _ = std::fs::remove_file(temp_path);
        result
    }
}
