//! Native screen recording via AVFoundation's capture stack.
//!
//! We use the high-level `AVCaptureSession` + `AVCaptureScreenInput` +
//! `AVCaptureMovieFileOutput` path: the session encodes (H.264) and muxes to a
//! `.mov` file on its own, so there are no manual frame/PTS/encoder details to
//! get wrong (unlike a hand-rolled ScreenCaptureKit + AVAssetWriter pipeline).
//! Mic is an optional `AVCaptureDeviceInput`. Window-only capture + a camera
//! track build on top of this later (ScreenCaptureKit for per-window).
//!
//! NOTE: `AVCaptureScreenInput` is deprecated in favour of ScreenCaptureKit but
//! remains functional on macOS 14, and is by far the most reliable way to get a
//! working recording without a frame-callback encoder.

use std::ffi::CString;
use std::sync::Mutex;

use cocoa::base::{id, nil};
use objc::declare::ClassDecl;
use objc::rc::autoreleasepool;
use objc::runtime::{Class, Object, Sel, BOOL, NO};
use objc::{class, msg_send, sel, sel_impl};

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {
    static AVMediaTypeAudio: id;
    static AVCaptureSessionPresetHigh: id;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGMainDisplayID() -> u32;
}

/// Retained capture objects for the in-flight recording. Raw objc pointers
/// aren't `Send`; the capture objects are safe to message across threads and we
/// serialise all access through the `Mutex`, so wrap them in a `Send` newtype.
struct Active {
    session: id,
    output: id,
    delegate: id,
    path: String,
}
unsafe impl Send for Active {}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);

/// Minimal `AVCaptureFileOutputRecordingDelegate` — the method is required by
/// `startRecordingToOutputFileURL:recordingDelegate:`. We don't need its
/// callbacks (the file is finalised on disk once `stopRecording` completes), so
/// it's a no-op; registered once.
fn delegate_class() -> &'static Class {
    use std::sync::Once;
    static REGISTER: Once = Once::new();
    static mut CLS: *const Class = std::ptr::null();
    unsafe {
        REGISTER.call_once(|| {
            let superclass = class!(NSObject);
            let mut decl = ClassDecl::new("IShotRecDelegate", superclass).unwrap();
            extern "C" fn did_finish(
                _this: &Object,
                _cmd: Sel,
                _output: id,
                _url: id,
                _conns: id,
                _err: id,
            ) {
            }
            decl.add_method(
                sel!(captureOutput:didFinishRecordingToOutputFileAtURL:fromConnections:error:),
                did_finish as extern "C" fn(&Object, Sel, id, id, id, id),
            );
            CLS = decl.register();
        });
        &*CLS
    }
}

fn temp_output_path() -> String {
    let dir = dirs::video_dir().unwrap_or_else(std::env::temp_dir);
    let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");
    dir.join(format!("ishot_recording_{}.mov", ts))
        .to_string_lossy()
        .into_owned()
}

unsafe fn nsstring(s: &str) -> id {
    let c = CString::new(s).unwrap_or_default();
    let obj: id = msg_send![class!(NSString), alloc];
    msg_send![obj, initWithUTF8String: c.as_ptr()]
}

pub fn is_recording() -> bool {
    ACTIVE.lock().map(|g| g.is_some()).unwrap_or(false)
}

/// Build + start the capture session. Owned objects (session/output/delegate)
/// outlive the autorelease pool; autoreleased temporaries (URL, device, input)
/// are drained when the pool exits — the session has already retained the
/// inputs/output it needs.
unsafe fn build_session(mic: bool) -> Result<Active, String> {
    autoreleasepool(|| {
        let session: id = msg_send![class!(AVCaptureSession), alloc];
        let session: id = msg_send![session, init];
        if session == nil {
            return Err("AVCaptureSession init failed".into());
        }
        let _: () = msg_send![session, setSessionPreset: AVCaptureSessionPresetHigh];

        let display_id = CGMainDisplayID();
        let screen: id = msg_send![class!(AVCaptureScreenInput), alloc];
        let screen: id = msg_send![screen, initWithDisplayID: display_id];
        if screen == nil {
            let _: () = msg_send![session, release];
            return Err("AVCaptureScreenInput init failed".into());
        }
        let can_add: BOOL = msg_send![session, canAddInput: screen];
        if can_add == NO {
            let _: () = msg_send![screen, release];
            let _: () = msg_send![session, release];
            return Err("cannot add screen input".into());
        }
        let _: () = msg_send![session, addInput: screen];
        let _: () = msg_send![screen, release];

        if mic {
            let dev: id =
                msg_send![class!(AVCaptureDevice), defaultDeviceWithMediaType: AVMediaTypeAudio];
            if dev != nil {
                let mut err: id = nil;
                let input: id = msg_send![
                    class!(AVCaptureDeviceInput),
                    deviceInputWithDevice: dev error: &mut err
                ];
                if input != nil {
                    let can_audio: BOOL = msg_send![session, canAddInput: input];
                    if can_audio != NO {
                        let _: () = msg_send![session, addInput: input];
                    }
                }
            }
        }

        let output: id = msg_send![class!(AVCaptureMovieFileOutput), alloc];
        let output: id = msg_send![output, init];
        let can_out: BOOL = msg_send![session, canAddOutput: output];
        if can_out == NO {
            let _: () = msg_send![output, release];
            let _: () = msg_send![session, release];
            return Err("cannot add movie output".into());
        }
        let _: () = msg_send![session, addOutput: output];

        let _: () = msg_send![session, startRunning];

        let path = temp_output_path();
        let ns_path: id = nsstring(&path);
        let url: id = msg_send![class!(NSURL), fileURLWithPath: ns_path];
        let delegate: id = msg_send![delegate_class(), new];
        let _: () = msg_send![
            output,
            startRecordingToOutputFileURL: url recordingDelegate: delegate
        ];
        let _: () = msg_send![ns_path, release];

        Ok(Active {
            session,
            output,
            delegate,
            path,
        })
    })
}

/// Start recording the main display to a temp `.mov`. `mic` adds the default
/// audio device. Returns the output path. Errors if already recording.
pub fn start(mic: bool) -> Result<String, String> {
    let mut guard = ACTIVE.lock().map_err(|_| "lock poisoned")?;
    if guard.is_some() {
        return Err("already recording".into());
    }
    let active = unsafe { build_session(mic) }?;
    let path = active.path.clone();
    *guard = Some(active);
    Ok(path)
}

pub fn pause() {
    if let Ok(g) = ACTIVE.lock() {
        if let Some(a) = g.as_ref() {
            unsafe {
                let _: () = msg_send![a.output, pauseRecording];
            }
        }
    }
}

pub fn resume() {
    if let Ok(g) = ACTIVE.lock() {
        if let Some(a) = g.as_ref() {
            unsafe {
                let _: () = msg_send![a.output, resumeRecording];
            }
        }
    }
}

/// Stop recording and return the output file path. The file is finalised
/// asynchronously by AVFoundation; the path is valid to open shortly after.
pub fn stop() -> Option<String> {
    let mut guard = ACTIVE.lock().ok()?;
    let active = guard.take()?;
    unsafe {
        let _: () = msg_send![active.output, stopRecording];
        let _: () = msg_send![active.session, stopRunning];
        let _: () = msg_send![active.output, release];
        let _: () = msg_send![active.session, release];
        let _: () = msg_send![active.delegate, release];
    }
    Some(active.path)
}
