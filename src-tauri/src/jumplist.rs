//! Windows 任务栏跳转列表（Jump List）：右键任务栏图标显示「最近使用的文件夹」。
//!
//! 最近文件夹持久化在应用数据目录的 `recent-folders.json` 中，每次成功打开
//! 项目后通过 `ICustomDestinationList` 重建自定义类别。类别里的每一项都是
//! 指向自身 exe、以目标文件夹为参数的 Shell Link（与 VS Code 同款做法），
//! 点击后由 `tauri-plugin-single-instance` 转发给已运行实例或冷启动时解析。
//!
//! 非 Windows 平台仅保留最近文件夹的持久化，跳转列表为空操作。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Manager;

pub const MAX_RECENT_FOLDERS: usize = 10;
pub const OPEN_PROJECT_EVENT: &str = "open-project-request";

const RECENT_FILE_NAME: &str = "recent-folders.json";
const JUMPLIST_CATEGORY: &str = "最近使用的文件夹";
const APP_USER_MODEL_ID: &str = "com.liteide.app";
const FOLDER_ICON_SHELL32_INDEX: i32 = 3;

/// 启动参数解析出的待打开文件夹（冷启动场景，由前端通过命令取走）。
#[derive(Default)]
pub struct LaunchRequest(Mutex<Option<String>>);

impl LaunchRequest {
    pub fn set(&self, folder: Option<String>) {
        *self.0.lock().unwrap() = folder;
    }

    pub fn get(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
}

/// 最近打开的文件夹（最近在前，无重复）。
#[derive(Default)]
pub struct RecentFolders(Mutex<Vec<String>>);

impl RecentFolders {
    fn snapshot(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }

