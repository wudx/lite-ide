use std::cmp::Ordering;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

use content_inspector::{inspect, ContentType};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde::Serialize;
use tokio::io::AsyncReadExt;

use crate::error::AppError;
use crate::project::{
    normalize_rel_path, resolve_safe_existing_entry, resolve_safe_new_path, resolve_safe_path,
};

pub const DEFAULT_MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
pub const HARD_MAX_TEXT_BYTES: usize = 20 * 1024 * 1024;
const SNIFF_BYTES: usize = 8192;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: u64,
    pub ignored: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub project_id: String,
    pub rel_path: String,
    pub name: String,
    pub ext: String,
    pub size: u64,
    pub modified_ms: u64,
    pub mime: String,
    pub is_binary: bool,
    pub encoding: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPayload {
    pub content: String,
    pub total_bytes: u64,
    pub loaded_bytes: usize,
    pub truncated: bool,
    pub line_count: usize,
    pub encoding: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteTextResult {
    pub meta: FileMeta,
    pub line_count: usize,
    pub written_bytes: usize,
}

pub fn list_dir(canonical_root: &Path, rel_path: &str) -> Result<Vec<DirEntry>, AppError> {
    let target_dir = resolve_safe_path(canonical_root, rel_path)?;
    if !target_dir.is_dir() {
        return Err(AppError::NotDirectory(rel_path.to_string()));
    }

    let gitignores = build_gitignore_chain(canonical_root, &target_dir);
    let read_dir = std::fs::read_dir(&target_dir)?;
    let mut entries = Vec::new();

    for item in read_dir {
        let Ok(entry) = item else {
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.is_empty() {
            continue;
        }

        let is_dir = if file_type.is_symlink() {
            path.is_dir()
        } else {
            file_type.is_dir()
        };

        let meta = entry.metadata().ok();
        let size = if is_dir {
            0
        } else {
            meta.as_ref().map(|m| m.len()).unwrap_or(0)
        };
        let modified_ms = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let entry_rel = path
            .strip_prefix(canonical_root)
            .map(normalize_rel_path)
            .unwrap_or_else(|_| name.clone());

        let hidden = name.starts_with('.');
        let ignored = name == ".git" || is_ignored_by_chain(&gitignores, &path, is_dir);

        entries.push(DirEntry {
            name,
            rel_path: entry_rel,
            is_dir,
            size,
            modified_ms,
            ignored,
            hidden,
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => natural_cmp(&a.name, &b.name),
    });

    Ok(entries)
}

pub fn stat_preview(
    project_id: &str,
    canonical_root: &Path,
    rel_path: &str,
) -> Result<FileMeta, AppError> {
    let target = resolve_safe_path(canonical_root, rel_path)?;
    if !target.is_file() {
        return Err(AppError::NotFile(rel_path.to_string()));
    }

    let meta = std::fs::metadata(&target)?;
    let size = meta.len();
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let (is_binary, encoding) = sniff_file(&target)?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = detect_mime(&target);
    let normalized_rel = target
        .strip_prefix(canonical_root)
        .map(normalize_rel_path)
        .unwrap_or_else(|_| rel_path.replace('\\', "/"));

    Ok(FileMeta {
        project_id: project_id.to_string(),
        rel_path: normalized_rel,
        name,
        ext,
        size,
        modified_ms,
        mime,
        is_binary,
        encoding,
    })
}

pub async fn read_text(
    canonical_root: &Path,
    rel_path: &str,
    max_bytes: Option<usize>,
) -> Result<TextPayload, AppError> {
    let target = resolve_safe_path(canonical_root, rel_path)?;
    if !target.is_file() {
        return Err(AppError::NotFile(rel_path.to_string()));
    }

    let limit = max_bytes
        .unwrap_or(DEFAULT_MAX_TEXT_BYTES)
        .clamp(1, HARD_MAX_TEXT_BYTES);

    let file = tokio::fs::File::open(&target).await?;
    let total_bytes = file.metadata().await?.len();

    let mut reader = file.take((limit + 1) as u64);
    let mut buf = Vec::with_capacity(limit.min(total_bytes as usize) + 1);
    reader.read_to_end(&mut buf).await?;

    let truncated = buf.len() > limit;
    if truncated {
        buf.truncate(limit);
    }

    let (encoding, content) = decode_text_buffer(&mut buf, truncated);
    let loaded_bytes = buf.len();
    let line_count = if content.is_empty() {
        0
    } else {
        content.split('\n').count()
    };

    Ok(TextPayload {
        content,
        total_bytes,
        loaded_bytes,
        truncated,
        line_count,
        encoding,
    })
}

pub async fn write_text(
    project_id: &str,
    canonical_root: &Path,
    rel_path: &str,
    content: &str,
    encoding: Option<&str>,
) -> Result<WriteTextResult, AppError> {
    let target = resolve_safe_path(canonical_root, rel_path)?;
    if !target.is_file() {
        return Err(AppError::NotFile(rel_path.to_string()));
    }

    let target_encoding = match encoding {
        Some(enc) if !enc.trim().is_empty() => enc.trim().to_string(),
        _ => sniff_file(&target)?.1,
    };

    let bytes = encode_text_buffer(content, &target_encoding)?;
    let written_bytes = bytes.len();
    tokio::fs::write(&target, &bytes).await?;

    let line_count = if content.is_empty() {
        0
    } else {
        content.split('\n').count()
    };
    let meta = stat_preview(project_id, canonical_root, rel_path)?;

    Ok(WriteTextResult {
        meta,
        line_count,
        written_bytes,
    })
}

pub fn create_file(
    project_id: &str,
    canonical_root: &Path,
    rel_path: &str,
) -> Result<FileMeta, AppError> {
    let target = resolve_safe_new_path(canonical_root, rel_path)?;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
    {
        Ok(_) => stat_preview(project_id, canonical_root, rel_path),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(AppError::AlreadyExists(rel_path.to_string()))
        }
        Err(err) => Err(AppError::Io(err)),
    }
}

pub fn create_dir(canonical_root: &Path, rel_path: &str) -> Result<DirEntry, AppError> {
    let target = resolve_safe_new_path(canonical_root, rel_path)?;
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(AppError::AlreadyExists(rel_path.to_string()));
    }
    match std::fs::create_dir(&target) {
        Ok(()) => build_dir_entry(canonical_root, &target),
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(AppError::AlreadyExists(rel_path.to_string()))
        }
        Err(err) => Err(AppError::Io(err)),
    }
}

