//! Installing external plugins from a GitHub repository URL.
//!
//! Flow: parse & validate the repository URL → download the zipball via the
//! GitHub API (302 to codeload) → extract into a staging temp dir (zip-slip
//! and decompression-budget guarded) → locate the plugin folder (repo root,
//! an explicit `/tree/<ref>/<subdir>`, or a unique single child folder) →
//! hand it to the regular `install_from_path` pipeline.

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::Duration;

use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};

use crate::error::AppError;

/// Cap on the downloaded zipball; plugin folders are capped at 10 MB by the
/// regular install, so this only bounds the surrounding repository payload.
const MAX_ZIP_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;
/// Cap on total decompressed bytes while extracting (zip-bomb guard).
pub const MAX_ZIP_DECOMPRESSED_BYTES: u64 = 128 * 1024 * 1024;
/// Cap on the number of archive entries (extraction loop guard).
const MAX_ZIP_ENTRIES: usize = 20_000;
const GITHUB_API_BASE: &str = "https://api.github.com";

/// A validated GitHub repository reference for plugin installation.
#[derive(Debug, Clone, PartialEq)]
pub struct GithubPluginSource {
    pub owner: String,
    pub repo: String,
    /// Branch, tag or commit sha; None = repository default branch.
    pub git_ref: Option<String>,
    /// Repository-relative folder that hosts the plugin; None = repo root.
    pub subdir: Option<String>,
}

impl GithubPluginSource {
    fn repo_api_url(&self) -> String {
        format!(
            "{GITHUB_API_BASE}/repos/{}/{}",
            encode_segment(&self.owner),
            encode_segment(&self.repo)
        )
    }

    fn zipball_url(&self, git_ref: &str) -> String {
        format!(
            "{GITHUB_API_BASE}/repos/{}/{}/zipball/{}",
            encode_segment(&self.owner),
            encode_segment(&self.repo),
            encode_segment(git_ref)
        )
    }
}

/// URL path-segment encoding for the (already charset-validated) request
/// parts; `%` included so decoded `%25`-escapes round-trip safely.
const SEGMENT_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'/')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}');

fn encode_segment(segment: &str) -> String {
    utf8_percent_encode(segment, SEGMENT_SET).to_string()
}

/// Decodes `%XX` escapes once (invalid sequences stay as-is). Inputs were
/// charset-validated first, so this only unwraps well-formed escapes.
fn percent_decode(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            out.push(u8::from_str_radix(hex, 16).unwrap_or(b'%'));
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Segment characters accepted for owner / repo / ref / subdir parts. The
/// values are spliced into request URLs verbatim, so anything outside this
/// conservative set (including whitespace, quotes and stray `%` escapes) is
/// rejected instead of being re-encoded.
fn is_valid_url_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 200
        && segment != "."
        && segment != ".."
        && segment.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(b, b'-' | b'_' | b'.' | b'~' | b'+' | b'@' | b'(' | b')' | b',' | b'$' | b'!' | b'*' | b'\'' | b'%' | b':')
        })
        && segment
            .split('%')
            .skip(1)
            .all(|tail| tail.len() >= 2 && tail.as_bytes()[0].is_ascii_hexdigit() && tail.as_bytes()[1].is_ascii_hexdigit())
}

fn validate_repo_name(kind: &str, value: &str) -> Result<(), String> {
    if !is_valid_url_segment(value) || !value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')) {
        return Err(format!("invalid GitHub {kind}: {value}"));
    }
    Ok(())
}

