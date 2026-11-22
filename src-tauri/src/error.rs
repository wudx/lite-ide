use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("project not found: {0}")]
    ProjectNotFound(String),

    #[error("invalid path: {0}")]
    InvalidPath(String),

    #[error("path traversal rejected: {0}")]
    PathTraversal(String),

    #[error("not a directory: {0}")]
    NotDirectory(String),

    #[error("not a file: {0}")]
    NotFile(String),

    #[error("path already exists: {0}")]
    AlreadyExists(String),

    #[error("unsupported text encoding for writing: {0}")]
    UnsupportedEncoding(String),

    #[error("invalid file or folder name: {0}")]
    InvalidName(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("watch error: {0}")]
    Watch(String),

    #[error("git error: {0}")]
    Git(String),

    #[error("ai error: {0}")]
    Ai(String),

    #[error("terminal error: {0}")]
    Terminal(String),

    #[error("plugin error: {0}")]
    Plugin(String),
}

#[derive(Serialize)]
struct SerializedError<'a> {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ProjectNotFound(_) => "PROJECT_NOT_FOUND",
            Self::InvalidPath(_) => "INVALID_PATH",
            Self::PathTraversal(_) => "PATH_TRAVERSAL",
            Self::NotDirectory(_) => "NOT_DIRECTORY",
            Self::NotFile(_) => "NOT_FILE",
            Self::AlreadyExists(_) => "ALREADY_EXISTS",
            Self::UnsupportedEncoding(_) => "UNSUPPORTED_ENCODING",
            Self::InvalidName(_) => "INVALID_NAME",
            Self::Io(_) => "IO_ERROR",
            Self::Watch(_) => "WATCH_ERROR",
            Self::Git(_) => "GIT_ERROR",
            Self::Ai(_) => "AI_ERROR",
            Self::Terminal(_) => "TERMINAL_ERROR",
            Self::Plugin(_) => "PLUGIN_ERROR",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        SerializedError {
            code: self.code(),
            message: self.to_string(),
            detail: None,
        }
        .serialize(serializer)
    }
}