pub fn rename_path(
    canonical_root: &Path,
    old_rel_path: &str,
    new_rel_path: &str,
) -> Result<DirEntry, AppError> {
    let src = resolve_safe_existing_entry(canonical_root, old_rel_path)?;
    let dst = resolve_safe_new_path(canonical_root, new_rel_path)?;

    if src == dst {
        return build_dir_entry(canonical_root, &dst);
    }

    let is_case_only_rename = src.parent() == dst.parent()
        && match (
            src.file_name().and_then(|s| s.to_str()),
            dst.file_name().and_then(|s| s.to_str()),
        ) {
            (Some(a), Some(b)) => a != b && a.to_lowercase() == b.to_lowercase(),
            _ => false,
        };

    if std::fs::symlink_metadata(&dst).is_ok() && !is_case_only_rename {
        return Err(AppError::AlreadyExists(new_rel_path.to_string()));
    }

    std::fs::rename(&src, &dst)?;
    build_dir_entry(canonical_root, &dst)
}

pub fn delete_path(canonical_root: &Path, rel_path: &str) -> Result<(), AppError> {
    let target = resolve_safe_existing_entry(canonical_root, rel_path)?;
    let meta = std::fs::symlink_metadata(&target)?;

    if meta.file_type().is_symlink() {
        if let Err(err) = std::fs::remove_file(&target) {
            if target.is_dir() {
                std::fs::remove_dir(&target)?;
            } else {
                return Err(AppError::Io(err));
            }
        }
        return Ok(());
    }

    if meta.is_dir() {
        std::fs::remove_dir_all(&target)?;
    } else {
        std::fs::remove_file(&target)?;
    }

    Ok(())
}

