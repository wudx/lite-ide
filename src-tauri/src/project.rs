use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use dashmap::DashMap;
use notify::RecommendedWatcher;
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::Serialize;
use tauri::ipc::Channel;
use uuid::Uuid;

use crate::error::AppError;

const WATCH_DEBOUNCE_MS: u64 = 250;
const MAX_DELTA_PATHS: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub root_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsDelta {
    pub project_id: String,
    pub affected_dirs: Vec<String>,
    pub affected_paths: Vec<String>,
    pub overflow: bool,
}

pub struct ProjectSession {
    pub name: String,
    pub display_root: String,
    pub canonical_root: PathBuf,
    _watcher: Option<Debouncer<RecommendedWatcher>>,
}

pub struct ProjectManager {
    sessions: DashMap<String, ProjectSession>,
}

impl Default for ProjectManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ProjectManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
        }
    }

    pub fn open_project(
        &self,
        path: String,
        on_fs_event: Channel<FsDelta>,
    ) -> Result<ProjectInfo, AppError> {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err(AppError::InvalidPath("empty project path".into()));
        }

        let input_path = Path::new(trimmed);
        if !input_path.exists() {
            return Err(AppError::InvalidPath(format!("path does not exist: {trimmed}")));
        }
        if !input_path.is_dir() {
            return Err(AppError::NotDirectory(trimmed.to_string()));
        }

        let canonical_root = std::fs::canonicalize(input_path)?;
        if !canonical_root.is_dir() {
            return Err(AppError::NotDirectory(trimmed.to_string()));
        }

        let display_root = strip_verbatim_prefix(&canonical_root);
        let name = canonical_root
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| !n.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| display_root.clone());

        // Reuse existing session if the same canonical folder is already open.
        if let Some(mut existing) = self
            .sessions
            .iter_mut()
            .find(|entry| entry.value().canonical_root == canonical_root)
        {
            let id = existing.key().clone();
            let watcher = start_watcher(id.clone(), canonical_root.clone(), on_fs_event).ok();
            existing._watcher = watcher;
            return Ok(ProjectInfo {
                id,
                name: existing.name.clone(),
                root_path: existing.display_root.clone(),
            });
        }

        let id = Uuid::new_v4().to_string();
        let watcher = start_watcher(id.clone(), canonical_root.clone(), on_fs_event)
            .map_err(|e| AppError::Watch(e.to_string()))?;

        let info = ProjectInfo {
            id: id.clone(),
            name: name.clone(),
            root_path: display_root.clone(),
        };

        self.sessions.insert(
            id,
            ProjectSession {
                name,
                display_root,
                canonical_root,
                _watcher: Some(watcher),
            },
        );

        Ok(info)
    }

    pub fn close_project(&self, project_id: &str) -> Result<(), AppError> {
        self.sessions
            .remove(project_id)
            .map(|_| ())
            .ok_or_else(|| AppError::ProjectNotFound(project_id.to_string()))
    }

    pub fn get_canonical_root(&self, project_id: &str) -> Result<PathBuf, AppError> {
        self.sessions
            .get(project_id)
            .map(|s| s.canonical_root.clone())
            .ok_or_else(|| AppError::ProjectNotFound(project_id.to_string()))
    }

    pub fn resolve_file(&self, project_id: &str, rel_path: &str) -> Result<PathBuf, AppError> {
        let root = self.get_canonical_root(project_id)?;
        let target = resolve_safe_path(&root, rel_path)?;
        if !target.is_file() {
            return Err(AppError::NotFile(rel_path.to_string()));
        }
        Ok(target)
    }
}

/// Strips Windows `\\?\` verbatim path prefix for clean UI display.
pub fn strip_verbatim_prefix(path: &Path) -> String {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.into_owned()
    }
}