    fn replace(&self, folders: Vec<String>) {
        *self.0.lock().unwrap() = folders;
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RecentFoldersFile {
    folders: Vec<String>,
}

/// 从启动参数中解析出首个「真实存在且是目录」的非开关参数。
/// 形如 `--flag` / `-n` / `--key=value` 的参数一律跳过。
pub fn parse_folder_arg(argv: &[String]) -> Option<String> {
    for arg in argv.iter().skip(1) {
        let trimmed = arg.trim().trim_matches('"');
        if trimmed.is_empty() || trimmed.starts_with('-') {
            continue;
        }
        let path = Path::new(trimmed);
        if path.is_dir() {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// 把新打开的文件夹合并进最近列表：大小写/分隔符不敏感去重、置顶、按容量截断。
fn merge_recent(prev: &[String], opened: &str, cap: usize) -> Vec<String> {
    if cap == 0 || opened.trim().is_empty() {
        return prev.to_vec();
    }
    let mut merged = vec![opened.to_string()];
    for folder in prev {
        if key_of(folder) != key_of(opened) && merged.len() < cap {
            merged.push(folder.clone());
        }
    }
    merged
}

/// 路径比较键：统一分隔符、去尾部分隔符，Windows 上忽略大小写。
fn key_of(path: &str) -> String {
    let unified = path.trim().replace('/', r"\");
    let unified = unified.trim_end_matches('\\');
    if cfg!(windows) {
        unified.to_lowercase()
    } else {
        unified.to_string()
    }
}

fn recent_file_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join(RECENT_FILE_NAME))
}

fn load_from_disk(app: &tauri::AppHandle) -> Vec<String> {
    let Some(path) = recent_file_path(app) else {
        return Vec::new();
    };
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<RecentFoldersFile>(&bytes)
            .map(|file| file.folders)
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn persist_to_disk(app: &tauri::AppHandle, folders: &[String]) {
    let Some(path) = recent_file_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let payload = RecentFoldersFile {
        folders: folders.to_vec(),
    };
    if let Ok(json) = serde_json::to_vec_pretty(&payload) {
        let _ = std::fs::write(&path, json);
    }
}

/// 应用启动时调用：加载持久化的最近文件夹，并按当前 exe 路径重建跳转列表
/// （列表项内嵌 exe 路径，重建后开发期 exe 变动也不会留下失效条目）。
pub fn init(app: &tauri::AppHandle) -> RecentFolders {
    let folders = load_from_disk(app);
    let state = RecentFolders(Mutex::new(folders));
    let snapshot = state.snapshot();
    if !snapshot.is_empty() {
        // 历史文件夹可能已被删除，先过滤再重建，失败不影响启动。
        let alive: Vec<String> = snapshot.into_iter().filter(|f| Path::new(f).is_dir()).collect();
        state.replace(alive.clone());
        persist_to_disk(app, &alive);
        #[cfg(windows)]
        rebuild_jump_list(&alive);
    }
    state
}

/// 项目成功打开后调用：更新最近列表并重建跳转列表。全部尽力而为，
/// 任何失败都不影响项目打开本身。
pub fn record_project_open(app: &tauri::AppHandle, state: &RecentFolders, display_root: &str) {
    let folders = merge_recent(&state.snapshot(), display_root, MAX_RECENT_FOLDERS);
    state.replace(folders.clone());
    persist_to_disk(app, &folders);
    #[cfg(windows)]
    rebuild_jump_list(&folders);
}

/// 必须在任何窗口创建之前调用：任务栏按钮按窗口创建时的进程
/// AppUserModelID 归组，之后设置就无法与跳转列表的 AUMID 关联。
#[cfg(windows)]
pub(crate) fn set_process_app_user_model_id() {
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(&windows::core::HSTRING::from(
            APP_USER_MODEL_ID,
        ));
    }
}

/// 用 `ICustomDestinationList` 重建「最近使用的文件夹」自定义类别。
/// 每项为指向自身 exe、参数为目标文件夹的 Shell Link，图标用系统
/// shell32.dll 的黄色文件夹。空列表同样提交，用于清掉残留的失效类别。
#[cfg(windows)]
fn rebuild_jump_list(folders: &[String]) {
    let result = rebuild_jump_list_inner(folders);
    if let Err(err) = result {
        eprintln!("[jumplist] rebuild failed: {err}");
    }
}

#[cfg(windows)]
fn rebuild_jump_list_inner(folders: &[String]) -> windows::core::Result<()> {
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
    };

    // ICustomDestinationList 对线程 COM 模型无强要求，逐次初始化/反初始化以
    // 兼容任意调用线程（main 线程已初始化时 S_FALSE / 已是 MTA 时 CHANGED_MODE）。
    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let need_uninitialize = hr.is_ok();
    let result = rebuild_jump_list_com(folders);
    if need_uninitialize {
        unsafe { CoUninitialize() };
    }
    result
}

#[cfg(windows)]
fn rebuild_jump_list_com(folders: &[String]) -> windows::core::Result<()> {
    use windows::core::{HSTRING, Interface};
    use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW,
        ShellLink,
    };

    unsafe {
        let list: ICustomDestinationList =
            CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        list.SetAppID(&HSTRING::from(APP_USER_MODEL_ID))?;

        let mut max_slots = 0u32;
        let _removed: IObjectArray = list.BeginList(&mut max_slots)?;
        let capacity = if max_slots == 0 {
            folders.len()
        } else {
            folders.len().min(max_slots as usize)
        };

        let collection: IObjectCollection =
            CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
        let exe = std::env::current_exe()?;
        let exe_path = HSTRING::from(exe.as_os_str());
        let folder_icon = HSTRING::from(folder_icon_path());

        for folder in folders.iter().take(capacity) {
            let path = Path::new(folder);
            let title = path
                .file_name()
                .and_then(|n| n.to_str())
                .filter(|n| !n.is_empty())
                .unwrap_or(folder);

            let link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(&exe_path)?;
            link.SetArguments(&HSTRING::from(folder))?;
            link.SetIconLocation(&folder_icon, FOLDER_ICON_SHELL32_INDEX)?;

            let store: IPropertyStore = link.cast()?;
            store.SetValue(&PKEY_Title, &PROPVARIANT::from(title))?;
            store.Commit()?;

            collection.AddObject(&link)?;
        }

        // 空列表不追加类别：BeginList + CommitList 即可清空既有自定义类别。
        if !folders.is_empty() {
            list.AppendCategory(
                &HSTRING::from(JUMPLIST_CATEGORY),
                &collection.cast::<IObjectArray>()?,
            )?;
        }
        list.CommitList()?;
    }
    Ok(())
}

#[cfg(windows)]
fn folder_icon_path() -> String {
    std::env::var_os("SystemRoot")
        .map(|root| root.to_string_lossy().into_owned())
        .unwrap_or_else(|| r"C:\Windows".to_string())
        + r"\System32\shell32.dll"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_key(path: &str) -> String {
        key_of(path)
    }

    #[test]
    fn merge_recent_puts_new_folder_first() {
        let merged = merge_recent(&["E:\\a".into(), "E:\\b".into()], "E:\\c", 10);
        assert_eq!(merged, vec!["E:\\c", "E:\\a", "E:\\b"]);
    }

    #[test]
    fn merge_recent_dedupes_case_insensitively_and_moves_to_front() {
        let prev = vec!["E:\\A".to_string(), "E:\\b".to_string()];
        let merged = merge_recent(&prev, r"e:/a", 10);
        assert_eq!(merged, vec![r"e:/a", "E:\\b"]);
    }

    #[test]
    fn merge_recent_keeps_trailing_separator_equivalent() {
        let prev = vec![r"E:\proj\".to_string()];
        let merged = merge_recent(&prev, r"E:\proj", 10);
        assert_eq!(merged, vec![r"E:\proj"]);
    }

    #[test]
    fn merge_recent_respects_capacity() {
        let prev: Vec<String> = (0..10).map(|i| format!(r"E:\p{i}")).collect();
        let merged = merge_recent(&prev, r"E:\new", 10);
        assert_eq!(merged.len(), 10);
        assert_eq!(merged[0], r"E:\new");
        assert!(!merged.contains(&r"E:\p9".to_string()));
    }

    #[test]
    fn merge_recent_rejects_empty_input() {
        let prev = vec!["E:\\a".to_string()];
        assert_eq!(merge_recent(&prev, "   ", 10), prev);
        // 容量为 0：不允许新增，也不清空既有列表。
        assert_eq!(merge_recent(&prev, "E:\\x", 0), prev);
    }

    #[test]
    fn parse_folder_arg_takes_first_existing_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().to_string();
        let argv = vec![
            "lite-ide.exe".to_string(),
            "--flag".to_string(),
            "--key=value".to_string(),
            r"E:\does-not-exist".to_string(),
            dir.clone(),
        ];
        assert_eq!(parse_folder_arg(&argv), Some(dir));
    }

    #[test]
    fn parse_folder_arg_ignores_flags_and_missing_paths() {
        let argv = vec![
            "lite-ide.exe".to_string(),
            "-n".to_string(),
            r"E:\nope".to_string(),
        ];
        assert_eq!(parse_folder_arg(&argv), None);
        assert_eq!(parse_folder_arg(&["lite-ide.exe".to_string()]), None);
    }

    #[test]
    fn dir_key_is_case_insensitive_on_windows() {
        // 平台相关的比较键仅在 Windows 上小写化，这里只验证行为一致。
        if cfg!(windows) {
            assert_eq!(dir_key(r"E:\Proj"), dir_key(r"e:\proj"));
        } else {
            assert_ne!(dir_key(r"E:\Proj"), dir_key(r"e:\proj"));
        }
    }
}