/// Returns `(program, args)` for revealing `path` in the OS file manager:
/// files are selected inside their parent folder; directories open in place
/// (Windows/Linux) or are revealed in their parent (macOS).
fn file_manager_spawn_args(path: &Path, is_dir: bool) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        if is_dir {
            // raw_arg 不做任何转义，含空格路径须自带引号，否则 explorer 按空格拆参。
            ("explorer".into(), vec![format!("\"{}\"", path.display())])
        } else {
            // explorer 的 `/select,` 语法要求路径内嵌引号（`/select,"路径"`），
            // 由调用方经 raw_arg 传入，绕开 std 的自动引号转义。
            (
                "explorer".into(),
                vec![format!("/select,\"{}\"", path.display())],
            )
        }
    }
    #[cfg(target_os = "macos")]
    {
        // open -R 对目录同样是在父目录中显示（选中）该目录。
        let _ = is_dir;
        let mut args = vec!["-R".to_string()];
        args.push(path.display().to_string());
        ("open".into(), args)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Linux 等平台没有统一的“选中并显示”接口：目录直接打开，
        // 文件退而打开其父目录。
        let target = if is_dir {
            path.to_path_buf()
        } else {
            path.parent().unwrap_or(path).to_path_buf()
        };
        ("xdg-open".into(), vec![target.display().to_string()])
    }
}

/// Reveals a project entry in the system file manager (desktop only).
pub fn reveal_in_file_manager(canonical_root: &Path, rel_path: &str) -> Result<(), AppError> {
    let target = resolve_safe_path(canonical_root, rel_path)?;
    // canonicalize 在 Windows 上产生 `\\?\` 前缀，交给 shell 前剥掉以获得常规路径。
    let plain = crate::project::strip_verbatim_prefix(&target);
    let is_dir = target.is_dir();
    let (program, args) = file_manager_spawn_args(Path::new(&plain), is_dir);

    let mut cmd = std::process::Command::new(&program);
    // 与 spawn_git 一致：隔离子进程 stdio，避免文件管理器的输出串入应用终端。
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        for arg in &args {
            cmd.raw_arg(arg);
        }
        // explorer 常把请求转交给已运行的实例后以非零码退出，
        // 成功与否不可从退出码判断，spawn 成功即视为已打开。
        cmd.spawn()?;
    }
    #[cfg(not(windows))]
    {
        cmd.args(&args);
        // 同步等待：xdg-open / open 很快返回，同时避免留下僵尸子进程。
        let status = cmd.status()?;
        if !status.success() {
            return Err(AppError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("{program} exited with failure"),
            )));
        }
    }
    Ok(())
}

fn build_dir_entry(canonical_root: &Path, path: &Path) -> Result<DirEntry, AppError> {
    let link_meta = std::fs::symlink_metadata(path)?;
    let is_dir = if link_meta.file_type().is_symlink() {
        path.is_dir()
    } else {
        link_meta.is_dir()
    };
    let meta = std::fs::metadata(path).unwrap_or(link_meta);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let size = if is_dir { 0 } else { meta.len() };
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let rel_path = path
        .strip_prefix(canonical_root)
        .map(normalize_rel_path)
        .unwrap_or_else(|_| name.clone());
    let parent_dir = path.parent().unwrap_or(canonical_root);
    let gitignores = build_gitignore_chain(canonical_root, parent_dir);
    let hidden = name.starts_with('.');
    let ignored = name == ".git" || is_ignored_by_chain(&gitignores, path, is_dir);

    Ok(DirEntry {
        name,
        rel_path,
        is_dir,
        size,
        modified_ms,
        ignored,
        hidden,
    })
}