/// Parses user input into a repository reference. Accepted shapes:
///
/// - `owner/repo`
/// - `github.com/owner/repo` / `https://github.com/owner/repo[.git][/`
/// - `…/tree/<ref>[/<subdir…>]`
///
/// Release/archive/blob links are rejected with a hint (only repository
/// source installs are supported). The first segment is treated as a host
/// name only when it is `github.com`/`www.github.com` (or contains a dot —
/// then it is an unsupported host); otherwise the input is an owner/repo
/// shorthand. Branch names containing `/` cannot be distinguished from
/// subdirectories here; the download falls back to joining path segments
/// into the ref when the first attempt 404s.
pub fn parse_github_plugin_url(input: &str) -> Result<GithubPluginSource, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("GitHub repository URL is empty".to_string());
    }

    let mut rest = trimmed;
    for scheme in ["https://", "http://"] {
        // 字节级前缀比较：str 切片会在多字节字符中间 panic（P1）。
        let scheme_bytes = scheme.as_bytes();
        if rest.as_bytes().len() >= scheme_bytes.len()
            && rest.as_bytes()[..scheme_bytes.len()].eq_ignore_ascii_case(scheme_bytes)
        {
            // 前缀已证明为 ASCII，字节索引处必是字符边界。
            rest = &rest[scheme_bytes.len()..];
            break;
        }
    }

    let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Err(format!("GitHub URL is missing owner/repository: {input}"));
    }
    let first = segments[0];
    let start = if first.eq_ignore_ascii_case("github.com")
        || first.eq_ignore_ascii_case("www.github.com")
    {
        1
    } else if first.contains('.') {
        return Err(format!(
            "only github.com repository URLs are supported, got host \"{first}\""
        ));
    } else {
        0
    };
    if segments.len() <= start {
        return Err(format!("GitHub URL is missing owner/repository: {input}"));
    }

    let owner = segments[start].trim_end_matches('.');
    let repo = segments.get(start + 1).copied().unwrap_or("");
    // .git 后缀剥离与 TS 端（/i）一致，大小写不敏感。
    let repo = if repo.len() > 4 && repo.to_ascii_lowercase().ends_with(".git") {
        &repo[..repo.len() - 4]
    } else {
        repo
    };
    validate_repo_name("owner", owner)?;
    validate_repo_name("repo", repo)?;

    let mut source = GithubPluginSource {
        owner: owner.to_string(),
        repo: repo.to_string(),
        git_ref: None,
        subdir: None,
    };

    let remaining: Vec<&str> = segments[start + 2..].to_vec();
    match remaining.first().copied() {
        None => Ok(source),
        // `tree/<ref>[/<subdir…>]` selects a branch/tag and plugin folder.
        // The first segment is taken as the ref (branch names containing `/`
        // cannot be told apart from folders in the URL; the download falls
        // back to joining segments into the ref when the zipball 404s).
        Some("tree") => {
            let parts = &remaining[1..];
            if parts.is_empty() {
                return Err("GitHub tree URL is missing the branch or tag".to_string());
            }
            if !is_valid_url_segment(parts[0]) {
                return Err(format!("invalid GitHub branch or tag: {}", parts[0]));
            }
            // 校验编码形式、存储解码形式：请求 URL 由 encode_segment 重新编码，
            // 与 trees API / 解压目录里的解码路径直接可比。
            source.git_ref = Some(percent_decode(parts[0]));
            if parts.len() > 1 {
                for segment in &parts[1..] {
                    if !is_valid_url_segment(segment) {
                        return Err(format!("invalid subdirectory segment: {segment}"));
                    }
                }
                source.subdir = Some(
                    parts[1..]
                        .iter()
                        .map(|s| percent_decode(s))
                        .collect::<Vec<_>>()
                        .join("/"),
                );
            }
            Ok(source)
        }
        Some("releases") | Some("archive") => Err(
            "release and archive links are not supported; paste the repository URL (optionally /tree/<ref>/<subdir>)".to_string(),
        ),
        Some(other) => Err(format!(
            "unsupported GitHub URL path segment \"{other}\"; paste the repository URL (optionally /tree/<ref>/<subdir>)"
        )),
    }
}

pub fn plugin_client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .user_agent("lite-ide")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|err| AppError::Plugin(format!("cannot build HTTP client: {err}")))
}

/// Resolves the repository default branch (used when the URL carries no
/// explicit ref). Unauthenticated API quota is 60 requests/hour per IP.
async fn resolve_default_branch(
    client: &reqwest::Client,
    source: &GithubPluginSource,
) -> Result<String, String> {
    let response = client
        .get(source.repo_api_url())
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|err| format!("cannot reach api.github.com: {err}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(
            "GitHub API rate limit exceeded (60 requests/hour without authentication); retry later or paste a URL with /tree/<ref>".to_string(),
        );
    }
    if !status.is_success() {
        return Err(format!(
            "cannot read repository {}/{}: HTTP {status}",
            source.owner, source.repo
        ));
    }
    #[derive(serde::Deserialize)]
    struct RepoMeta {
        default_branch: String,
    }
    let meta: RepoMeta = response
        .json()
        .await
        .map_err(|err| format!("invalid repository metadata response: {err}"))?;
    if meta.default_branch.is_empty() {
        return Err("repository metadata has no default branch".to_string());
    }
    Ok(meta.default_branch)
}