/// Validates and resolves a project-relative path, rejecting traversal and symlink escapes.
pub fn resolve_safe_path(canonical_root: &Path, rel_path: &str) -> Result<PathBuf, AppError> {
    if rel_path.contains('\0') {
        return Err(AppError::InvalidPath("null byte in path".into()));
    }

    let normalized = rel_path.replace('\\', "/");
    let trimmed = normalized.trim_matches('/');

    if trimmed.is_empty() {
        return Ok(canonical_root.to_path_buf());
    }

    // Reject absolute Windows/POSIX prefixes before component parsing.
    if normalized.starts_with('/') || is_windows_drive_prefix(trimmed) {
        return Err(AppError::PathTraversal(rel_path.to_string()));
    }

    let mut joined = canonical_root.to_path_buf();
    for segment in trimmed.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(AppError::PathTraversal(rel_path.to_string()));
        }
        if Path::new(segment)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(AppError::PathTraversal(rel_path.to_string()));
        }
        joined.push(segment);
    }

    let canonical_target = std::fs::canonicalize(&joined)?;
    if !canonical_target.starts_with(canonical_root) {
        return Err(AppError::PathTraversal(rel_path.to_string()));
    }

    Ok(canonical_target)
}

fn is_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// Validates project-relative path segments (rejects traversal, absolute
/// prefixes and characters invalid in workspace entry names). Shared by the
/// filesystem commands and the git pathspec validation.
pub fn validate_rel_segments(rel_path: &str) -> Result<Vec<String>, AppError> {
    if rel_path.contains('\0') {
        return Err(AppError::InvalidPath("null byte in path".into()));
    }

    let normalized = rel_path.replace('\\', "/");
    if normalized.starts_with('/') || is_windows_drive_prefix(normalized.trim_matches('/')) {
        return Err(AppError::PathTraversal(rel_path.to_string()));
    }

    let trimmed = normalized.trim_matches('/');
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let mut segments = Vec::new();
    for segment in trimmed.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(AppError::PathTraversal(rel_path.to_string()));
        }
        if Path::new(segment)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(AppError::PathTraversal(rel_path.to_string()));
        }
        if segment.chars().any(|c| {
            c.is_ascii_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')
        }) {
            return Err(AppError::InvalidName(segment.to_string()));
        }
        segments.push(segment.to_string());
    }

    Ok(segments)
}

/// Validates and resolves a target path for creating or moving an entry within `canonical_root`.
pub fn resolve_safe_new_path(canonical_root: &Path, rel_path: &str) -> Result<PathBuf, AppError> {
    let segments = validate_rel_segments(rel_path)?;
    if segments.is_empty() {
        return Err(AppError::InvalidPath("target path cannot be empty".into()));
    }

    let (file_name, parent_segments) = segments
        .split_last()
        .ok_or_else(|| AppError::InvalidPath("target path cannot be empty".into()))?;
    let parent_rel = parent_segments.join("/");
    let canonical_parent = resolve_safe_path(canonical_root, &parent_rel)?;
    if !canonical_parent.is_dir() {
        return Err(AppError::NotDirectory(parent_rel));
    }

    Ok(canonical_parent.join(file_name))
}

/// Validates and resolves an existing workspace entry without following a terminal symlink outside root.
pub fn resolve_safe_existing_entry(canonical_root: &Path, rel_path: &str) -> Result<PathBuf, AppError> {
    let target = resolve_safe_new_path(canonical_root, rel_path)?;
    let meta = std::fs::symlink_metadata(&target)?;
    if !meta.file_type().is_symlink() {
        let canonical_target = std::fs::canonicalize(&target)?;
        if !canonical_target.starts_with(canonical_root) {
            return Err(AppError::PathTraversal(rel_path.to_string()));
        }
    }
    Ok(target)
}