fn encode_text_buffer(content: &str, encoding: &str) -> Result<Vec<u8>, AppError> {
    match encoding.to_ascii_lowercase().as_str() {
        "" | "utf-8" => Ok(content.as_bytes().to_vec()),
        "utf-8-bom" => {
            let mut bytes = Vec::with_capacity(3 + content.len());
            bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            bytes.extend_from_slice(content.as_bytes());
            Ok(bytes)
        }
        "utf-16le" => {
            let mut bytes = Vec::with_capacity(2 + content.len() * 2);
            bytes.extend_from_slice(&[0xFF, 0xFE]);
            for unit in content.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            Ok(bytes)
        }
        "utf-16be" => {
            let mut bytes = Vec::with_capacity(2 + content.len() * 2);
            bytes.extend_from_slice(&[0xFE, 0xFF]);
            for unit in content.encode_utf16() {
                bytes.extend_from_slice(&unit.to_be_bytes());
            }
            Ok(bytes)
        }
        other => Err(AppError::UnsupportedEncoding(other.to_string())),
    }
}

pub fn detect_mime(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());

    match ext.as_deref() {
        // Explicit overrides prevent mime_guess from misclassifying `.ts` as `video/mp2t`.
        Some("ts" | "tsx" | "mts" | "cts") => "text/typescript".into(),
        Some("js" | "jsx" | "mjs" | "cjs") => "text/javascript".into(),
        Some("rs") => "text/x-rust".into(),
        Some("go") => "text/x-go".into(),
        Some("py" | "pyw" | "pyi") => "text/x-python".into(),
        Some("toml") => "application/toml".into(),
        Some("yaml" | "yml") => "text/yaml".into(),
        Some("json" | "jsonc" | "json5") => "application/json".into(),
        Some("md" | "markdown" | "mdx") => "text/markdown".into(),
        Some("svg") => "image/svg+xml".into(),
        Some("mp3") => "audio/mpeg".into(),
        Some("wav") => "audio/wav".into(),
        Some("ogg" | "oga") => "audio/ogg".into(),
        Some("opus") => "audio/opus".into(),
        Some("flac") => "audio/flac".into(),
        Some("aac") => "audio/aac".into(),
        Some("m4a") => "audio/mp4".into(),
        Some("weba") => "audio/webm".into(),
        Some("aiff" | "aif") => "audio/aiff".into(),
        Some("vue" | "svelte" | "astro" | "zig" | "lua" | "nix" | "sql" | "sh" | "bash"
            | "zsh" | "ps1" | "bat" | "cmd" | "env" | "lock" | "ini" | "conf") => {
            "text/plain".into()
        }
        _ => mime_guess::from_path(path)
            .first_or_octet_stream()
            .essence_str()
            .to_string(),
    }
}

fn sniff_file(path: &Path) -> Result<(bool, String), AppError> {
    let file = File::open(path)?;
    let mut buf = Vec::with_capacity(SNIFF_BYTES);
    file.take(SNIFF_BYTES as u64).read_to_end(&mut buf)?;

    if buf.is_empty() {
        return Ok((false, "utf-8".into()));
    }

    let (is_binary, enc) = match inspect(&buf) {
        ContentType::BINARY => (true, "binary"),
        ContentType::UTF_8 => (false, "utf-8"),
        ContentType::UTF_8_BOM => (false, "utf-8-bom"),
        ContentType::UTF_16LE => (false, "utf-16le"),
        ContentType::UTF_16BE => (false, "utf-16be"),
        ContentType::UTF_32LE | ContentType::UTF_32BE => (false, "utf-32"),
    };

    Ok((is_binary, enc.into()))
}