/// Structured download failure so 404-driven ref fallback can't be fooled
/// by error text containing "404".
enum DownloadError {
    NotFound(String),
    Other(String),
}

/// Downloads a zipball with a hard size cap (streamed, so a lying
/// content-length cannot blow up memory).
async fn download_zipball(
    client: &reqwest::Client,
    url: &str,
) -> Result<Vec<u8>, DownloadError> {
    let response = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|err| DownloadError::Other(format!("cannot download archive: {err}")))?;
    let status = response.status();
    if !status.is_success() {
        let msg = format!("archive download failed: HTTP {status}");
        return Err(if status == reqwest::StatusCode::NOT_FOUND {
            DownloadError::NotFound(msg)
        } else {
            DownloadError::Other(msg)
        });
    }
    if let Some(length) = response.content_length() {
        if length > MAX_ZIP_DOWNLOAD_BYTES {
            return Err(DownloadError::Other(format!(
                "repository archive exceeds the {} MB download limit",
                MAX_ZIP_DOWNLOAD_BYTES / (1024 * 1024)
            )));
        }
    }

    let mut body: Vec<u8> = Vec::new();
    let mut response = response;
    while let Some(chunk) = response.chunk().await.map_err(|err| {
        DownloadError::Other(format!("archive download interrupted: {err}"))
    })? {
        if body.len() as u64 + chunk.len() as u64 > MAX_ZIP_DOWNLOAD_BYTES {
            return Err(DownloadError::Other(format!(
                "repository archive exceeds the {} MB download limit",
                MAX_ZIP_DOWNLOAD_BYTES / (1024 * 1024)
            )));
        }
        body.extend_from_slice(&chunk);
    }
    if body.is_empty() {
        return Err(DownloadError::Other("repository archive is empty".to_string()));
    }
    Ok(body)
}

/// Fetches the plugin zipball for `source`: resolves the ref when absent and
/// downloads the archive. `tree/feature/x` style URLs are ambiguous (branch
/// names may contain `/`), so on a 404 the subdirectory segments are
/// progressively promoted into the ref and retried, bounded by their count.
pub async fn fetch_repo_zipball(
    client: &reqwest::Client,
    source: &GithubPluginSource,
) -> Result<Vec<u8>, String> {
    let git_ref = match &source.git_ref {
        Some(r) => r.clone(),
        None => resolve_default_branch(client, source).await?,
    };
    let subdir_segments: Vec<String> = match &source.subdir {
        Some(subdir) => subdir
            .split('/')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect(),
        None => Vec::new(),
    };

    let mut ref_parts: Vec<String> = vec![git_ref];
    let mut rest: &[String] = &subdir_segments;
    loop {
        let attempt_ref = ref_parts.join("/");
        let attempt = GithubPluginSource {
            owner: source.owner.clone(),
            repo: source.repo.clone(),
            git_ref: Some(attempt_ref.clone()),
            subdir: if rest.is_empty() { None } else { Some(rest.join("/")) },
        };
        match download_zipball(client, &attempt.zipball_url(&attempt_ref)).await {
            Ok(bytes) => return Ok(bytes),
            Err(DownloadError::NotFound(_)) if !rest.is_empty() => {
                ref_parts.push(rest[0].clone());
                rest = &rest[1..];
            }
            Err(DownloadError::NotFound(_)) => {
                return Err(format!(
                    "repository archive not found for {}/{} ref \"{attempt_ref}\" (check the branch or tag)",
                    source.owner, source.repo
                ));
            }
            Err(DownloadError::Other(err)) => return Err(err),
        }
    }
}

/// Extracts zip bytes into `dest`, guarding against path traversal
/// (zip-slip) and decompression bombs. Directory entries and regular files
/// only; unix permissions are ignored (plugin assets are plain text).
pub fn extract_zipball(
    zip_bytes: &[u8],
    dest: &Path,
    max_decompressed: u64,
) -> Result<(), AppError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip_bytes))
        .map_err(|err| AppError::Plugin(format!("repository archive is not a valid zip: {err}")))?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(AppError::Plugin(format!(
            "repository archive has too many entries ({} > {MAX_ZIP_ENTRIES})",
            archive.len()
        )));
    }

    let mut total: u64 = 0;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| AppError::Plugin(format!("cannot read archive entry {index}: {err}")))?;
        // `enclosed_name` rejects absolute paths and `..` components; GitHub
        // archives never contain them, so treat them as tampering.
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| AppError::Plugin(format!("unsafe archive entry path: {}", entry.name())))?;
        let target = dest.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        total += entry.size();
        if total > max_decompressed {
            return Err(AppError::Plugin(format!(
                "repository archive decompresses beyond the {} MB safety limit",
                max_decompressed / (1024 * 1024)
            )));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = fs::File::create(&target)?;
        std::io::copy(&mut entry, &mut file)?;
    }
    Ok(())
}