fn start_watcher(
    project_id: String,
    canonical_root: PathBuf,
    channel: Channel<FsDelta>,
) -> notify::Result<Debouncer<RecommendedWatcher>> {
    let root_for_cb = canonical_root.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(WATCH_DEBOUNCE_MS),
        move |res: DebounceEventResult| {
            let Ok(events) = res else {
                return;
            };

            let mut affected_paths = BTreeSet::new();
            let mut affected_dirs = BTreeSet::new();
            let mut overflow = false;

            for event in events {
                let rel = match event.path.strip_prefix(&root_for_cb) {
                    Ok(p) => normalize_rel_path(p),
                    Err(_) => continue,
                };
                if rel.is_empty() || is_noisy_watch_path(&rel) {
                    continue;
                }

                if affected_paths.len() >= MAX_DELTA_PATHS {
                    overflow = true;
                    break;
                }

                let parent_dir = match rel.rsplit_once('/') {
                    Some((parent, _)) => parent.to_string(),
                    None => String::new(),
                };
                affected_dirs.insert(parent_dir);
                affected_paths.insert(rel);
            }

            if affected_paths.is_empty() && !overflow {
                return;
            }

            let _ = channel.send(FsDelta {
                project_id: project_id.clone(),
                affected_dirs: affected_dirs.into_iter().collect(),
                affected_paths: affected_paths.into_iter().collect(),
                overflow,
            });
        },
    )?;

    debouncer
        .watcher()
        .watch(&canonical_root, RecursiveMode::Recursive)?;
    Ok(debouncer)
}

pub fn normalize_rel_path(path: &Path) -> String {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn is_noisy_watch_path(rel: &str) -> bool {
    rel == ".git/index.lock"
        || rel.starts_with(".git/objects/")
        || rel.starts_with(".git/logs/")
        || rel.starts_with("node_modules/")
        || rel.starts_with("target/")
        || rel.starts_with(".vite/")
        || rel.starts_with(".pnpm-store/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn resolves_valid_relative_paths_and_root() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let sub = root.join("src");
        std::fs::create_dir(&sub).unwrap();
        let file = sub.join("main.rs");
        std::fs::write(&file, "fn main() {}").unwrap();

        assert_eq!(resolve_safe_path(&root, "").unwrap(), root);
        assert_eq!(resolve_safe_path(&root, "/").unwrap(), root);
        assert_eq!(
            resolve_safe_path(&root, "src/main.rs").unwrap(),
            std::fs::canonicalize(&file).unwrap()
        );
        assert_eq!(
            resolve_safe_path(&root, r"src\main.rs").unwrap(),
            std::fs::canonicalize(&file).unwrap()
        );
    }

    #[test]
    fn rejects_path_traversal_and_absolute_paths() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();

        assert!(matches!(
            resolve_safe_path(&root, "../secret.txt"),
            Err(AppError::PathTraversal(_))
        ));
        assert!(matches!(
            resolve_safe_path(&root, "a/../../secret.txt"),
            Err(AppError::PathTraversal(_))
        ));
        assert!(matches!(
            resolve_safe_path(&root, "/etc/passwd"),
            Err(AppError::PathTraversal(_))
        ));
        assert!(matches!(
            resolve_safe_path(&root, "C:/Windows/System32"),
            Err(AppError::PathTraversal(_))
        ));
        assert!(matches!(
            resolve_safe_path(&root, "bad\0path"),
            Err(AppError::InvalidPath(_))
        ));
    }

    #[test]
    fn strips_windows_verbatim_prefix() {
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\C:\Users\dev\repo")),
            r"C:\Users\dev\repo"
        );
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\UNC\server\share\repo")),
            r"\\server\share\repo"
        );
        assert_eq!(
            strip_verbatim_prefix(Path::new("/home/dev/repo")),
            "/home/dev/repo"
        );
    }

    #[test]
    fn resolves_safe_new_path_and_rejects_invalid_targets() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir(root.join("src")).unwrap();

        assert_eq!(
            resolve_safe_new_path(&root, "src/new_file.ts").unwrap(),
            root.join("src").join("new_file.ts")
        );
        assert!(matches!(
            resolve_safe_new_path(&root, ""),
            Err(AppError::InvalidPath(_))
        ));
        assert!(matches!(
            resolve_safe_new_path(&root, "../escape.txt"),
            Err(AppError::PathTraversal(_))
        ));
        assert!(matches!(
            resolve_safe_new_path(&root, "src/bad:name.ts"),
            Err(AppError::InvalidName(_))
        ));
        assert!(matches!(
            resolve_safe_new_path(&root, "missing/file.ts"),
            Err(AppError::Io(_))
        ));
    }
}
