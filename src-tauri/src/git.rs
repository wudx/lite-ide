//! Git integration backed by the system `git` executable.
//!
//! All commands run with `current_dir` set to the project's canonical root and
//! only accept validated project-relative pathspecs, so git can never be pointed
//! outside the opened workspace. Status is parsed from
//! `git status --porcelain=v1 -z -b`, whose NUL-separated records are robust
//! against spaces and unusual characters in file names.

use std::path::Path;
use std::process::Stdio;

use serde::Serialize;
use tokio::process::Command;

use crate::error::AppError;
use crate::project::{resolve_safe_path, validate_rel_segments};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    /// Index (staged) status letter: ' ', 'M', 'A', 'D', 'R', 'C', 'U' or '?'.
    pub x: char,
    /// Worktree (unstaged) status letter, same alphabet as `x`.
    pub y: char,
    pub rel_path: String,
    /// Original path for renames/copies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// False when the project folder is not inside a git work tree; the UI
    /// shows an informational empty state instead of an error.
    pub repo: bool,
    /// Current branch name; `None` on a detached HEAD.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<GitFileStatus>,
}

impl Default for GitStatus {
    fn default() -> Self {
        Self {
            repo: false,
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            entries: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub sha: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffFile {
    pub rel_path: String,
    /// Unified patch for this file (`diff --git ...` block, no color codes).
    pub patch: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    pub name: String,
    pub current: bool,
    pub remote: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashEntry {
    /// Position in the stash stack; `0` is the newest entry.
    pub index: usize,
    /// Reflog selector of the entry, e.g. `stash@{0}`.
    pub ref_name: String,
    /// Stash subject line ("WIP on main: abc1234 msg" or "On main: msg").
    pub message: String,
    /// Relative committer date for display, e.g. "2 hours ago".
    pub date: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitInfo {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub author: String,
    pub email: String,
    pub date_ms: i64,
}

/// Runs `git` in the project root and returns stdout on success.
async fn run_git(root: &Path, args: &[&str]) -> Result<String, AppError> {
    let stdout = run_git_raw(root, args).await?;
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

/// Runs `git` in the project root and returns raw stdout bytes. Binary-safe
/// for blob reads; callers check `status` themselves when they need to
/// distinguish expected git failures (missing paths) from real errors.
async fn spawn_git(root: &Path, args: &[&str]) -> Result<std::process::Output, AppError> {
    let mut cmd = Command::new("git");
    cmd.current_dir(root)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Avoid refreshing the index (and touching mtimes) for read-only commands,
    // and never block waiting on interactive terminal prompts.
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    {
        // Prevent Windows GUI builds (`windows_subsystem = "windows"`) from
        // spawning a flashing console window (and exhausting conhost handles)
        // on every child `git` invocation.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.output().await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::Git("git executable not found in PATH".into())
        } else {
            AppError::Git(format!("failed to spawn git: {e}"))
        }
    })
}

/// Like [`spawn_git`], but maps a non-zero exit to an `AppError` carrying
/// git's stderr (or stdout) detail.
async fn run_git_raw(root: &Path, args: &[&str]) -> Result<Vec<u8>, AppError> {
    let output = spawn_git(root, args).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        let verb = args.first().copied().unwrap_or("git");
        return Err(AppError::Git(format!("git {verb}: {detail}")));
    }
    Ok(output.stdout)
}

fn is_not_a_repository(detail: &str) -> bool {
    detail.to_ascii_lowercase().contains("not a git repository")
}

/// Validates project-relative pathspecs before handing them to git.
fn validate_pathspecs(paths: &[String]) -> Result<(), AppError> {
    for path in paths {
        if validate_rel_segments(path)?.is_empty() {
            return Err(AppError::InvalidPath("empty git pathspec".into()));
        }
    }
    Ok(())
}

/// Returns true only when `canonical_root` is itself the top-level directory
/// of a git work tree (subdirectories of a repo return false so pathspecs
/// never disagree with porcelain output).
async fn is_repo_root(canonical_root: &Path) -> Result<bool, AppError> {
    match run_git(canonical_root, &["rev-parse", "--show-toplevel"]).await {
        Ok(toplevel) => {
            let canonical_toplevel = std::fs::canonicalize(toplevel.trim())?;
            Ok(canonical_toplevel == canonical_root)
        }
        Err(AppError::Git(detail)) if is_not_a_repository(&detail) => Ok(false),
        Err(err) => Err(err),
    }
}

/// Validates a branch name before passing it to `git switch`, blocking
/// option-injection prefixes (`-`), special refs (`@`, `HEAD`), and malformed ref characters.
fn validate_branch_name(name: &str) -> Result<&str, AppError> {
    if name.is_empty()
        || name == "@"
        || name == "HEAD"
        || name.ends_with("/HEAD")
        || name.starts_with('-')
        || name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.ends_with(".lock")
        || name.contains("//")
        || name.contains("..")
        || name.contains("@{")
        || name
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
    {
        return Err(AppError::Git(format!("invalid branch name: '{name}'")));
    }
    Ok(name)
}

/// `git status` for the project root. A folder outside any repository — or a
/// folder that is only a subdirectory of one — resolves to
/// `GitStatus { repo: false }` rather than an error.
pub async fn status(canonical_root: &Path) -> Result<GitStatus, AppError> {
    if !is_repo_root(canonical_root).await? {
        return Ok(GitStatus::default());
    }

    let stdout = run_git(
        canonical_root,
        &["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all"],
    )
    .await?;
    Ok(parse_status(&stdout))
}

/// Runs `git <prefix_args...> -- <paths...>` in batches sized to stay well
/// below Windows' 32 KiB `CreateProcess` command-line limit.
async fn run_git_batched(
    root: &Path,
    prefix_args: &[&str],
    paths: &[String],
) -> Result<(), AppError> {
    const MAX_BATCH_BYTES: usize = 16 * 1024;
    let mut idx = 0;
    while idx < paths.len() {
        let mut batch_bytes = 0usize;
        let start = idx;
        while idx < paths.len() {
            let next_len = paths[idx].len() + 3;
            if idx > start && batch_bytes + next_len > MAX_BATCH_BYTES {
                break;
            }
            batch_bytes += next_len;
            idx += 1;
        }
        let mut args: Vec<&str> = prefix_args.to_vec();
        args.push("--");
        args.extend(paths[start..idx].iter().map(String::as_str));
        run_git(root, &args).await?;
    }
    Ok(())
}

pub async fn stage(canonical_root: &Path, paths: &[String]) -> Result<(), AppError> {
    validate_pathspecs(paths)?;
    if paths.is_empty() {
        return Ok(());
    }
    // `git add` stages modifications, additions and deletions alike (git >= 2.0).
    run_git_batched(canonical_root, &["add", "-v"], paths).await
}

pub async fn unstage(canonical_root: &Path, paths: &[String]) -> Result<(), AppError> {
    validate_pathspecs(paths)?;
    if paths.is_empty() {
        return Ok(());
    }
    // On an unborn branch (git init without commits) there is no HEAD to
    // reset to; everything is staged-new there, so `git rm --cached` performs
    // the equivalent unstage. Probe HEAD instead of matching error text,
    // which varies across git versions.
    let has_head = run_git(canonical_root, &["rev-parse", "-q", "--verify", "HEAD"])
        .await
        .is_ok();
    if has_head {
        run_git_batched(canonical_root, &["reset", "-q", "HEAD"], paths).await
    } else {
        run_git_batched(canonical_root, &["rm", "--cached", "-q"], paths).await
    }
}

/// Reverts worktree changes: tracked files are restored from the index,
/// untracked files are deleted. Staged-only changes are intentionally left
/// alone (the UI only offers discard on the unstaged section).
pub async fn discard(
    canonical_root: &Path,
    untracked_paths: &[String],
    tracked_paths: &[String],
) -> Result<(), AppError> {
    validate_pathspecs(untracked_paths)?;
    validate_pathspecs(tracked_paths)?;

    if !untracked_paths.is_empty() {
        run_git_batched(canonical_root, &["clean", "-f", "-q"], untracked_paths).await?;
    }
    if !tracked_paths.is_empty() {
        run_git_batched(canonical_root, &["checkout", "-q"], tracked_paths).await?;
    }
    Ok(())
}

pub async fn commit(canonical_root: &Path, message: &str) -> Result<GitCommitResult, AppError> {
    if message.trim().is_empty() {
        return Err(AppError::Git("commit message must not be empty".into()));
    }
    run_git(canonical_root, &["commit", "-m", message]).await?;
    let sha = run_git(canonical_root, &["rev-parse", "--short", "HEAD"])
        .await?
        .trim()
        .to_string();
    Ok(GitCommitResult { sha })
}

/// Unified per-file patches for the project root. `staged` selects
/// `git diff --staged` (index vs HEAD) over the worktree `git diff`;
/// pathspecs narrow the result and are batched to stay below the Windows
/// command-line length limit. On an unborn branch (no HEAD yet) the staged
/// diff has nothing to compare against and resolves to an empty result.
pub async fn diff(
    canonical_root: &Path,
    staged: bool,
    paths: &[String],
) -> Result<Vec<GitDiffFile>, AppError> {
    if !is_repo_root(canonical_root).await? {
        return Ok(Vec::new());
    }
    validate_pathspecs(paths)?;

    // `git diff --staged` fatals without HEAD; mirror `unstage`'s probe and
    // report "no diffs" so AI generation still works from the file list alone.
    if staged {
        let has_head = run_git(canonical_root, &["rev-parse", "-q", "--verify", "HEAD"])
            .await
            .is_ok();
        if !has_head {
            return Ok(Vec::new());
        }
    }

    let mut base_args: Vec<&str> = vec![
        "-c",
        "core.quotepath=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
    ];
    if staged {
        base_args.push("--staged");
    }

    const MAX_BATCH_BYTES: usize = 16 * 1024;
    let mut outputs: Vec<String> = Vec::new();
    let mut idx = 0usize;
    loop {
        let start = idx;
        let mut batch_bytes = 0usize;
        while idx < paths.len() {
            let next_len = paths[idx].len() + 3;
            if idx > start && batch_bytes + next_len > MAX_BATCH_BYTES {
                break;
            }
            batch_bytes += next_len;
            idx += 1;
        }
        let mut args = base_args.clone();
        args.push("--");
        args.extend(paths[start..idx].iter().map(String::as_str));
        outputs.push(run_git(canonical_root, &args).await?);
        if idx >= paths.len() {
            break;
        }
    }
    let joined = outputs.join("\n");
    // Hard cap before parsing: giant generated-file diffs must not blow up
    // memory (the TS prompt builder applies its own finer-grained budgets).
    const MAX_DIFF_OUTPUT_CHARS: usize = 1024 * 1024;
    let raw = truncate_at_char_boundary(&joined, MAX_DIFF_OUTPUT_CHARS);
    Ok(parse_diff_files(raw))
}

fn truncate_at_char_boundary(s: &str, max_chars: usize) -> &str {
    if s.len() <= max_chars {
        return s;
    }
    let mut end = max_chars;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Base64-encoded raw file bytes for the spreadsheet diff preview; `None`
/// when the path does not exist in the requested snapshot (e.g. a file added
/// in the worktree read at HEAD).
pub async fn read_blob(
    canonical_root: &Path,
    rev: &str,
    rel_path: &str,
) -> Result<Option<String>, AppError> {
    use base64::Engine as _;

    // Hard cap for preview payloads: the bytes are base64-expanded (×1.33) and
    // shipped over IPC, so a giant workbook must fail loudly instead of
    // ballooning memory.
    const MAX_BLOB_BYTES: usize = 32 * 1024 * 1024;

    validate_rel_segments(rel_path)?;
    match rev {
        // Worktree reads are plain file access — they must work outside git
        // repositories too (the sheet preview relies on this).
        "worktree" => {
            // resolve_safe_path canonicalizes the target, so an absent file
            // surfaces as NotFound before the read itself; both mean "no
            // content here" and resolve to None like the git-side misses.
            let path = match resolve_safe_path(canonical_root, rel_path) {
                Ok(path) => path,
                Err(AppError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(None);
                }
                Err(err) => return Err(err),
            };
            // Guard before reading so oversized files never reach memory.
            match tokio::fs::metadata(&path).await {
                Ok(meta) if meta.len() as usize > MAX_BLOB_BYTES => {
                    return Err(AppError::Git(format!(
                        "{rel_path} is too large for the diff preview ({} MiB)",
                        meta.len() as usize / (1024 * 1024)
                    )));
                }
                Ok(_) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(err) => return Err(AppError::Git(format!("stat {rel_path}: {err}"))),
            }
            match tokio::fs::read(&path).await {
                Ok(bytes) => return Ok(Some(base64::engine::general_purpose::STANDARD.encode(&bytes))),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(err) => {
                    return Err(AppError::Git(format!("read {rel_path}: {err}")));
                }
            }
        }
        "HEAD" | ":0" | ":1" | ":2" | ":3" => {
            if !is_repo_root(canonical_root).await? {
                return Ok(None);
            }
        }
        other => return Err(AppError::Git(format!("invalid revision: '{other}'"))),
    }

    // `cat-file blob <rev>:<path>` streams the object bytes verbatim (no diff
    // text conversion), which keeps binary blobs intact end to end. The size
    // cap applies after buffering (git itself buffers the object); the worktree
    // path above stats first to avoid that cost.
    let output = spawn_git(
        canonical_root,
        &[
            "-c",
            "core.quotepath=false",
            "cat-file",
            "blob",
            &format!("{rev}:{rel_path}"),
        ],
    )
    .await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let normalized = stderr.to_ascii_lowercase();
        // Unborn branches ("invalid object name 'HEAD'"), index stages missing
        // during merges ("not at stage 0"-adjacent wording varies) and files
        // absent from the requested snapshot all mean "no content here", not
        // an error.
        if normalized.contains("does not exist")
            || normalized.contains("not a valid object name")
            || normalized.contains("invalid object name")
        {
            return Ok(None);
        }
        return Err(AppError::Git(format!("git cat-file: {}", stderr.trim())));
    }

    if output.stdout.len() > MAX_BLOB_BYTES {
        return Err(AppError::Git(format!(
            "{rel_path} is too large for the diff preview ({} MiB)",
            output.stdout.len() / (1024 * 1024)
        )));
    }
    Ok(Some(base64::engine::general_purpose::STANDARD.encode(&output.stdout)))
}

pub async fn push(canonical_root: &Path) -> Result<(), AppError> {
    if !is_repo_root(canonical_root).await? {
        return Err(AppError::Git("not a git repository".into()));
    }
    let has_upstream = run_git(
        canonical_root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .await
    .is_ok();
    if has_upstream {
        run_git(canonical_root, &["push"]).await?;
        return Ok(());
    }

    if let Ok(branch_raw) = run_git(canonical_root, &["symbolic-ref", "--short", "-q", "HEAD"]).await
    {
        let branch = branch_raw.trim();
        if !branch.is_empty() {
            let remotes_raw = run_git(canonical_root, &["remote"]).await?;
            let remotes: Vec<&str> = remotes_raw
                .lines()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect();
            let target_remote = if remotes.contains(&"origin") {
                Some("origin")
            } else if remotes.len() == 1 {
                Some(remotes[0])
            } else {
                None
            };
            if let Some(remote) = target_remote {
                run_git(canonical_root, &["push", "-u", remote, branch]).await?;
                return Ok(());
            }
        }
    }

    run_git(canonical_root, &["push"]).await?;
    Ok(())
}

pub async fn branches(canonical_root: &Path) -> Result<Vec<GitBranchInfo>, AppError> {
    if !is_repo_root(canonical_root).await? {
        return Ok(Vec::new());
    }
    let stdout = run_git(
        canonical_root,
        &[
            "for-each-ref",
            "--format=%(HEAD)\t%(refname:short)\t%(refname)\t%(upstream:short)",
            "refs/heads",
            "refs/remotes",
        ],
    )
    .await?;
    Ok(parse_branches(&stdout))
}

/// Recent commits on the current branch, newest first. A repository without
/// any commits yet (unborn HEAD) resolves to an empty list rather than an
/// error, mirroring `diff`'s staged handling.
pub async fn log(
    canonical_root: &Path,
    limit: u32,
    skip: u32,
) -> Result<Vec<GitCommitInfo>, AppError> {
    if !is_repo_root(canonical_root).await? {
        return Ok(Vec::new());
    }
    let has_head = run_git(canonical_root, &["rev-parse", "-q", "--verify", "HEAD"])
        .await
        .is_ok();
    if !has_head {
        return Ok(Vec::new());
    }
    let limit_s = limit.to_string();
    let skip_s = skip.to_string();
    // \x1e separates records and \x1f separates fields so multi-line bodies
    // and unusual author names survive verbatim (subject/body are plain text;
    // everything else is single-line by construction).
    let stdout = run_git(
        canonical_root,
        &[
            "log",
            "--date-order",
            "--skip",
            &skip_s,
            "--max-count",
            &limit_s,
            "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1e",
        ],
    )
    .await?;
    Ok(parse_log(&stdout))
}

/// Per-file patches introduced by one commit. Merge commits resolve to an
/// empty result (`git show` renders combined diffs, which the UI does not
/// parse), and a non-repository resolves to an empty result like `diff`.
pub async fn show(
    canonical_root: &Path,
    sha: &str,
    paths: &[String],
) -> Result<Vec<GitDiffFile>, AppError> {
    if !is_repo_root(canonical_root).await? {
        return Ok(Vec::new());
    }
    validate_sha(sha)?;
    validate_pathspecs(paths)?;

    let base_args: Vec<&str> = vec![
        "-c",
        "core.quotepath=false",
        "show",
        "--no-color",
        "--no-ext-diff",
        "--format=",
    ];
    let joined = run_git_rev_batched(canonical_root, base_args, sha, paths).await?;
    const MAX_DIFF_OUTPUT_CHARS: usize = 1024 * 1024;
    let raw = truncate_at_char_boundary(&joined, MAX_DIFF_OUTPUT_CHARS);
    Ok(parse_diff_files(raw))
}

/// Runs `<base_args...> <rev> -- <paths...>` in batches sized to stay well
/// below Windows' 32 KiB `CreateProcess` command-line limit; an empty path
/// list runs once without pathspecs.
async fn run_git_rev_batched(
    root: &Path,
    base_args: Vec<&str>,
    rev: &str,
    paths: &[String],
) -> Result<String, AppError> {
    const MAX_BATCH_BYTES: usize = 16 * 1024;
    let mut outputs: Vec<String> = Vec::new();
    let mut idx = 0usize;
    loop {
        let start = idx;
        let mut batch_bytes = 0usize;
        while idx < paths.len() {
            let next_len = paths[idx].len() + 3;
            if idx > start && batch_bytes + next_len > MAX_BATCH_BYTES {
                break;
            }
            batch_bytes += next_len;
            idx += 1;
        }
        let mut args = base_args.clone();
        args.push(rev);
        args.push("--");
        args.extend(paths[start..idx].iter().map(String::as_str));
        outputs.push(run_git(root, &args).await?);
        if idx >= paths.len() {
            break;
        }
    }
    Ok(outputs.join("\n"))
}

/// Validates a revision before handing it to `git show`, blocking
/// option-injection prefixes and non-hex garbage (the UI only passes SHAs
/// parsed out of `git log`, but the command boundary stays defensive).
fn validate_sha(sha: &str) -> Result<&str, AppError> {
    let ok = (4..=40).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit());
    if !ok {
        return Err(AppError::Git(format!("invalid revision: '{sha}'")));
    }
    Ok(sha)
}

/// Parses `git log --format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1e`.
///
/// Records are separated by \x1e; fields by \x1f. The body is the final field
/// and may span multiple lines (embedded newlines survive), so `splitn(7)`
/// keeps everything after the sixth separator inside the body.
pub fn parse_log(raw: &str) -> Vec<GitCommitInfo> {
    let mut items = Vec::new();
    for record in raw.split('\x1e') {
        let record = record.trim_start_matches(['\n', '\r']);
        if record.trim().is_empty() {
            continue;
        }
        let mut fields = record.splitn(7, '\x1f');
        let sha = fields.next().unwrap_or("").trim().to_string();
        let short_sha = fields.next().unwrap_or("").trim().to_string();
        let author = fields.next().unwrap_or("").trim().to_string();
        let email = fields.next().unwrap_or("").trim().to_string();
        let at = fields.next().unwrap_or("").trim();
        let subject = fields.next().unwrap_or("").trim().to_string();
        let body_raw = fields.next().unwrap_or("").trim().to_string();
        if sha.is_empty() || subject.is_empty() {
            continue;
        }
        items.push(GitCommitInfo {
            date_ms: at.parse::<i64>().unwrap_or(0).saturating_mul(1000),
            sha,
            short_sha,
            subject,
            body: if body_raw.is_empty() { None } else { Some(body_raw) },
            author,
            email,
        });
    }
    items
}

pub async fn checkout_branch(
    canonical_root: &Path,
    name: &str,
    create: bool,
) -> Result<(), AppError> {
    if !is_repo_root(canonical_root).await? {
        return Err(AppError::Git("not a git repository".into()));
    }
    let name = validate_branch_name(name)?;
    run_git(canonical_root, &["check-ref-format", "--branch", name]).await?;

    if create {
        run_git(canonical_root, &["switch", "-c", name]).await?;
        return Ok(());
    }

    let local_ref = format!("refs/heads/{name}");
    let has_local = run_git(canonical_root, &["show-ref", "--verify", "--quiet", &local_ref])
        .await
        .is_ok();
    if has_local {
        run_git(canonical_root, &["switch", name]).await?;
        return Ok(());
    }

    let remote_ref = format!("refs/remotes/{name}");
    let has_remote = run_git(canonical_root, &["show-ref", "--verify", "--quiet", &remote_ref])
        .await
        .is_ok();
    if has_remote {
        if run_git(canonical_root, &["symbolic-ref", "-q", &remote_ref])
            .await
            .is_ok()
        {
            return Err(AppError::Git(format!("cannot checkout symbolic ref: '{name}'")));
        }
        let local_name = name.split_once('/').map(|(_, rest)| rest).unwrap_or(name);
        let tracking_local_ref = format!("refs/heads/{local_name}");
        let has_tracking_local = run_git(
            canonical_root,
            &["show-ref", "--verify", "--quiet", &tracking_local_ref],
        )
        .await
        .is_ok();
        if has_tracking_local {
            run_git(canonical_root, &["switch", local_name]).await?;
        } else {
            run_git(canonical_root, &["switch", "--track", name]).await?;
        }
        return Ok(());
    }

    Err(AppError::Git(format!("branch '{name}' does not exist")))
}

/// Validates an explicit stash message before handing it to `git stash push -m`.
fn sanitize_stash_message(message: &str) -> Result<&str, AppError> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(AppError::Git("stash message must not be empty".into()));
    }
    if trimmed.chars().count() > 200 {
        return Err(AppError::Git("stash message is too long".into()));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(AppError::Git(
            "stash message contains control characters".into(),
        ));
    }
    Ok(trimmed)
}

fn stash_ref_name(index: usize) -> String {
    format!("stash@{{{index}}}")
}

/// Stashes all tracked and untracked changes of the project root
/// (`git stash push --include-untracked`). Like real git, a worktree without
/// any local changes resolves to a no-op ("No local changes to save").
pub async fn stash_all(canonical_root: &Path, message: Option<&str>) -> Result<(), AppError> {
    if !is_repo_root(canonical_root).await? {
        return Err(AppError::Git("not a git repository".into()));
    }
    let mut args: Vec<&str> = vec!["stash", "push", "--include-untracked"];
    let owned_message;
    if let Some(message) = message {
        owned_message = sanitize_stash_message(message)?.to_string();
        args.push("-m");
        args.push(owned_message.as_str());
    }
    run_git(canonical_root, &args).await?;
    Ok(())
}

/// Stashes only the given paths' changes (`git stash push --include-untracked
/// -- <paths>`). All paths must go into one stash entry, so this is a single
/// git invocation rather than a batched one; a row-level action passes 1-2
/// pathspecs, staying far below the Windows command-line limit.
pub async fn stash_paths(canonical_root: &Path, paths: &[String]) -> Result<(), AppError> {
    if !is_repo_root(canonical_root).await? {
        return Err(AppError::Git("not a git repository".into()));
    }
    validate_pathspecs(paths)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["stash", "push", "--include-untracked", "--"];
    args.extend(paths.iter().map(String::as_str));
    run_git(canonical_root, &args).await?;
    Ok(())
}

/// The project's stash stack, newest entry first. A folder outside version
/// control (or a subdirectory of a repo) resolves to an empty list.
pub async fn stash_list(canonical_root: &Path) -> Result<Vec<GitStashEntry>, AppError> {
    if !is_repo_root(canonical_root).await? {
        return Ok(Vec::new());
    }
    let stdout = run_git(
        canonical_root,
        &["stash", "list", "--format=%gd%x1f%gs%x1f%cr"],
    )
    .await?;
    Ok(parse_stash_list(&stdout))
}

/// Applies `stash@{index}` to the worktree without removing the entry
/// (`git stash apply`). On merge conflicts git reports the failure and the
/// stash entry stays untouched; drop it explicitly afterwards if unwanted.
pub async fn stash_restore(canonical_root: &Path, index: usize) -> Result<(), AppError> {
    if !is_repo_root(canonical_root).await? {
        return Err(AppError::Git("not a git repository".into()));
    }
    run_git(canonical_root, &["stash", "apply", &stash_ref_name(index)]).await?;
    Ok(())
}

/// Removes `stash@{index}` without applying it (`git stash drop`).
pub async fn stash_drop(canonical_root: &Path, index: usize) -> Result<(), AppError> {
    if !is_repo_root(canonical_root).await? {
        return Err(AppError::Git("not a git repository".into()));
    }
    run_git(canonical_root, &["stash", "drop", &stash_ref_name(index)]).await?;
    Ok(())
}

/// Parses `git stash list --format=%gd%x1f%gs%x1f%cr` output.
///
/// Each record is one line of ASCII unit-separator (0x1f) fields — a byte
/// that cannot appear in stash subjects — so tabs or newlines inside a
/// message cannot desynchronize the columns. Malformed lines are skipped.
pub fn parse_stash_list(raw: &str) -> Vec<GitStashEntry> {
    let mut items = Vec::new();
    for line in raw.lines() {
        let mut parts = line.splitn(3, '\u{1f}');
        let (Some(ref_name), Some(message), Some(date)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let index = ref_name
            .strip_prefix("stash@{")
            .and_then(|rest| rest.strip_suffix('}'))
            .and_then(|digits| digits.parse::<usize>().ok());
        let Some(index) = index else { continue };
        items.push(GitStashEntry {
            index,
            ref_name: ref_name.to_string(),
            message: message.to_string(),
            date: date.trim().to_string(),
        });
    }
    items.sort_by_key(|entry| entry.index);
    items
}

pub fn parse_branches(raw: &str) -> Vec<GitBranchInfo> {
    let mut items = Vec::new();
    for line in raw.lines() {
        let mut parts = line.splitn(4, '\t');
        let head = parts.next().unwrap_or("");
        let short_name = parts.next().unwrap_or("").trim();
        let full_ref = parts.next().unwrap_or("").trim();
        let upstream = parts.next().unwrap_or("").trim();
        if short_name.is_empty() || full_ref.ends_with("/HEAD") {
            continue;
        }
        items.push(GitBranchInfo {
            name: short_name.to_string(),
            current: head.trim() == "*",
            remote: full_ref.starts_with("refs/remotes/"),
            upstream: if upstream.is_empty() {
                None
            } else {
                Some(upstream.to_string())
            },
        });
    }
    items.sort_by(|a, b| {
        b.current
            .cmp(&a.current)
            .then_with(|| a.remote.cmp(&b.remote))
            .then_with(|| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    items
}

/// Parses raw `git diff` output into per-file patch blocks.
///
/// Each block starts at a `diff --git` line; the project-relative path prefers
/// the `+++ b/<path>` header and falls back to the `b/` side of the
/// `diff --git` line (covers deleted files whose `+++` is `/dev/null` and
/// rename-only entries without any `---`/`+++` headers). Content outside any
/// `diff --git` block is ignored.
pub fn parse_diff_files(raw: &str) -> Vec<GitDiffFile> {
    /// Extracts the new path from `diff --git a/<old> b/<new>` (quoted or not).
    fn fallback_rel_path(diff_line: &str) -> Option<String> {
        let rest = diff_line.strip_prefix("diff --git ")?;
        if let Some(quoted) = rest.strip_prefix('"') {
            // Form: "a/<old>" "b/<new>" — locate the boundary between quotes.
            let end = quoted.find("\" \"")?;
            let new_part = quoted
                .get(end + 3..)?
                .strip_prefix('"')?
                .strip_suffix('"')?;
            return new_part.strip_prefix("b/").map(str::to_string);
        }
        // Unquoted paths may contain spaces; split at the last ` b/` boundary.
        let idx = rest.rfind(" b/")?;
        Some(rest[idx + 3..].to_string())
    }

    /// `+++ b/<path>` header path; None for `/dev/null` (deleted files).
    fn header_rel_path(line: &str) -> Option<String> {
        let rest = line.strip_prefix("+++ ")?;
        if rest == "/dev/null" {
            return None;
        }
        let unquoted = rest
            .strip_prefix('"')
            .and_then(|q| q.strip_suffix('"'))
            .unwrap_or(rest);
        unquoted.strip_prefix("b/").map(str::to_string)
    }

    let mut files: Vec<GitDiffFile> = Vec::new();
    // (fallback path from `diff --git`, patch lines so far)
    let mut current: Option<(String, Vec<&str>)> = None;
    for line in raw.lines() {
        if line.starts_with("diff --git ") {
            if let Some((rel_path, lines)) = current.take() {
                if !rel_path.is_empty() && !lines.is_empty() {
                    files.push(GitDiffFile {
                        rel_path,
                        patch: lines.join("\n"),
                    });
                }
            }
            let fallback = fallback_rel_path(line).unwrap_or_default();
            current = Some((fallback, vec![line]));
            continue;
        }
        if let Some((rel_path, lines)) = current.as_mut() {
            if let Some(header_path) = header_rel_path(line) {
                *rel_path = header_path;
            }
            lines.push(line);
        }
    }
    if let Some((rel_path, lines)) = current.take() {
        if !rel_path.is_empty() && !lines.is_empty() {
            files.push(GitDiffFile {
                rel_path,
                patch: lines.join("\n"),
            });
        }
    }
    files
}

/// Parses `git status --porcelain=v1 -z -b` output.
///
/// Record layout: one branch header (`## ...`), then per-entry records of
/// `XY path` — with an extra record holding the original path after
/// renames/copies. `-z` NUL-terminates every record so file names containing
/// spaces, quotes or non-ASCII characters survive verbatim.
pub fn parse_status(raw: &str) -> GitStatus {
    let mut result = GitStatus {
        repo: true,
        ..GitStatus::default()
    };

    let mut records = raw.split('\0').filter(|r| !r.is_empty());

    let Some(header) = records.next() else {
        return result;
    };
    if let Some(header) = header.strip_prefix("## ") {
        if let Some(branch) = header.strip_prefix("No commits yet on ") {
            // Unborn branch: no HEAD commit exists yet.
            result.branch = Some(branch.to_string());
        } else if header.starts_with("HEAD (no branch)") {
            // Detached HEAD.
            result.branch = None;
        } else {
            let (names, tracking) = match header.split_once(" [") {
                Some((names, tracking)) => (names, Some(tracking)),
                None => (header, None),
            };
            if let Some((branch, upstream)) = names.split_once("...") {
                result.branch = Some(branch.to_string());
                result.upstream = Some(upstream.to_string());
            } else {
                result.branch = Some(names.to_string());
            }
            if let Some(tracking) = tracking {
                let tracking = tracking.trim_end_matches(']');
                for part in tracking.split(',') {
                    let part = part.trim();
                    if let Some(ahead) = part.strip_prefix("ahead ") {
                        result.ahead = ahead.trim().parse().unwrap_or(0);
                    } else if let Some(behind) = part.strip_prefix("behind ") {
                        result.behind = behind.trim().parse().unwrap_or(0);
                    }
                    // "[gone]" (upstream deleted) is ignored on purpose.
                }
            }
        }
    }

    while let Some(record) = records.next() {
        // Record shape is `XY_ path` (two letters, one separator space, path;
        // minimum 4 bytes). `get` also guards against slicing through a
        // multi-byte character on malformed input.
        let bytes = record.as_bytes();
        if bytes.len() < 4 || bytes[2] != b' ' {
            continue;
        }
        let Some(rel_path) = record.get(3..) else {
            continue;
        };
        if rel_path.is_empty() {
            continue;
        }
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let orig_path = if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            records.next().map(|orig| orig.to_string())
        } else {
            None
        };
        result.entries.push(GitFileStatus {
            x,
            y,
            rel_path: rel_path.to_string(),
            orig_path,
        });
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(status: &GitStatus, index: usize) -> (char, char, &str) {
        let e = &status.entries[index];
        (e.x, e.y, e.rel_path.as_str())
    }

    #[test]
    fn parses_branch_upstream_and_entries() {
        let raw = "## main...origin/main [ahead 1, behind 2]\0 M src/a.ts\0?? notes.txt\0";
        let status = parse_status(raw);
        assert!(status.repo);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!(status.ahead, 1);
        assert_eq!(status.behind, 2);
        assert_eq!(entry(&status, 0), (' ', 'M', "src/a.ts"));
        assert_eq!(entry(&status, 1), ('?', '?', "notes.txt"));
    }

    #[test]
    fn parses_staged_renamed_entry_with_orig_path() {
        let raw = "## dev\0R  new-name.ts\0old-name.ts\0";
        let status = parse_status(raw);
        assert_eq!(status.branch.as_deref(), Some("dev"));
        assert_eq!(status.upstream, None);
        assert_eq!(status.entries.len(), 1);
        assert_eq!(entry(&status, 0), ('R', ' ', "new-name.ts"));
        assert_eq!(
            status.entries[0].orig_path.as_deref(),
            Some("old-name.ts")
        );
    }

    #[test]
    fn parses_unborn_branch_and_detached_head() {
        let raw = "## No commits yet on main\0A  init.ts\0";
        let status = parse_status(raw);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream, None);
        assert_eq!(entry(&status, 0), ('A', ' ', "init.ts"));

        let raw = "## HEAD (no branch)\0 M f.txt\0";
        let status = parse_status(raw);
        assert_eq!(status.branch, None);
        assert_eq!(status.entries.len(), 1);
    }

    #[test]
    fn parses_branch_without_upstream_and_ahead_only() {
        let raw = "## feature/x\0";
        let status = parse_status(raw);
        assert_eq!(status.branch.as_deref(), Some("feature/x"));
        assert_eq!(status.upstream, None);

        let raw = "## main...origin/main [ahead 3]\0";
        let status = parse_status(raw);
        assert_eq!(status.ahead, 3);
        assert_eq!(status.behind, 0);

        let raw = "## main...origin/main [gone]\0";
        let status = parse_status(raw);
        assert_eq!(status.ahead, 0);
        assert_eq!(status.behind, 0);
    }

    #[test]
    fn empty_output_is_clean_repo() {
        let status = parse_status("## main\0");
        assert!(status.repo);
        assert_eq!(status.entries.len(), 0);

        let status = parse_status("");
        assert!(status.repo);
        assert_eq!(status.entries.len(), 0);
        assert_eq!(status.branch, None);
    }

    #[test]
    fn keeps_spaces_and_unicode_in_paths() {
        let raw = "## main\0 M \u{4e2d}\u{6587} file \u{2013} name.md\0";
        let status = parse_status(raw);
        assert_eq!(entry(&status, 0), (' ', 'M', "\u{4e2d}\u{6587} file \u{2013} name.md"));
    }

    #[test]
    fn parses_log_records_with_body_and_timestamps() {
        let raw = concat!(
            "11111112222222333333444444555555666666777\x1f1111111\x1fAlice A\x1f",
            "alice@example.com\x1f1700000000\x1fsubject one\x1fbody line 1\nbody line 2\x1e",
            "\n222222233333334444445555556666667777777\x1f2222222\x1fBob B\x1f",
            "bob@example.com\x1f1700000060\x1fsubject two\x1f\x1e"
        );
        let items = parse_log(raw);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].sha, "11111112222222333333444444555555666666777");
        assert_eq!(items[0].short_sha, "1111111");
        assert_eq!(items[0].author, "Alice A");
        assert_eq!(items[0].email, "alice@example.com");
        assert_eq!(items[0].date_ms, 1_700_000_000_000);
        assert_eq!(items[0].subject, "subject one");
        assert_eq!(items[0].body.as_deref(), Some("body line 1\nbody line 2"));
        // Empty body resolves to None; leading newline between records is skipped.
        assert_eq!(items[1].subject, "subject two");
        assert_eq!(items[1].body, None);
        assert_eq!(items[1].date_ms, 1_700_000_060_000);
    }

    #[test]
    fn parses_log_ignores_empty_records_and_garbage() {
        assert!(parse_log("").is_empty());
        assert!(parse_log("\x1e\n\x1e").is_empty());
        // Record without sha or subject is dropped rather than misparsed.
        let raw = "\x1f\x1f\x1f\x1fnot-a-sha\x1f\x1e";
        assert!(parse_log(raw).is_empty());
    }

    #[test]
    fn validates_revisions() {
        assert!(validate_sha("1a2b3c4").is_ok());
        assert!(validate_sha(&"a".repeat(40)).is_ok());
        assert!(validate_sha("abc").is_err());
        assert!(validate_sha(&"a".repeat(41)).is_err());
        assert!(validate_sha("--exec=rm").is_err());
        assert!(validate_sha("HEAD").is_err());
        assert!(validate_sha("1a2b 3c4").is_err());
        assert!(validate_sha("").is_err());
    }

    #[test]
    fn parses_diff_blocks_into_per_file_patches() {
        let raw = concat!(
            "diff --git a/src/a.ts b/src/a.ts\n",
            "index 1111111..2222222 100644\n",
            "--- a/src/a.ts\n",
            "+++ b/src/a.ts\n",
            "@@ -1,1 +1,1 @@\n",
            "-old\n",
            "+new\n",
            "diff --git a/src/b.py b/src/b.py\n",
            "index 3333333..4444444 100644\n",
            "--- a/src/b.py\n",
            "+++ b/src/b.py\n",
            "@@ -1,1 +1,2 @@\n",
            "-keep\n",
            "+added one\n",
            "+added two\n",
        );
        let files = parse_diff_files(raw);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].rel_path, "src/a.ts");
        assert!(files[0].patch.starts_with("diff --git a/src/a.ts b/src/a.ts\n"));
        assert!(files[0].patch.ends_with("-old\n+new"));
        assert_eq!(files[1].rel_path, "src/b.py");
        assert!(files[1].patch.contains("+added two"));
    }

