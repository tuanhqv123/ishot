use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};

// Vision.framework must be linked into the process for class!(VNRecognizeTextRequest)
// to resolve at runtime. AppKit/Foundation are already linked via cocoa/tauri.
#[link(name = "Vision", kind = "framework")]
extern "C" {}

fn default_text() -> String {
    "text".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextBlock {
    /// Discriminator: "text" for OCR text, "qr" for decoded barcodes/QR codes.
    #[serde(default = "default_text")]
    pub kind: String,
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

pub struct OcrService;

impl OcrService {
    /// OCR PNG bytes via the macOS Vision framework, called in-process.
    ///
    /// Previous implementation compiled an embedded Swift helper with `swiftc`
    /// at runtime — that requires working Command Line Tools on the END USER's
    /// machine and breaks whenever the SDK/toolchain versions drift apart.
    /// Calling VNRecognizeTextRequest through the ObjC runtime has no such
    /// external dependency.
    pub fn recognize_from_png(png_data: &[u8]) -> Result<OcrResult> {
        // Vision reports bounding boxes normalized to [0,1] with a bottom-left
        // origin. Read the PNG header for pixel dimensions so we can map them
        // to top-left pixel coordinates (what the frontend expects).
        let decoder = png::Decoder::new(std::io::Cursor::new(png_data));
        let reader = decoder
            .read_info()
            .map_err(|e| AppError::OcrError(format!("Invalid PNG: {}", e)))?;
        let info = reader.info();
        let (img_w, img_h) = (info.width as f64, info.height as f64);

        let blocks = unsafe { Self::recognize_with_vision(png_data, img_w, img_h)? };

        // QR payloads are surfaced only via `blocks` — keep `full_text` to OCR
        // text so translate/AI seeding doesn't ingest barcode URLs.
        let full_text = blocks
            .iter()
            .filter(|b| b.kind != "qr")
            .map(|b| b.text.clone())
            .collect::<Vec<_>>()
            .join("\n");

        Ok(OcrResult { blocks, full_text })
    }

    unsafe fn recognize_with_vision(
        png_data: &[u8],
        img_w: f64,
        img_h: f64,
    ) -> Result<Vec<TextBlock>> {
        use cocoa::base::{id, nil};
        use cocoa::foundation::NSRect;
        use objc::rc::autoreleasepool;
        use objc::runtime::{BOOL, NO, YES};
        use objc::{class, msg_send, sel, sel_impl};
        use std::ffi::CStr;
        use std::os::raw::{c_char, c_void};

        autoreleasepool(|| {
            let ns_data: id = msg_send![
                class!(NSData),
                dataWithBytes: png_data.as_ptr() as *const c_void
                length: png_data.len()
            ];
            if ns_data == nil {
                return Err(AppError::OcrError("NSData creation failed".into()));
            }

            let request: id = msg_send![class!(VNRecognizeTextRequest), alloc];
            let request: id = msg_send![request, init];
            if request == nil {
                return Err(AppError::OcrError(
                    "VNRecognizeTextRequest unavailable".into(),
                ));
            }
            // VNRequestTextRecognitionLevelAccurate = 0
            let _: () = msg_send![request, setRecognitionLevel: 0i64];
            let _: () = msg_send![request, setUsesLanguageCorrection: YES];
            // macOS 13+ only — feature-detect instead of hard-calling.
            let responds: BOOL = msg_send![
                request,
                respondsToSelector: sel!(setAutomaticallyDetectsLanguage:)
            ];
            if responds != NO {
                let _: () = msg_send![request, setAutomaticallyDetectsLanguage: YES];
            }

            // QR/barcode detection runs in the SAME Vision pass (one image
            // decode). A nil request here must never fail OCR — we just skip
            // barcode collection below.
            let barcode_request: id = msg_send![class!(VNDetectBarcodesRequest), alloc];
            let barcode_request: id = msg_send![barcode_request, init];

            let options: id = msg_send![class!(NSDictionary), dictionary];
            let handler: id = msg_send![class!(VNImageRequestHandler), alloc];
            let handler: id = msg_send![handler, initWithData: ns_data options: options];
            if handler == nil {
                let _: () = msg_send![request, release];
                if barcode_request != nil {
                    let _: () = msg_send![barcode_request, release];
                }
                return Err(AppError::OcrError(
                    "VNImageRequestHandler creation failed".into(),
                ));
            }

            // Build the request array: always the text request, plus the
            // barcode request when it allocated successfully. (Variadic
            // `arrayWithObjects:` isn't expressible via msg_send!, so build a
            // mutable array and addObject: each.)
            let requests: id = msg_send![class!(NSMutableArray), array];
            let _: () = msg_send![requests, addObject: request];
            if barcode_request != nil {
                let _: () = msg_send![requests, addObject: barcode_request];
            }
            let mut error: id = nil;
            let ok: BOOL = msg_send![handler, performRequests: requests error: &mut error];

            let result = if ok == NO {
                let msg = if error != nil {
                    let desc: id = msg_send![error, localizedDescription];
                    let cstr: *const c_char = msg_send![desc, UTF8String];
                    if cstr.is_null() {
                        "unknown Vision error".to_string()
                    } else {
                        CStr::from_ptr(cstr).to_string_lossy().into_owned()
                    }
                } else {
                    "unknown Vision error".to_string()
                };
                Err(AppError::OcrError(format!("Vision OCR failed: {}", msg)))
            } else {
                let observations: id = msg_send![request, results];
                let count: usize = if observations == nil {
                    0
                } else {
                    msg_send![observations, count]
                };
                let mut blocks = Vec::with_capacity(count);
                for i in 0..count {
                    let obs: id = msg_send![observations, objectAtIndex: i];
                    let candidates: id = msg_send![obs, topCandidates: 1usize];
                    let ccount: usize = msg_send![candidates, count];
                    if ccount == 0 {
                        continue;
                    }
                    let cand: id = msg_send![candidates, objectAtIndex: 0usize];
                    let ns_text: id = msg_send![cand, string];
                    let cstr: *const c_char = msg_send![ns_text, UTF8String];
                    if cstr.is_null() {
                        continue;
                    }
                    let text = CStr::from_ptr(cstr).to_string_lossy().into_owned();
                    let confidence: f32 = msg_send![cand, confidence];
                    let bbox: NSRect = msg_send![obs, boundingBox];
                    blocks.push(TextBlock {
                        kind: "text".to_string(),
                        text,
                        x: bbox.origin.x * img_w,
                        y: (1.0 - bbox.origin.y - bbox.size.height) * img_h,
                        width: bbox.size.width * img_w,
                        height: bbox.size.height * img_h,
                        confidence: confidence as f64,
                    });
                }

                // Collect decoded QR/barcodes from the barcode request. Entirely
                // defensive: nil request / nil results / nil payloads yield no
                // blocks and never fail OCR. Payloads flow only via `blocks`
                // (NOT `full_text`) so translate/AI seeding is unaffected.
                if barcode_request != nil {
                    let bc_results: id = msg_send![barcode_request, results];
                    let bc_count: usize = if bc_results == nil {
                        0
                    } else {
                        msg_send![bc_results, count]
                    };
                    for i in 0..bc_count {
                        let obs: id = msg_send![bc_results, objectAtIndex: i];
                        if obs == nil {
                            continue;
                        }
                        let payload: id = msg_send![obs, payloadStringValue];
                        if payload == nil {
                            continue;
                        }
                        let cstr: *const c_char = msg_send![payload, UTF8String];
                        if cstr.is_null() {
                            continue;
                        }
                        let text = CStr::from_ptr(cstr).to_string_lossy().into_owned();
                        let bbox: NSRect = msg_send![obs, boundingBox];
                        blocks.push(TextBlock {
                            kind: "qr".to_string(),
                            text,
                            x: bbox.origin.x * img_w,
                            y: (1.0 - bbox.origin.y - bbox.size.height) * img_h,
                            width: bbox.size.width * img_w,
                            height: bbox.size.height * img_h,
                            confidence: 1.0,
                        });
                    }
                }

                Ok(blocks)
            };

            let _: () = msg_send![handler, release];
            let _: () = msg_send![request, release];
            if barcode_request != nil {
                let _: () = msg_send![barcode_request, release];
            }
            result
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test against a fixture rendered by `osascript` (white canvas,
    /// black "Hello iShot OCR 12345" at 28pt). Skips when the fixture is
    /// absent so CI without the file still passes.
    #[test]
    fn vision_ocr_reads_rendered_text() {
        let Ok(png) = std::fs::read("/tmp/ishot_ocr_test.png") else {
            eprintln!("fixture missing — skipping");
            return;
        };
        let result = OcrService::recognize_from_png(&png).expect("OCR should succeed");
        assert!(
            !result.blocks.is_empty(),
            "expected at least one text block"
        );
        let joined = result.full_text.replace(' ', "");
        assert!(
            joined.contains("iShot") && joined.contains("12345"),
            "unexpected OCR output: {:?}",
            result.full_text
        );
        // Bounding box must be inside the image (Retina renders the 400x80
        // canvas at 2x → read the real pixel dims from the PNG header).
        let info = png::Decoder::new(std::io::Cursor::new(&png[..]))
            .read_info()
            .unwrap();
        let (w, h) = (info.info().width as f64, info.info().height as f64);
        let b = &result.blocks[0];
        assert!(b.x >= 0.0 && b.y >= 0.0 && b.x + b.width <= w && b.y + b.height <= h);
    }
}
