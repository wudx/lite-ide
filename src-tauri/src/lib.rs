mod ai;
mod error;
mod fs;
mod git;
mod jumplist;
mod plugins;
mod project;
mod protocol;
mod terminal;

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State};

use crate::error::AppError;
use crate::fs::{DirEntry, FileMeta, TextPayload, WriteTextResult};
use crate::git::{
    GitBranchInfo, GitCommitInfo, GitCommitResult, GitDiffFile, GitStashEntry, GitStatus,
};
use crate::project::{FsDelta, ProjectInfo, ProjectManager};
use crate::terminal::{TerminalEvent, TerminalManager, TerminalSpawned};

#[tauri::command]
fn project_open(
    app: tauri::AppHandle,
    manager: State<'_, Arc<ProjectManager>>,
    recent: State<'_, jumplist::RecentFolders>,
    path: String,
    on_fs_event: Channel<FsDelta>,
) -> Result<ProjectInfo, AppError> {
    let info = manager.open_project(path, on_fs_event)?;
    jumplist::record_project_open(&app, &recent, &info.root_path);
    Ok(info)
}

/// 返回冷启动启动参数中解析出的项目文件夹；前端仅在启动阶段调用一次。
#[tauri::command]
fn app_get_launch_project(launch: State<'_, jumplist::LaunchRequest>) -> Option<String> {
    launch.get()
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

/// 在系统文件管理器中显示项目条目：文件在其父目录中选中；目录在 Windows/Linux
/// 下直接打开，在 macOS 于父目录中显示。
#[tauri::command]
fn fs_reveal_in_file_manager(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    rel_path: String,
) -> Result<(), AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    fs::reveal_in_file_manager(&root, &rel_path)
}

/// 从启动参数中找到项目文件夹，供冷启动与二次启动共用。
fn folder_from_args(argv: &[String]) -> Option<String> {
    jumplist::parse_folder_arg(argv)
}

#[tauri::command]
async fn git_status(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
) -> Result<GitStatus, AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::status(&root).await
}

#[tauri::command]
async fn git_stage(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    paths: Vec<String>,
) -> Result<(), AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::stage(&root, &paths).await
}

#[tauri::command]
async fn git_unstage(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    paths: Vec<String>,
) -> Result<(), AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::unstage(&root, &paths).await
}

#[tauri::command]
async fn git_discard(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    untracked_paths: Vec<String>,
    tracked_paths: Vec<String>,
) -> Result<(), AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::discard(&root, &untracked_paths, &tracked_paths).await
}

#[tauri::command]
async fn git_commit(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    message: String,
) -> Result<GitCommitResult, AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::commit(&root, &message).await
}

#[tauri::command]
async fn git_push(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
) -> Result<(), AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::push(&root).await
}

#[tauri::command]
async fn git_diff(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    staged: bool,
    paths: Vec<String>,
) -> Result<Vec<GitDiffFile>, AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::diff(&root, staged, &paths).await
}

#[tauri::command]
async fn ai_chat(request: ai::AiChatRequest) -> Result<ai::AiChatResult, AppError> {
    ai::chat(request).await
}

#[tauri::command]
async fn git_branches(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
) -> Result<Vec<GitBranchInfo>, AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::branches(&root).await
}

#[tauri::command]
async fn git_checkout_branch(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    name: String,
    create: Option<bool>,
) -> Result<(), AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::checkout_branch(&root, &name, create.unwrap_or(false)).await
}

#[tauri::command]
async fn git_stash_all(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    message: Option<String>,
) -> Result<(), AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::stash_all(&root, message.as_deref()).await
}

#[tauri::command]
async fn git_stash_paths(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    paths: Vec<String>,
) -> Result<(), AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::stash_paths(&root, &paths).await
}

#[tauri::command]
async fn git_stash_list(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
) -> Result<Vec<GitStashEntry>, AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::stash_list(&root).await
}

#[tauri::command]
async fn git_stash_restore(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    index: usize,
) -> Result<(), AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::stash_restore(&root, index).await
}

#[tauri::command]
async fn git_stash_drop(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    index: usize,
) -> Result<(), AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::stash_drop(&root, index).await
}

#[tauri::command]
async fn git_log(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    limit: Option<u32>,
    skip: Option<u32>,
) -> Result<Vec<GitCommitInfo>, AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::log(&root, limit.unwrap_or(50), skip.unwrap_or(0)).await
}

#[tauri::command]
async fn git_show(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    sha: String,
    paths: Vec<String>,
) -> Result<Vec<GitDiffFile>, AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::show(&root, &sha, &paths).await
}

