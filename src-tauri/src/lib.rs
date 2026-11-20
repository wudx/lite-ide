mod error;
mod fs;
mod project;
mod protocol;

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::error::AppError;
use crate::fs::{DirEntry, FileMeta, TextPayload, WriteTextResult};
use crate::project::{FsDelta, ProjectInfo, ProjectManager};

#[tauri::command]
fn project_open(
    manager: State<'_, Arc<ProjectManager>>,
    path: String,
    on_fs_event: Channel<FsDelta>,
) -> Result<ProjectInfo, AppError> {
    manager.open_project(path, on_fs_event)
}

#[tauri::command]
fn project_close(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
) -> Result<(), AppError> {
    manager.close_project(&project_id)
}

#[tauri::command]
fn fs_list_dir(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    rel_path: String,
) -> Result<Vec<DirEntry>, AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    fs::list_dir(&root, &rel_path)
}

#[tauri::command]
fn fs_stat_preview(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    rel_path: String,
) -> Result<FileMeta, AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    fs::stat_preview(&project_id, &root, &rel_path)
}

#[tauri::command]
async fn fs_read_text(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    rel_path: String,
    max_bytes: Option<usize>,
) -> Result<TextPayload, AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    fs::read_text(&root, &rel_path, max_bytes).await
}

#[tauri::command]
async fn fs_write_text(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    rel_path: String,
    content: String,
    encoding: Option<String>,
) -> Result<WriteTextResult, AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    fs::write_text(&project_id, &root, &rel_path, &content, encoding.as_deref()).await
}

#[tauri::command]
fn fs_create_file(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    rel_path: String,
) -> Result<FileMeta, AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    fs::create_file(&project_id, &root, &rel_path)
}

#[tauri::command]
fn fs_create_dir(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    rel_path: String,
) -> Result<DirEntry, AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    fs::create_dir(&root, &rel_path)
}

#[tauri::command]
fn fs_rename_path(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    old_rel_path: String,
    new_rel_path: String,
) -> Result<DirEntry, AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    fs::rename_path(&root, &old_rel_path, &new_rel_path)
}

#[tauri::command]
fn fs_delete_path(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    rel_path: String,
) -> Result<(), AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    fs::delete_path(&root, &rel_path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let manager = Arc::new(ProjectManager::new());
    let protocol_manager = Arc::clone(&manager);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(manager)
        .register_asynchronous_uri_scheme_protocol("workspace", move |ctx, request, responder| {
            protocol::handle_workspace_request(
                Arc::clone(&protocol_manager),
                ctx,
                request,
                responder,
            );
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(true);
                    let _ = window.set_title_bar_style(tauri::TitleBarStyle::Overlay);
                }
            }
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            project_open,
            project_close,
            fs_list_dir,
            fs_stat_preview,
            fs_read_text,
            fs_write_text,
            fs_create_file,
            fs_create_dir,
            fs_rename_path,
            fs_delete_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running LiteIDE");
}