    #[test]
    fn parses_diff_new_deleted_and_rename_entries() {
        let raw = concat!(
            "diff --git a/new.txt b/new.txt\n",
            "new file mode 100644\n",
            "--- /dev/null\n",
            "+++ b/new.txt\n",
            "@@ -0,0 +1 @@\n",
            "+hello\n",
            "diff --git a/gone.txt b/gone.txt\n",
            "deleted file mode 100644\n",
            "--- a/gone.txt\n",
            "+++ /dev/null\n",
            "@@ -1 +0,0 @@\n",
            "-bye\n",
            "diff --git a/before.txt b/after.txt\n",
            "similarity index 100%\n",
            "rename from before.txt\n",
            "rename to after.txt\n",
        );
        let files = parse_diff_files(raw);
        let paths: Vec<&str> = files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(paths, ["new.txt", "gone.txt", "after.txt"]);
        // Deleted file falls back to the `diff --git` b-side for its path.
        assert!(files[1].patch.contains("+++ /dev/null"));
        // Rename-only entries carry headers but no hunks.
        assert!(files[2].patch.contains("rename to after.txt"));
    }

    #[test]
    fn parses_diff_quoted_paths_and_ignores_leading_noise() {
        let raw = concat!(
            "warning: some git notice\n",
            "diff --git \"a/\\346\\226\\207 file.txt\" \"b/\\346\\226\\207 file.txt\"\n",
            "index 1111111..2222222 100644\n",
            "--- \"a/\\346\\226\\207 file.txt\"\n",
            "+++ \"b/\\346\\226\\207 file.txt\"\n",
            "@@ -1 +1 @@\n",
            "-x\n",
            "+y\n",
        );
        let files = parse_diff_files(raw);
        assert_eq!(files.len(), 1);
        // Quote-escaped header (core.quotepath=true) keeps the quoted spelling;
        // the runtime command disables quotepath so this is a lossless fallback.
        assert_eq!(files[0].rel_path, "\\346\\226\\207 file.txt");
    }

