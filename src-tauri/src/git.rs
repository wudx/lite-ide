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
use crate::project::validate_rel_segments;

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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    pub name: String,
    pub current: bool,
    pub remote: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
}

/// Runs `git` in the project root and returns stdout on success.
async fn run_git(root: &Path, args: &[&str]) -> Result<String, AppError> {
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

    let output = cmd.output().await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::Git("git executable not found in PATH".into())
        } else {
            AppError::Git(format!("failed to spawn git: {e}"))
        }
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        let verb = args.first().copied().unwrap_or("git");
        return Err(AppError::Git(format!("git {verb}: {detail}")));
    }
    Ok(stdout)
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
    fn rejects_empty_and_root_pathspecs() {
        assert!(validate_pathspecs(&["".into()]).is_err());
        assert!(validate_pathspecs(&["/".into()]).is_err());
        assert!(validate_pathspecs(&["src/app.ts".into()]).is_ok());
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

        git_ok(&root, &["add", "--", "a.txt"]).await;
        assert_eq!(status_letters(&root).await, vec![('A', ' ', "a.txt".into())]);

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
    async fn folder_outside_repository_reports_not_a_repo() {
        let dir = tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(root.join("plain.txt"), "no git here").unwrap();

        let st = status(&root).await.unwrap();
        assert!(!st.repo);
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
}