fn decode_text_buffer(buf: &mut Vec<u8>, truncated: bool) -> (String, String) {
    if buf.is_empty() {
        return ("utf-8".into(), String::new());
    }

    if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        if truncated {
            trim_incomplete_utf8_tail(buf);
        }
        let text = String::from_utf8_lossy(&buf[3..]).into_owned();
        return ("utf-8-bom".into(), text);
    }

    if buf.starts_with(&[0xFF, 0xFE]) && !buf.starts_with(&[0xFF, 0xFE, 0x00, 0x00]) {
        if buf.len() % 2 == 1 {
            buf.pop();
        }
        let units: Vec<u16> = buf[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return ("utf-16le".into(), String::from_utf16_lossy(&units));
    }

    if buf.starts_with(&[0xFE, 0xFF]) {
        if buf.len() % 2 == 1 {
            buf.pop();
        }
        let units: Vec<u16> = buf[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return ("utf-16be".into(), String::from_utf16_lossy(&units));
    }

    if truncated {
        trim_incomplete_utf8_tail(buf);
    }

    ("utf-8".into(), String::from_utf8_lossy(buf).into_owned())
}

/// Drops up to 3 trailing bytes when byte truncation splits a multi-byte UTF-8 character.
pub fn trim_incomplete_utf8_tail(buf: &mut Vec<u8>) {
    let len = buf.len();
    if len == 0 {
        return;
    }

    let check_from = len.saturating_sub(4);
    if std::str::from_utf8(&buf[check_from..]).is_ok() {
        return;
    }

    let mut start = len - 1;
    let min_start = len.saturating_sub(4);
    while start > min_start && (buf[start] & 0b1100_0000) == 0b1000_0000 {
        start -= 1;
    }

    if std::str::from_utf8(&buf[start..]).is_err() {
        buf.truncate(start);
    }
}

fn build_gitignore_chain(canonical_root: &Path, target_dir: &Path) -> Vec<Gitignore> {
    let mut dirs = Vec::new();
    dirs.push(canonical_root.to_path_buf());

    if let Ok(rel) = target_dir.strip_prefix(canonical_root) {
        let mut cursor = canonical_root.to_path_buf();
        for comp in rel.components() {
            cursor.push(comp);
            dirs.push(cursor.clone());
        }
    }

    let mut chain = Vec::new();
    for (idx, dir) in dirs.into_iter().enumerate() {
        let mut builder = GitignoreBuilder::new(&dir);
        let mut has_rules = false;

        let gi_file = dir.join(".gitignore");
        if gi_file.is_file() {
            let _ = builder.add(&gi_file);
            has_rules = true;
        }

        if idx == 0 {
            let exclude = dir.join(".git/info/exclude");
            if exclude.is_file() {
                let _ = builder.add(&exclude);
                has_rules = true;
            }
        }

        if has_rules {
            if let Ok(gi) = builder.build() {
                chain.push(gi);
            }
        }
    }

    chain
}

fn is_ignored_by_chain(chain: &[Gitignore], path: &Path, is_dir: bool) -> bool {
    for gi in chain.iter().rev() {
        let matched = gi.matched_path_or_any_parents(path, is_dir);
        if matched.is_whitelist() {
            return false;
        }
        if matched.is_ignore() {
            return true;
        }
    }
    false
}

/// Natural case-insensitive ordering: `file2.ts` < `file10.ts`.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ia = 0usize;
    let mut ib = 0usize;
    let ba = a.as_bytes();
    let bb = b.as_bytes();

    while ia < ba.len() && ib < bb.len() {
        let da = ba[ia].is_ascii_digit();
        let db = bb[ib].is_ascii_digit();

        if da && db {
            let ea = take_digits_end(ba, ia);
            let eb = take_digits_end(bb, ib);
            let sa = &a[ia..ea];
            let sb = &b[ib..eb];

            let ord = compare_numeric_slices(sa, sb);
            if ord != Ordering::Equal {
                return ord;
            }
            ia = ea;
            ib = eb;
        } else {
            let ea = take_text_end(a, ia);
            let eb = take_text_end(b, ib);
            let sa = &a[ia..ea];
            let sb = &b[ib..eb];

            let ord = sa.to_lowercase().cmp(&sb.to_lowercase());
            if ord != Ordering::Equal {
                return ord;
            }
            ia = ea;
            ib = eb;
        }
    }

    match ba.len().cmp(&bb.len()) {
        Ordering::Equal => a.cmp(b),
        non_eq => non_eq,
    }
}

fn take_digits_end(bytes: &[u8], start: usize) -> usize {
    let mut end = start;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    end
}