    #[test]
    fn rejects_empty_and_root_pathspecs() {
        assert!(validate_pathspecs(&["".into()]).is_err());
        assert!(validate_pathspecs(&["/".into()]).is_err());
        assert!(validate_pathspecs(&["src/app.ts".into()]).is_ok());
    }

    #[test]
    fn parses_stash_list_entries() {
        let raw = concat!(
            "stash@{0}\u{1f}WIP on main: abc1234 demo\u{1f}2 hours ago\n",
            "stash@{1}\u{1f}On dev: manual save\u{1f}3 days ago\n",
        );
        let items = parse_stash_list(raw);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].index, 0);
        assert_eq!(items[0].ref_name, "stash@{0}");
        assert_eq!(items[0].message, "WIP on main: abc1234 demo");
        assert_eq!(items[0].date, "2 hours ago");
        assert_eq!(items[1].index, 1);
        assert_eq!(items[1].message, "On dev: manual save");
        assert_eq!(items[1].date, "3 days ago");

        // Malformed records are skipped instead of poisoning the stack.
        assert!(parse_stash_list("not a stash line\n\nstash@{x}\u{1f}msg\u{1f}now").is_empty());
    }

    #[test]
    fn validates_stash_messages() {
        assert!(sanitize_stash_message("  fix bug  ").is_ok());
        assert!(sanitize_stash_message("   ").is_err());
        assert!(sanitize_stash_message("").is_err());
        assert!(sanitize_stash_message("a\u{0007}b").is_err());
        assert!(sanitize_stash_message(&"x".repeat(201)).is_err());
        assert!(sanitize_stash_message(&"x".repeat(200)).is_ok());
    }

    #[test]
    fn validates_branch_names_and_parses_refs() {
        assert!(validate_branch_name("main").is_ok());
        assert!(validate_branch_name("feat/git-panel").is_ok());
        assert!(validate_branch_name("").is_err());
        assert!(validate_branch_name("@").is_err());
        assert!(validate_branch_name("HEAD").is_err());
        assert!(validate_branch_name("origin/HEAD").is_err());
        assert!(validate_branch_name("-f").is_err());
        assert!(validate_branch_name("--orphan").is_err());
        assert!(validate_branch_name("a b").is_err());
        assert!(validate_branch_name("a..b").is_err());
        assert!(validate_branch_name("branch.lock").is_err());

        let raw = " \tfeat/z\trefs/heads/feat/z\t\n\
                   *\tmain\trefs/heads/main\torigin/main\n\
                    \torigin/HEAD\trefs/remotes/origin/HEAD\t\n\
                    \torigin/main\trefs/remotes/origin/main\t\n";
        let list = parse_branches(raw);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].name, "main");
        assert!(list[0].current);
        assert_eq!(list[0].upstream.as_deref(), Some("origin/main"));
        assert_eq!(list[1].name, "feat/z");
        assert!(!list[1].remote);
        assert_eq!(list[2].name, "origin/main");
        assert!(list[2].remote);
    }
}

