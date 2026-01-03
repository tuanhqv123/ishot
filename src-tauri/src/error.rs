use thiserror::Error;

#[derive(Debug, Error)]
#[allow(dead_code)]
pub enum AppError {
    #[error("Screen capture failed: {0}")]
    ScreenCapture(String),

    #[error("OCR recognition failed: {0}")]
    OcrError(String),

    #[error("File operation failed: {0}")]
    FileError(#[from] std::io::Error),

    #[error("Clipboard operation failed")]
    ClipboardError,

    #[error("Invalid region: {0}")]
    InvalidRegion(String),

    #[error("Window operation failed: {0}")]
    WindowError(String),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
