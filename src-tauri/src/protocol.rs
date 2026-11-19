use std::sync::Arc;

use percent_encoding::percent_decode_str;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext, UriSchemeResponder};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::fs::detect_mime;
use crate::project::ProjectManager;

pub fn handle_workspace_request<R: Runtime>(
    manager: Arc<ProjectManager>,
    _ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let uri_path = request.uri().path().to_string();
    let range_header = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(ToOwned::to_owned);

    tauri::async_runtime::spawn(async move {
        let response = build_workspace_response(&manager, &uri_path, range_header.as_deref()).await;
        responder.respond(response);
    });
}

async fn build_workspace_response(
    manager: &ProjectManager,
    uri_path: &str,
    range_header: Option<&str>,
) -> Response<Vec<u8>> {
    let Some((project_id, rel_path)) = parse_workspace_uri_path(uri_path) else {
        return text_response(StatusCode::BAD_REQUEST, "Invalid workspace URI path");
    };

    let file_path = match manager.resolve_file(&project_id, &rel_path) {
        Ok(p) => p,
        Err(err) => {
            let status = match err.code() {
                "PATH_TRAVERSAL" => StatusCode::FORBIDDEN,
                "PROJECT_NOT_FOUND" | "IO_ERROR" => StatusCode::NOT_FOUND,
                _ => StatusCode::BAD_REQUEST,
            };
            return text_response(status, &err.to_string());
        }
    };

    let mime = detect_mime(&file_path);

    let mut file = match tokio::fs::File::open(&file_path).await {
        Ok(f) => f,
        Err(_) => return text_response(StatusCode::NOT_FOUND, "File unreadable"),
    };

    let total_len = match file.metadata().await {
        Ok(m) => m.len(),
        Err(_) => return text_response(StatusCode::INTERNAL_SERVER_ERROR, "Metadata failed"),
    };

    if let Some(range_raw) = range_header {
        let Some((start, end)) = parse_byte_range(range_raw, total_len) else {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{total_len}"))
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Vec::new())
                .unwrap();
        };

        let chunk_len = (end - start + 1) as usize;
        if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
            return text_response(StatusCode::INTERNAL_SERVER_ERROR, "Seek failed");
        }

        let mut buf = Vec::with_capacity(chunk_len);
        if file.take(chunk_len as u64).read_to_end(&mut buf).await.is_err() {
            return text_response(StatusCode::INTERNAL_SERVER_ERROR, "Read failed");
        }

        return Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{total_len}"),
            )
            .header(header::CONTENT_LENGTH, buf.len().to_string())
            .header(header::CACHE_CONTROL, "no-cache")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(buf)
            .unwrap();
    }

    let mut buf = Vec::with_capacity(total_len as usize);
    if file.read_to_end(&mut buf).await.is_err() {
        return text_response(StatusCode::INTERNAL_SERVER_ERROR, "Read failed");
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, buf.len().to_string())
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(buf)
        .unwrap()
}

pub fn parse_workspace_uri_path(uri_path: &str) -> Option<(String, String)> {
    let trimmed = uri_path.trim_start_matches('/');
    let (raw_id, raw_rel) = trimmed.split_once('/')?;
    if raw_id.is_empty() || raw_rel.is_empty() {
        return None;
    }

    let project_id = percent_decode_str(raw_id).decode_utf8().ok()?.into_owned();
    let mut decoded_segments = Vec::new();
    for seg in raw_rel.split('/') {
        if seg.is_empty() {
            continue;
        }
        let decoded = percent_decode_str(seg).decode_utf8().ok()?.into_owned();
        decoded_segments.push(decoded);
    }

    if decoded_segments.is_empty() {
        return None;
    }

    Some((project_id, decoded_segments.join("/")))
}

/// Parses an HTTP `Range: bytes=...` header into an inclusive `(start, end)` byte offset.
pub fn parse_byte_range(header_val: &str, total_len: u64) -> Option<(u64, u64)> {
    if total_len == 0 {
        return None;
    }

    let spec = header_val.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        // Multi-range not needed; fallback to first range or reject.
        return None;
    }

    let (start_str, end_str) = spec.split_once('-')?;
    if start_str.is_empty() {
        let suffix: u64 = end_str.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = total_len.saturating_sub(suffix);
        return Some((start, total_len - 1));
    }

    let start: u64 = start_str.parse().ok()?;
    if start >= total_len {
        return None;
    }

    let end = if end_str.is_empty() {
        total_len - 1
    } else {
        let parsed_end: u64 = end_str.parse().ok()?;
        if parsed_end < start {
            return None;
        }
        parsed_end.min(total_len - 1)
    };

    Some((start, end))
}

fn text_response(status: StatusCode, msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_workspace_uri_with_encoded_segments() {
        let parsed = parse_workspace_uri_path("/proj-1/assets/%E5%9B%BE%20%E7%89%87.png").unwrap();
        assert_eq!(parsed.0, "proj-1");
        assert_eq!(parsed.1, "assets/图 片.png");
    }

    #[test]
    fn parses_valid_and_invalid_byte_ranges() {
        assert_eq!(parse_byte_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_byte_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_byte_range("bytes=500-9999", 1000), Some((500, 999)));
        assert_eq!(parse_byte_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_byte_range("bytes=1000-", 1000), None);
        assert_eq!(parse_byte_range("bytes=50-10", 1000), None);
        assert_eq!(parse_byte_range("bytes=0-0", 0), None);
    }
}