/// Integration tests against a real git repository in a tempdir.
#[cfg(test)]
mod repo_tests {
    use super::*;
    use tempfile::tempdir;

    async fn git_ok(root: &Path, args: &[&str]) {
        run_git(root, args).await.unwrap();
    }

    async fn status_letters(root: &Path) -> Vec<(char, char, String)> {
        status(root)
            .await
            .unwrap()
            .entries
            .into_iter()
            .map(|e| (e.x, e.y, e.rel_path))
            .collect()
    }

    #[tokio::test]
    async fn unstages_on_unborn_branch_without_head() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        git_ok(&root, &["init", "-q"]).await;
        std::fs::write(root.join("a.txt"), "hello").unwrap();

        // Staged diff has no HEAD to compare against: empty result, no error.
        git_ok(&root, &["add", "--", "a.txt"]).await;
        assert_eq!(status_letters(&root).await, vec![('A', ' ', "a.txt".into())]);
        assert!(diff(&root, true, &[]).await.unwrap().is_empty());
        assert!(diff(&root, false, &[]).await.unwrap().is_empty());

        unstage(&root, &["a.txt".to_string()]).await.unwrap();
        assert_eq!(status_letters(&root).await, vec![('?', '?', "a.txt".into())]);
    }

    #[tokio::test]
    async fn unstages_against_head_and_handles_subdirectory_open() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        git_ok(&root, &["init", "-q"]).await;
        git_ok(&root, &["config", "user.email", "test@example.com"]).await;
        git_ok(&root, &["config", "user.name", "Test"]).await;
        std::fs::write(root.join("a.txt"), "one").unwrap();
        git_ok(&root, &["add", "--", "a.txt"]).await;
        git_ok(&root, &["commit", "-q", "-m", "init"]).await;

        // With HEAD: unstaging restores the worktree modification.
        std::fs::write(root.join("a.txt"), "two").unwrap();
        git_ok(&root, &["add", "--", "a.txt"]).await;
        assert_eq!(status_letters(&root).await, vec![('M', ' ', "a.txt".into())]);
        unstage(&root, &["a.txt".to_string()]).await.unwrap();
        assert_eq!(status_letters(&root).await, vec![(' ', 'M', "a.txt".into())]);

        // Opening a subdirectory of the repo reports "not a repository"
        // instead of serving paths relative to a different root.
        let sub = root.join("sub");
        std::fs::create_dir(&sub).unwrap();
        let sub_root = std::fs::canonicalize(&sub).unwrap();
        let sub_status = status(&sub_root).await.unwrap();
        assert!(!sub_status.repo);
        assert!(sub_status.entries.is_empty());
    }

    #[tokio::test]
    async fn stages_commits_and_discards_in_real_repo() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        git_ok(&root, &["init", "-q"]).await;
        git_ok(&root, &["config", "user.email", "test@example.com"]).await;
        git_ok(&root, &["config", "user.name", "Test"]).await;
        std::fs::write(root.join("a.txt"), "one").unwrap();
        git_ok(&root, &["add", "--", "a.txt"]).await;
        git_ok(&root, &["commit", "-q", "-m", "init"]).await;

        std::fs::write(root.join("a.txt"), "two").unwrap();
        std::fs::write(root.join("b.txt"), "new").unwrap();

        stage(&root, &["a.txt".to_string()]).await.unwrap();
        let letters = status_letters(&root).await;
        assert!(letters.contains(&('M', ' ', "a.txt".into())));
        assert!(letters.contains(&('?', '?', "b.txt".into())));

        // Commit the staged modification, leaving the untracked file alone.
        let result = commit(&root, "second").await.unwrap();
        assert!(!result.sha.is_empty());
        assert_eq!(
            status_letters(&root).await,
            vec![('?', '?', "b.txt".into())]
        );

        // Discard: untracked deleted; tracked restored from HEAD via the
        // index, which leaves staged-only changes untouched.
        discard(&root, &["b.txt".to_string()], &[]).await.unwrap();
        assert!(!root.join("b.txt").exists());
        std::fs::write(root.join("a.txt"), "three").unwrap();
        discard(&root, &[], &["a.txt".to_string()]).await.unwrap();
        assert_eq!(status_letters(&root).await, Vec::<(char, char, String)>::new());
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "two");
    }

    #[tokio::test]
    async fn stages_and_unstages_multiple_files_and_renames() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        git_ok(&root, &["init", "-q"]).await;
        git_ok(&root, &["config", "user.email", "test@example.com"]).await;
        git_ok(&root, &["config", "user.name", "Test"]).await;
        std::fs::write(root.join("a.txt"), "one").unwrap();
        std::fs::write(root.join("old.txt"), "rename me").unwrap();
        git_ok(&root, &["add", "--", "a.txt", "old.txt"]).await;
        git_ok(&root, &["commit", "-q", "-m", "init"]).await;

        std::fs::write(root.join("a.txt"), "two").unwrap();
        std::fs::write(root.join("b.txt"), "new").unwrap();
        git_ok(&root, &["mv", "old.txt", "new.txt"]).await;

        // Stage all non-staged changes at once.
        stage(&root, &["a.txt".into(), "b.txt".into()])
            .await
            .unwrap();
        let letters = status_letters(&root).await;
        assert!(letters.contains(&('M', ' ', "a.txt".into())));
        assert!(letters.contains(&('A', ' ', "b.txt".into())));
        assert!(letters.contains(&('R', ' ', "new.txt".into())));

        // Unstage all staged changes at once (including rename's orig_path).
        unstage(
            &root,
            &[
                "a.txt".into(),
                "b.txt".into(),
                "new.txt".into(),
                "old.txt".into(),
            ],
        )
        .await
        .unwrap();
        let letters = status_letters(&root).await;
        assert!(letters.contains(&(' ', 'M', "a.txt".into())));
        assert!(letters.contains(&('?', '?', "b.txt".into())));
        assert!(letters.contains(&(' ', 'D', "old.txt".into())));
        assert!(letters.contains(&('?', '?', "new.txt".into())));
    }

    #[tokio::test]
    async fn diffs_staged_and_worktree_changes_with_path_filter() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        git_ok(&root, &["init", "-q"]).await;
        git_ok(&root, &["config", "user.email", "test@example.com"]).await;
        git_ok(&root, &["config", "user.name", "Test"]).await;
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        std::fs::write(root.join("b.txt"), "keep\n").unwrap();
        git_ok(&root, &["add", "--", "a.txt", "b.txt"]).await;
        git_ok(&root, &["commit", "-q", "-m", "init"]).await;

        // Clean tree: no diffs on either side.
        assert!(diff(&root, true, &[]).await.unwrap().is_empty());
        assert!(diff(&root, false, &[]).await.unwrap().is_empty());

        // Stage a.txt's edit, leave b.txt edited in the worktree only.
        std::fs::write(root.join("a.txt"), "one two\n").unwrap();
        std::fs::write(root.join("b.txt"), "keep\nchanged\n").unwrap();
        stage(&root, &["a.txt".into()]).await.unwrap();

        let staged = diff(&root, true, &[]).await.unwrap();
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].rel_path, "a.txt");
        assert!(staged[0].patch.contains("+one two"));

        let worktree = diff(&root, false, &[]).await.unwrap();
        let paths: Vec<&str> = worktree.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(paths, ["b.txt"]);
        assert!(worktree[0].patch.contains("+changed"));

        // Path filter narrows the result; unknown path yields nothing.
        let filtered = diff(&root, true, &["a.txt".into()]).await.unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].rel_path, "a.txt");
        assert!(diff(&root, true, &["missing.txt".into()])
            .await
            .unwrap()
            .is_empty());
        assert!(diff(&root, true, &["".into()]).await.is_err());
    }

    #[tokio::test]
    async fn reads_worktree_blobs_outside_git_repositories() {
        use base64::Engine as _;

        // No `git init`: the sheet preview must still read plain files.
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(root.join("book.xlsx"), b"plain bytes").unwrap();
        let blob = read_blob(&root, "worktree", "book.xlsx").await.unwrap().unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD.decode(&blob).unwrap(),
            b"plain bytes"
        );
    }

    #[tokio::test]
    async fn reads_blobs_from_head_index_and_worktree() {
        use base64::Engine as _;

        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        git_ok(&root, &["init", "-q"]).await;
        git_ok(&root, &["config", "user.email", "test@example.com"]).await;
        git_ok(&root, &["config", "user.name", "Test"]).await;

        // The committed blob contains binary-safe bytes (0xFF must survive).
        let committed: &[u8] = b"\x00\xFFbinarypayload";
        std::fs::write(root.join("book.xlsx"), committed).unwrap();
        git_ok(&root, &["add", "--", "book.xlsx"]).await;
        git_ok(&root, &["commit", "-q", "-m", "init"]).await;

        let head = read_blob(&root, "HEAD", "book.xlsx").await.unwrap().unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD.decode(&head).unwrap(),
            committed
        );

        // Staged (index) content differs from HEAD after staging a change.
        std::fs::write(root.join("book.xlsx"), b"worktree bytes").unwrap();
        git_ok(&root, &["add", "--", "book.xlsx"]).await;
        let index = read_blob(&root, ":0", "book.xlsx").await.unwrap().unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD.decode(&index).unwrap(),
            b"worktree bytes"
        );

        let worktree = read_blob(&root, "worktree", "book.xlsx")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD.decode(&worktree).unwrap(),
            b"worktree bytes"
        );

        // A path absent from a snapshot resolves to None, not an error.
        assert!(read_blob(&root, "HEAD", "missing.xlsx").await.unwrap().is_none());
        assert!(read_blob(&root, ":0", "missing.xlsx").await.unwrap().is_none());
        assert!(read_blob(&root, "worktree", "missing.xlsx").await.unwrap().is_none());

        // The revision allow-list rejects anything else.
        let err = read_blob(&root, "HEAD~1", "book.xlsx").await.unwrap_err();
        assert!(err.to_string().contains("invalid revision"));
    }

    #[tokio::test]
    async fn lists_switches_and_creates_branches_in_real_repo() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        git_ok(&root, &["init", "-q", "-b", "main"]).await;
        git_ok(&root, &["config", "user.email", "test@example.com"]).await;
        git_ok(&root, &["config", "user.name", "Test"]).await;
        std::fs::write(root.join("a.txt"), "one").unwrap();
        git_ok(&root, &["add", "--", "a.txt"]).await;
        git_ok(&root, &["commit", "-q", "-m", "init"]).await;

        checkout_branch(&root, "feat/test", true).await.unwrap();
        let st = status(&root).await.unwrap();
        assert_eq!(st.branch.as_deref(), Some("feat/test"));

        let list = branches(&root).await.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "feat/test");
        assert!(list[0].current);
        assert_eq!(list[1].name, "main");
        assert!(!list[1].current);

        checkout_branch(&root, "main", false).await.unwrap();
        let st = status(&root).await.unwrap();
        assert_eq!(st.branch.as_deref(), Some("main"));

        // Passing a tracked file path that is not a branch must error without
        // touching or discarding local worktree edits.
        std::fs::write(root.join("a.txt"), "dirty").unwrap();
        assert!(checkout_branch(&root, "a.txt", false).await.is_err());
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "dirty");

        // Switching to a local branch that shares a name with a file succeeds.
        checkout_branch(&root, "a.txt", true).await.unwrap();
        assert_eq!(status(&root).await.unwrap().branch.as_deref(), Some("a.txt"));
        checkout_branch(&root, "main", false).await.unwrap();
        assert_eq!(status(&root).await.unwrap().branch.as_deref(), Some("main"));

        // Subdirectory inside repo cannot list or switch branches.
        let sub = root.join("sub");
        std::fs::create_dir(&sub).unwrap();
        let sub_root = std::fs::canonicalize(&sub).unwrap();
        assert!(branches(&sub_root).await.unwrap().is_empty());
        assert!(checkout_branch(&sub_root, "main", false).await.is_err());

        assert!(checkout_branch(&root, "--orphan", true).await.is_err());
        assert!(checkout_branch(&root, "origin/HEAD", false).await.is_err());
        assert!(checkout_branch(&root, "@", false).await.is_err());
    }

    #[tokio::test]
    async fn stashes_restores_and_drops_entries() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        git_ok(&root, &["init", "-q", "-b", "main"]).await;
        git_ok(&root, &["config", "user.email", "test@example.com"]).await;
        git_ok(&root, &["config", "user.name", "Test"]).await;
        std::fs::write(root.join("a.txt"), "one").unwrap();
        git_ok(&root, &["add", "--", "a.txt"]).await;
        git_ok(&root, &["commit", "-q", "-m", "init"]).await;

        // Stash all sweeps tracked modifications and untracked files alike.
        std::fs::write(root.join("a.txt"), "two").unwrap();
        std::fs::write(root.join("b.txt"), "new").unwrap();
        stash_all(&root, None).await.unwrap();
        assert_eq!(status_letters(&root).await, Vec::<(char, char, String)>::new());
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "one");
        assert!(!root.join("b.txt").exists());

        let list = stash_list(&root).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].index, 0);
        assert_eq!(list[0].ref_name, "stash@{0}");
        assert!(list[0].message.starts_with("WIP on "), "{}", list[0].message);
        assert!(!list[0].date.is_empty());

        // Restore (apply) reinstates the worktree state and keeps the entry.
        stash_restore(&root, 0).await.unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "two");
        assert!(root.join("b.txt").exists());
        assert_eq!(stash_list(&root).await.unwrap().len(), 1);

        // Dropping the restored entry clears the stack again.
        stash_drop(&root, 0).await.unwrap();
        assert!(stash_list(&root).await.unwrap().is_empty());

        // A named message round-trips through the stash subject; the worktree
        // resets to HEAD ("one"), while the stashed "three" state is kept.
        std::fs::write(root.join("a.txt"), "three").unwrap();
        stash_all(&root, Some("demo stash")).await.unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "one");
        let list = stash_list(&root).await.unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].message.contains("demo stash"), "{}", list[0].message);

        // Dropping removes the entry without touching the worktree.
        stash_drop(&root, 0).await.unwrap();
        assert!(stash_list(&root).await.unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "one");

        assert!(stash_all(&root, Some("   ")).await.is_err());
        assert!(stash_all(&root, Some("bad\u{7}msg")).await.is_err());
    }

    #[tokio::test]
    async fn stashes_only_selected_paths() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        git_ok(&root, &["init", "-q", "-b", "main"]).await;
        git_ok(&root, &["config", "user.email", "test@example.com"]).await;
        git_ok(&root, &["config", "user.name", "Test"]).await;
        std::fs::write(root.join("a.txt"), "one").unwrap();
        std::fs::write(root.join("b.txt"), "keep").unwrap();
        git_ok(&root, &["add", "--", "a.txt", "b.txt"]).await;
        git_ok(&root, &["commit", "-q", "-m", "init"]).await;

        // Pathspec stash takes only the requested file into the stash.
        std::fs::write(root.join("a.txt"), "two").unwrap();
        std::fs::write(root.join("b.txt"), "changed").unwrap();
        std::fs::write(root.join("c.txt"), "untracked").unwrap();
        stash_paths(&root, &["a.txt".into(), "c.txt".into()])
            .await
            .unwrap();
        let letters = status_letters(&root).await;
        assert_eq!(letters, vec![(' ', 'M', "b.txt".into())]);
        assert!(!root.join("c.txt").exists());
        assert_eq!(stash_list(&root).await.unwrap().len(), 1);

        // Pathspecs are validated before reaching git.
        assert!(stash_paths(&root, &["../escape.txt".into()]).await.is_err());
        assert!(stash_paths(&root, &[]).await.is_ok());
    }

    #[tokio::test]
    async fn stash_ops_outside_repository_error() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(root.join("plain.txt"), "no git here").unwrap();

        assert!(stash_list(&root).await.unwrap().is_empty());
        assert!(stash_all(&root, None).await.is_err());
        assert!(stash_all(&root, Some("msg")).await.is_err());
        assert!(stash_paths(&root, &["a.txt".into()]).await.is_err());
        assert!(stash_restore(&root, 0).await.is_err());
        assert!(stash_drop(&root, 0).await.is_err());
    }

    #[tokio::test]
    async fn folder_outside_repository_reports_not_a_repo() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(root.join("plain.txt"), "no git here").unwrap();

        let st = status(&root).await.unwrap();
        assert!(!st.repo);
        assert!(diff(&root, true, &[]).await.unwrap().is_empty());
        assert!(diff(&root, false, &[]).await.unwrap().is_empty());
        assert_eq!(st.branch, None);
        assert!(st.entries.is_empty());
        assert!(push(&root).await.is_err());
    }

    #[tokio::test]
    async fn pushes_commits_and_sets_upstream_on_new_branch() {
        let remote_dir = tempdir().unwrap();
        let remote_root = std::fs::canonicalize(remote_dir.path()).unwrap();
        git_ok(&remote_root, &["init", "-q", "--bare"]).await;

        let local_dir = tempdir().unwrap();
        let local_root = std::fs::canonicalize(local_dir.path()).unwrap();
        git_ok(&local_root, &["init", "-q", "-b", "main"]).await;
        git_ok(&local_root, &["config", "user.email", "test@example.com"]).await;
        git_ok(&local_root, &["config", "user.name", "Test"]).await;
        let remote_url = remote_dir.path().to_string_lossy().into_owned();
        git_ok(&local_root, &["remote", "add", "origin", &remote_url]).await;

        std::fs::write(local_root.join("a.txt"), "one").unwrap();
        git_ok(&local_root, &["add", "--", "a.txt"]).await;
        commit(&local_root, "init").await.unwrap();

        // First push without upstream auto-sets origin/main.
        push(&local_root).await.unwrap();
        let st = status(&local_root).await.unwrap();
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!(st.ahead, 0);

        // Subsequent commit & push updates the existing upstream.
        std::fs::write(local_root.join("a.txt"), "two").unwrap();
        git_ok(&local_root, &["add", "--", "a.txt"]).await;
        commit(&local_root, "second").await.unwrap();
        assert_eq!(status(&local_root).await.unwrap().ahead, 1);

        push(&local_root).await.unwrap();
        assert_eq!(status(&local_root).await.unwrap().ahead, 0);
    }

    #[tokio::test]
    async fn logs_and_shows_commits_with_pagination() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        git_ok(&root, &["init", "-q", "-b", "main"]).await;
        git_ok(&root, &["config", "user.email", "test@example.com"]).await;
        git_ok(&root, &["config", "user.name", "Test"]).await;
        std::fs::write(root.join("a.txt"), "one").unwrap();
        git_ok(&root, &["add", "--", "a.txt"]).await;
        commit(&root, "first subject").await.unwrap();
        std::fs::write(root.join("b.txt"), "two\n").unwrap();
        git_ok(&root, &["add", "--", "b.txt"]).await;
        commit(&root, "second subject").await.unwrap();
        std::fs::write(root.join("a.txt"), "one two").unwrap();
        git_ok(&root, &["add", "--", "a.txt"]).await;
        commit(&root, "third subject").await.unwrap();

        // Newest first, with shas resolved from the real repository.
        let all = log(&root, 50, 0).await.unwrap();
        assert_eq!(
            all.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(),
            ["third subject", "second subject", "first subject"]
        );
        assert!(all.iter().all(|c| c.sha.len() == 40));
        assert!(all.iter().all(|c| c.short_sha.len() >= 4));
        assert_eq!(all[0].author, "Test");
        assert_eq!(all[0].email, "test@example.com");
        assert!(all[0].date_ms > 0);

        // Pagination: skip/limit windows concatenate into the same list.
        let page_one = log(&root, 2, 0).await.unwrap();
        let page_two = log(&root, 50, 2).await.unwrap();
        let combined: Vec<String> = page_one
            .iter()
            .chain(page_two.iter())
            .map(|c| c.sha.clone())
            .collect();
        assert_eq!(combined, all.iter().map(|c| c.sha.clone()).collect::<Vec<_>>());

        // Show renders per-file patches for one commit; the pathspec narrows.
        let second = &all[1];
        let files = show(&root, &second.sha, &[]).await.unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].rel_path, "b.txt");
        assert!(files[0].patch.contains("new file mode"));
        assert!(files[0].patch.contains("+two"));

        let filtered = show(&root, &second.sha, &["a.txt".into()]).await.unwrap();
        assert!(filtered.is_empty());

        // Invalid revisions are rejected before touching git.
        assert!(show(&root, "--exec=rm", &[]).await.is_err());
        assert!(show(&root, "HEAD", &[]).await.is_err());
        assert!(show(&root, "zzzz", &[]).await.is_err());
    }

    #[tokio::test]
    async fn log_and_show_resolve_empty_outside_repo_and_unborn_head() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(root.join("plain.txt"), "no git here").unwrap();
        assert!(log(&root, 50, 0).await.unwrap().is_empty());
        assert!(show(&root, "1a2b3c4d", &[]).await.unwrap().is_empty());

        // Repository without commits: empty history, no error.
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        git_ok(&root, &["init", "-q"]).await;
        std::fs::write(root.join("a.txt"), "hello").unwrap();
        assert!(log(&root, 50, 0).await.unwrap().is_empty());
    }
}