#[tauri::command]
async fn git_blob(
    manager: State<'_, Arc<ProjectManager>>,
    project_id: String,
    rev: String,
    rel_path: String,
) -> Result<Option<String>, AppError> {
    let root = manager.get_canonical_root(&project_id)?;
    git::read_blob(&root, &rev, &rel_path).await
}

// ---- 交互式终端：shell 固定从项目 canonical root 启动，路径不经客户端输入 ----

#[tauri::command]
async fn terminal_spawn(
    manager: State<'_, Arc<TerminalManager>>,
    projects: State<'_, Arc<ProjectManager>>,
    project_id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<TerminalSpawned, AppError> {
    let root = projects.get_canonical_root(&project_id)?;
    let sink: Arc<dyn terminal::TerminalSink> = Arc::new(on_event);
    terminal::spawn(&manager, &root, cols, rows, sink)
}

#[tauri::command]
async fn terminal_write(
    manager: State<'_, Arc<TerminalManager>>,
    session_id: String,
    data: String,
) -> Result<(), AppError> {
    terminal::write(&manager, &session_id, &data)
}

#[tauri::command]
async fn terminal_resize(
    manager: State<'_, Arc<TerminalManager>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    terminal::resize(&manager, &session_id, cols, rows)
}

#[tauri::command]
async fn terminal_kill(
    manager: State<'_, Arc<TerminalManager>>,
    session_id: String,
) -> Result<(), AppError> {
    terminal::kill(&manager, &session_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 任务栏跳转列表依赖 AUMID 在首个窗口创建前声明，必须最先执行。
    #[cfg(windows)]
    jumplist::set_process_app_user_model_id();

    let manager = Arc::new(ProjectManager::new());
    let protocol_manager = Arc::clone(&manager);

    tauri::Builder::default()
        // single-instance 必须最先注册：点击跳转列表条目时，若应用已在运行，
        // 新进程立即退出并把文件夹路径转发给现有窗口。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(folder) = folder_from_args(&argv) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                    let _ = window.unminimize();
                    let _ = window.emit(jumplist::OPEN_PROJECT_EVENT, folder);
                }
            }
        }))
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
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(true);
                    let _ = window.set_title_bar_style(tauri::TitleBarStyle::Overlay);
                }
            }

            // 声明 AppUserModelID、加载最近文件夹并按当前 exe 重建跳转列表。
            let recent = jumplist::init(app.handle());
            app.manage(recent);

            // 外部插件目录（<app_data_dir>/plugins）随应用数据初始化。
            let plugin_manager = std::sync::Arc::new(plugins::PluginManager::new(app.handle()));
            app.manage(plugin_manager);

            // 终端 PTY 会话注册表：随应用退出统一回收子进程。
            app.manage(Arc::new(TerminalManager::default()));

            let launch = jumplist::LaunchRequest::default();
            // args_os：参数含无法映射 Unicode 的字符时 args() 会 panic。
            let argv: Vec<String> = std::env::args_os()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            launch.set(folder_from_args(&argv));
            app.manage(launch);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            project_open,
            project_close,
            app_get_launch_project,
            fs_list_dir,
            fs_stat_preview,
            fs_read_text,
            fs_write_text,
            fs_create_file,
            fs_create_dir,
            fs_rename_path,
            fs_delete_path,
            fs_reveal_in_file_manager,
            git_status,
            git_stage,
            git_unstage,
            git_discard,
            git_commit,
            git_push,
            git_diff,
            git_branches,
            git_checkout_branch,
            git_stash_all,
            git_stash_paths,
            git_stash_list,
            git_stash_restore,
            git_stash_drop,
            git_log,
            git_show,
            git_blob,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_kill,
            ai_chat,
            plugins::plugin_list,
            plugins::plugin_catalog,
            plugins::plugin_install_from_path,
            plugins::plugin_install_from_catalog,
            plugins::plugin_uninstall,
            plugins::plugin_read_entry,
            plugins::plugin_read_asset
        ])
        .build(tauri::generate_context!())
        .expect("error while building LiteIDE")
        .run(|app_handle, event| {
            // 应用退出前回收全部终端子进程（ConPTY 客户端随宿主结束）。
            if let tauri::RunEvent::Exit = event {
                if let Some(terminal_manager) =
                    app_handle.try_state::<Arc<TerminalManager>>()
                {
                    terminal_manager.kill_all();
                }
            }
        });
}