/// Locates the plugin folder inside an extracted GitHub archive: exactly one
/// top-level directory (the `{repo}-{ref}` zipball root), then the explicit
/// subdirectory, the root `plugin.json`, or a unique single child folder
/// carrying `plugin.json`.
pub fn locate_plugin_root(
    extract_root: &Path,
    subdir: Option<&str>,
) -> Result<PathBuf, AppError> {
    let entries = fs::read_dir(extract_root)
        .map_err(|err| AppError::Plugin(format!("cannot read extracted archive: {err}")))?;
    let mut top_dirs: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            top_dirs.push(entry.path());
        } else {
            return Err(AppError::Plugin(
                "unexpected archive layout: loose files beside the zipball root".to_string(),
            ));
        }
    }
    if top_dirs.len() != 1 {
        return Err(AppError::Plugin(format!(
            "unexpected archive layout: expected exactly one zipball root folder, found {}",
            top_dirs.len()
        )));
    }
    let top = top_dirs.remove(0);

    let mut base = top;
    if let Some(subdir) = subdir {
        for segment in subdir.split('/') {
            if segment.is_empty() || segment == "." || segment == ".." {
                return Err(AppError::Plugin(format!(
                    "invalid subdirectory segment: {segment}"
                )));
            }
            base = base.join(segment);
        }
        if !base.is_dir() {
            return Err(AppError::Plugin(format!(
                "subdirectory \"{subdir}\" not found in the repository archive"
            )));
        }
    }

    if base.join("plugin.json").is_file() {
        return Ok(base);
    }

    if subdir.is_some() {
        return Err(AppError::Plugin(
            "plugin.json not found under the given subdirectory".to_string(),
        ));
    }

    // Repo root has no plugin.json: accept a unique single child folder that
    // hosts one (a single-plugin repository laid out as `plugin-name/…`).
    let children = fs::read_dir(&base)
        .map_err(|err| AppError::Plugin(format!("cannot read repository root: {err}")))?;
    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in children.flatten() {
        let path = entry.path();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
            && path.join("plugin.json").is_file()
        {
            candidates.push(path);
        }
    }
    match candidates.len() {
        1 => Ok(candidates.remove(0)),
        0 => Err(AppError::Plugin(
            "no plugin.json found in the repository root".to_string(),
        )),
        n => {
            let names: Vec<String> = candidates
                .iter()
                .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                .collect();
            Err(AppError::Plugin(format!(
                "multiple plugin folders found ({n}); install one via /tree/<ref>/<subdirectory>: {}",
                names.join(", ")
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn source(owner: &str, repo: &str, git_ref: Option<&str>, subdir: Option<&str>) -> GithubPluginSource {
        GithubPluginSource {
            owner: owner.to_string(),
            repo: repo.to_string(),
            git_ref: git_ref.map(|s| s.to_string()),
            subdir: subdir.map(|s| s.to_string()),
        }
    }

    #[test]
    fn parse_accepts_repository_urls_and_shorthands() {
        assert_eq!(
            parse_github_plugin_url("https://github.com/lite-ide/demo").unwrap(),
            source("lite-ide", "demo", None, None)
        );
        // 简写、http、www、.git 后缀、尾斜杠。
        assert_eq!(
            parse_github_plugin_url("lite-ide/demo").unwrap(),
            source("lite-ide", "demo", None, None)
        );
        assert_eq!(
            parse_github_plugin_url("http://www.github.com/user/repo.git/").unwrap(),
            source("user", "repo", None, None)
        );
        // tree + ref + 子目录。
        assert_eq!(
            parse_github_plugin_url("https://github.com/u/r/tree/v1.2/plugins/foo").unwrap(),
            source("u", "r", Some("v1.2"), Some("plugins/foo"))
        );
        // 带百分号编码的分支名解码存储；请求 URL 重建时再编码回原形。
        assert_eq!(
            parse_github_plugin_url("https://github.com/u/r/tree/my%20branch").unwrap(),
            source("u", "r", Some("my branch"), None)
        );
        assert_eq!(
            source("u", "r", Some("my branch"), None)
                .zipball_url("my branch"),
            "https://api.github.com/repos/u/r/zipball/my%20branch"
        );
    }

    #[test]
    fn parse_rejects_non_repository_links_and_bad_segments() {
        assert!(parse_github_plugin_url("").is_err());
        assert!(parse_github_plugin_url("https://gitlab.com/u/r").is_err());
        assert!(parse_github_plugin_url("https://github.com/only-owner").is_err());
        assert!(parse_github_plugin_url("https://github.com/u/r/releases/tag/v1").is_err());
        assert!(parse_github_plugin_url("https://github.com/u/r/archive/refs/heads/main.zip").is_err());
        assert!(parse_github_plugin_url("https://github.com/u/r/blob/main/plugin.json").is_err());
        assert!(parse_github_plugin_url("https://github.com/../etc").is_err());
        assert!(parse_github_plugin_url("https://github.com/u/r/tree/../x").is_err());
        assert!(parse_github_plugin_url("https://github.com/u/r/tree/main/a b").is_err());
        assert!(parse_github_plugin_url("https://github.com/u/r/tree/a%zz").is_err());
        assert!(parse_github_plugin_url("https://github.com/a b/c").is_err());
    }

    /// Builds an in-memory zip with the given (name, content) entries.
    fn build_zip(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options: zip::write::SimpleFileOptions = Default::default();
            for (name, content) in entries {
                zip.start_file(*name, options).unwrap();
                zip.write_all(content.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn extract_writes_files_and_rejects_zip_slip_and_bombs() {
        let workspace = tempfile::tempdir().unwrap();
        let dest = workspace.path().join("extract");

        let good = build_zip(&[
            ("demo-main/plugin.json", "{}"),
            ("demo-main/src/main.js", "liteide.plugin({})"),
        ]);
        extract_zipball(&good, &dest, u64::MAX).unwrap();
        assert!(dest.join("demo-main/plugin.json").is_file());
        assert!(dest.join("demo-main/src/main.js").is_file());

        // zip-slip：绝对路径与 ../ 条目一律拒绝。
        let slip = build_zip(&[("../evil.txt", "x")]);
        let err = extract_zipball(&slip, &workspace.path().join("slip"), u64::MAX).unwrap_err();
        assert!(err.to_string().contains("unsafe archive entry path"));

        // 解压预算：超出即失败且不落半套文件。
        let padded = "x".repeat(4096);
        let bomb = build_zip(&[("demo/plugin.json", "{}"), ("demo/pad.js", padded.as_str())]);
        let err = extract_zipball(&bomb, &workspace.path().join("bomb"), 1024).unwrap_err();
        assert!(err.to_string().contains("safety limit"));
        let _ = fs::remove_dir_all(workspace.path().join("bomb"));

        assert!(extract_zipball(b"not a zip", &dest, u64::MAX).is_err());
    }

    #[test]
    fn locate_resolves_root_subdir_and_unique_child() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().join("extract");
        let top = root.join("demo-main");
        fs::create_dir_all(top.join("my-plugin/src")).unwrap();
        fs::write(top.join("my-plugin/plugin.json"), "{}").unwrap();
        fs::write(top.join("my-plugin/src/main.js"), "x").unwrap();

        // 仓库根唯一子目录即插件。
        assert_eq!(
            locate_plugin_root(&root, None).unwrap(),
            top.join("my-plugin")
        );
        // 显式子目录直达。
        assert_eq!(
            locate_plugin_root(&root, Some("my-plugin")).unwrap(),
            top.join("my-plugin")
        );

        // 两个插件目录且无根 plugin.json → 报候选列表。
        let second = top.join("other-plugin");
        fs::create_dir_all(&second).unwrap();
        fs::write(second.join("plugin.json"), "{}").unwrap();
        let err = locate_plugin_root(&root, None).unwrap_err();
        assert!(err.to_string().contains("multiple plugin folders"));
        assert!(err.to_string().contains("my-plugin, other-plugin"));

        // 子目录里没有 plugin.json。
        let err = locate_plugin_root(&root, Some("my-plugin/src")).unwrap_err();
        assert!(err.to_string().contains("plugin.json not found"));

        // 非 zipball 布局（散落文件）报错。
        let loose = workspace.path().join("loose");
        fs::create_dir_all(&loose).unwrap();
        fs::write(loose.join("readme.md"), "x").unwrap();
        assert!(locate_plugin_root(&loose, None).is_err());
    }
}