fn take_text_end(s: &str, start: usize) -> usize {
    for (offset, ch) in s[start..].char_indices() {
        if offset > 0 && ch.is_ascii_digit() {
            return start + offset;
        }
    }
    s.len()
}

fn compare_numeric_slices(a: &str, b: &str) -> Ordering {
    let trim_a = a.trim_start_matches('0');
    let trim_b = b.trim_start_matches('0');

    match trim_a.len().cmp(&trim_b.len()) {
        Ordering::Equal => match trim_a.cmp(trim_b) {
            Ordering::Equal => a.len().cmp(&b.len()),
            ord => ord,
        },
        ord => ord,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn natural_ordering_places_file2_before_file10() {
        let mut names = vec!["file10.ts", "file2.ts", "file1.ts", "Alpha.ts", "beta.ts"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            names,
            vec!["Alpha.ts", "beta.ts", "file1.ts", "file2.ts", "file10.ts"]
        );
    }

    #[test]
    fn list_dir_sorts_dirs_first_and_marks_gitignore() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();

        std::fs::write(root.join(".gitignore"), "*.log\ndist/\n").unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::create_dir(root.join("dist")).unwrap();
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::write(root.join("app.log"), "trace").unwrap();
        std::fs::write(root.join("main.ts"), "export {}").unwrap();

        let entries = list_dir(&root, "").unwrap();
        let names: Vec<_> = entries.iter().map(|e| (e.name.as_str(), e.is_dir, e.ignored)).collect();

        assert_eq!(
            names,
            vec![
                (".git", true, true),
                ("dist", true, true),
                ("src", true, false),
                (".gitignore", false, false),
                ("app.log", false, true),
                ("main.ts", false, false),
            ]
        );
    }

    #[test]
    fn mime_detection_does_not_treat_typescript_as_video() {
        assert_eq!(detect_mime(Path::new("index.ts")), "text/typescript");
        assert_eq!(detect_mime(Path::new("App.tsx")), "text/typescript");
        assert_eq!(detect_mime(Path::new("lib.rs")), "text/x-rust");
        assert_eq!(detect_mime(Path::new("logo.svg")), "image/svg+xml");
        assert_eq!(detect_mime(Path::new("README.md")), "text/markdown");
    }

    #[test]
    fn mime_detection_recognizes_audio_extensions() {
        assert_eq!(detect_mime(Path::new("bgm.mp3")), "audio/mpeg");
        assert_eq!(detect_mime(Path::new("sfx.WAV")), "audio/wav");
        assert_eq!(detect_mime(Path::new("voice.ogg")), "audio/ogg");
        assert_eq!(detect_mime(Path::new("track.opus")), "audio/opus");
        assert_eq!(detect_mime(Path::new("lossless.flac")), "audio/flac");
        assert_eq!(detect_mime(Path::new("clip.m4a")), "audio/mp4");
        assert_eq!(detect_mime(Path::new("stream.weba")), "audio/webm");
    }

    #[test]
    fn stat_preview_detects_text_and_binary() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(root.join("hello.ts"), "const x = '你好';\n").unwrap();
        std::fs::write(root.join("blob.bin"), [0x00, 0x01, 0x02, 0xFF, 0x00]).unwrap();

        let text_meta = stat_preview("p1", &root, "hello.ts").unwrap();
        assert!(!text_meta.is_binary);
        assert_eq!(text_meta.mime, "text/typescript");
        assert_eq!(text_meta.ext, "ts");

        let bin_meta = stat_preview("p1", &root, "blob.bin").unwrap();
        assert!(bin_meta.is_binary);
        assert_eq!(bin_meta.encoding, "binary");
    }

    #[tokio::test]
    async fn read_text_truncates_on_utf8_boundary_safely() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        // Each Chinese char is 3 bytes in UTF-8 -> total 9 bytes.
        std::fs::write(root.join("cn.txt"), "一二三").unwrap();

        // Cut right inside the 2nd character (5 bytes).
        let payload = read_text(&root, "cn.txt", Some(5)).await.unwrap();
        assert!(payload.truncated);
        assert_eq!(payload.total_bytes, 9);
        assert_eq!(payload.loaded_bytes, 3);
        assert_eq!(payload.content, "一");
    }

    #[tokio::test]
    async fn write_text_roundtrips_supported_encodings_and_rejects_utf32() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();

        for enc in ["utf-8", "utf-8-bom", "utf-16le", "utf-16be"] {
            let name = format!("{enc}.txt");
            create_file("p1", &root, &name).unwrap();
            let text = "hello\n世界";
            let res = write_text("p1", &root, &name, text, Some(enc)).await.unwrap();
            assert_eq!(res.line_count, 2);
            assert_eq!(res.meta.encoding, enc);

            let read_back = read_text(&root, &name, None).await.unwrap();
            assert_eq!(read_back.content, text);
            assert_eq!(read_back.encoding, enc);
        }

        create_file("p1", &root, "bad.txt").unwrap();
        let err = write_text("p1", &root, "bad.txt", "abc", Some("utf-32"))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::UnsupportedEncoding(_)));
    }

    #[test]
    fn create_rename_and_delete_entries_enforce_conflicts_and_boundaries() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();

        let created_dir = create_dir(&root, "src").unwrap();
        assert!(created_dir.is_dir);
        assert!(matches!(create_dir(&root, "src"), Err(AppError::AlreadyExists(_))));

        let created_file = create_file("p1", &root, "src/app.ts").unwrap();
        assert_eq!(created_file.rel_path, "src/app.ts");
        assert!(matches!(
            create_file("p1", &root, "src/app.ts"),
            Err(AppError::AlreadyExists(_))
        ));

        let renamed_file = rename_path(&root, "src/app.ts", "src/App.ts").unwrap();
        assert_eq!(renamed_file.rel_path, "src/App.ts");

        create_file("p1", &root, "src/other.ts").unwrap();
        assert!(matches!(
            rename_path(&root, "src/App.ts", "src/other.ts"),
            Err(AppError::AlreadyExists(_))
        ));

        let renamed_dir = rename_path(&root, "src", "packages").unwrap();
        assert!(renamed_dir.is_dir);
        assert!(root.join("packages/other.ts").is_file());

        delete_path(&root, "packages/other.ts").unwrap();
        assert!(!root.join("packages/other.ts").exists());

        delete_path(&root, "packages").unwrap();
        assert!(!root.join("packages").exists());

        assert!(matches!(delete_path(&root, ""), Err(AppError::InvalidPath(_))));
    }

    #[cfg(windows)]
    #[test]
    fn file_manager_args_select_files_and_open_dirs_on_windows() {
        let (program, args) =
            file_manager_spawn_args(Path::new(r"C:\demo dir\a b.txt"), false);
        assert_eq!(program, "explorer");
        // /select, 语法须整体为一个带内嵌引号的原始参数。
        assert_eq!(args, vec![r#"/select,"C:\demo dir\a b.txt""#]);

        // raw_arg 不做转义：目录参数同样自带引号，防止含空格路径被拆参。
        let (program, args) = file_manager_spawn_args(Path::new(r"C:\demo dir\sub"), true);
        assert_eq!(program, "explorer");
        assert_eq!(args, vec![r#""C:\demo dir\sub""#]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn file_manager_args_reveal_via_open_dash_r_on_macos() {
        let (program, args) =
            file_manager_spawn_args(Path::new("/tmp/demo dir/a b.txt"), false);
        assert_eq!(program, "open");
        assert_eq!(args, vec!["-R", "/tmp/demo dir/a b.txt"]);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn file_manager_args_fall_back_to_parent_dir_on_linux() {
        let (program, args) =
            file_manager_spawn_args(Path::new("/tmp/demo dir/a b.txt"), false);
        assert_eq!(program, "xdg-open");
        assert_eq!(args, vec!["/tmp/demo dir"]);

        let (program, args) = file_manager_spawn_args(Path::new("/tmp/demo dir"), true);
        assert_eq!(program, "xdg-open");
        assert_eq!(args, vec!["/tmp/demo dir"]);
    }
}
