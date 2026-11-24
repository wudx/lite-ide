use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::AppError;

/// A plugin folder larger than this is rejected at install time.
const MAX_PLUGIN_FOLDER_BYTES: u64 = 10 * 1024 * 1024;
/// Classic entry scripts beyond this size are refused when loading.
const MAX_ENTRY_BYTES: u64 = 512 * 1024;
/// Bundle-format entries and single text assets are allowed to be larger.
const MAX_BUNDLE_ENTRY_BYTES: u64 = 6 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 6 * 1024 * 1024;

/// Built-in installable samples. The very same files under the repo-root
/// `samples/plugins/` folder can also be installed from disk ("install from
/// folder"); keep that folder as the source of truth. The asset pairs carry
/// the extra files declared by the manifest (stylesheet / lazy chunks).
const BUILTIN_CATALOG: &[(&str, &str, &str, &[(&str, &str)])] = &[
    (
        "hello-status",
        include_str!("../../samples/plugins/hello-status/plugin.json"),
        include_str!("../../samples/plugins/hello-status/main.js"),
        &[],
    ),
    (
        "theme-dracula",
        include_str!("../../samples/plugins/theme-dracula/plugin.json"),
        include_str!("../../samples/plugins/theme-dracula/main.js"),
        &[],
    ),
    (
        "bundle-notes",
        include_str!("../../samples/plugins/bundle-notes/plugin.json"),
        include_str!("../../samples/plugins/bundle-notes/dist/plugin.js"),
        &[
            (
                "plugin.css",
                include_str!("../../samples/plugins/bundle-notes/dist/plugin.css"),
            ),
            (
                "log-view.js",
                include_str!("../../samples/plugins/bundle-notes/dist/log-view.js"),
            ),
        ],
    ),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub main: Option<String>,
    /// `classic` (default) or `bundle`.
    #[serde(default)]
    pub format: Option<String>,
    /// Stylesheet asset injected by the host while the plugin runs.
    #[serde(default)]
    pub css: Option<String>,
    /// Lazy script chunks: logical name → asset filename.
    #[serde(default)]
    pub chunks: Option<BTreeMap<String, String>>,
    /// Host plugin API version required by the plugin.
    #[serde(default)]
    pub api: Option<u32>,
}

impl PluginManifest {
    fn entry_file_name(&self) -> String {
        self.main
            .clone()
            .unwrap_or_else(|| "main.js".to_string())
    }

    fn is_bundle(&self) -> bool {
        self.format.as_deref() == Some("bundle")
    }

    /// True when the manifest declares `file_name` as its css or one of its
    /// chunks; `read_asset` only serves declared assets.
    fn declares_asset(&self, file_name: &str) -> bool {
        self.css.as_deref() == Some(file_name)
            || self
                .chunks
                .as_ref()
                .is_some_and(|chunks| chunks.values().any(|v| v == file_name))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    pub dir_name: String,
    pub installed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListResult {
    pub root_path: Option<String>,
    pub plugins: Vec<InstalledPlugin>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPlugin {
    pub manifest: PluginManifest,
}

/// App-level plugin store managing `<app_data_dir>/plugins/<id>/` folders.
pub struct PluginManager {
    root: PathBuf,
}

impl PluginManager {
    pub fn new(app: &tauri::AppHandle) -> Self {
        let root = app
            .path()
            .app_data_dir()
            .map(|dir| dir.join("plugins"))
            // 拿不到应用数据目录时退到临时目录：绝不能落到相对 CWD 的路径，
            // 否则插件会被写进任意启动目录。
            .unwrap_or_else(|_| std::env::temp_dir().join("lite-ide-plugins"));
        // 最好情况外的失败（如目录被占用）留给后续命令以 IO 错误暴露。
        let _ = fs::create_dir_all(&root);
        Self::with_root(root)
    }

    pub(crate) fn with_root(root: PathBuf) -> Self {
        Self { root }
    }

    fn plugin_dir(&self, plugin_id: &str) -> Result<PathBuf, AppError> {
        if !is_valid_plugin_id(plugin_id) {
            return Err(AppError::InvalidName(format!(
                "invalid plugin id: {plugin_id}"
            )));
        }
        Ok(self.root.join(plugin_id))
    }

    /// Locates an installed folder by manifest id (or folder name, so that
    /// broken/mismatched folders stay uninstallable). 目录名来自 `read_dir`
    /// 枚举（单个路径分量、不可能穿越），用户输入不参与路径拼接。
    fn find_dir_by_plugin_id(&self, plugin_id: &str) -> Result<Option<PathBuf>, AppError> {
        let entries = fs::read_dir(&self.root)
            .map_err(|err| AppError::Plugin(format!("cannot read plugins directory: {err}")))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let folder_name = entry.file_name().to_string_lossy().into_owned();
            if let Ok(raw) = fs::read_to_string(path.join("plugin.json")) {
                if let Ok(manifest) = parse_manifest(&raw, &folder_name) {
                    if manifest.id == plugin_id {
                        return Ok(Some(path));
                    }
                }
            }
            // 目录名兜底：manifest 损坏 / id 不一致的文件夹按目录名可卸载。
            if folder_name == plugin_id {
                return Ok(Some(path));
            }
        }
        Ok(None)
    }

    /// Reads one installed folder; invalid manifests surface as `error`
    /// entries so the UI can still offer uninstalling broken plugins.
    fn read_installed(&self, dir: &Path) -> InstalledPlugin {
        let dir_name = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let installed_ms = dir
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let manifest_raw = match fs::read_to_string(dir.join("plugin.json")) {
            Ok(raw) => raw,
            Err(err) => {
                return InstalledPlugin {
                    manifest: broken_manifest(&dir_name),
                    dir_name,
                    installed_ms,
                    error: Some(format!("cannot read plugin.json: {err}")),
                }
            }
        };

        match parse_manifest(&manifest_raw, &dir_name) {
            Ok(manifest) => {
                // manifest id 必须与文件夹名一致（安装路径即按 id 建目录）；
                // 手动拷入的不一致文件夹按 broken 形态暴露，仍可按目录名卸载。
                if manifest.id != dir_name {
                    return InstalledPlugin {
                        manifest: broken_manifest(&dir_name),
                        error: Some(format!(
                            "manifest id \"{}\" does not match folder name \"{dir_name}\"",
                            manifest.id
                        )),
                        dir_name,
                        installed_ms,
                    };
                }
                InstalledPlugin {
                    manifest,
                    dir_name,
                    installed_ms,
                    error: None,
                }
            }
            Err(err) => InstalledPlugin {
                manifest: broken_manifest(&dir_name),
                dir_name,
                installed_ms,
                error: Some(err.to_string()),
            },
        }
    }

    pub fn list(&self) -> Result<PluginListResult, AppError> {
        let entries = fs::read_dir(&self.root)
            .map_err(|err| AppError::Plugin(format!("cannot read plugins directory: {err}")))?;
        let mut plugins: Vec<InstalledPlugin> = Vec::new();
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                plugins.push(self.read_installed(&entry.path()));
            }
        }
        plugins.sort_by(|a, b| b.installed_ms.cmp(&a.installed_ms));
        Ok(PluginListResult {
            root_path: self.root.to_str().map(|s| s.to_string()),
            plugins,
        })
    }

    pub fn catalog(&self) -> Result<Vec<CatalogPlugin>, AppError> {
        BUILTIN_CATALOG
            .iter()
            .map(|&(id, manifest_raw, _, _)| {
                parse_manifest(manifest_raw, id)
                    .map(|manifest| CatalogPlugin { manifest })
            })
            .collect()
    }

    pub fn install_from_path(&self, source_path: &str) -> Result<InstalledPlugin, AppError> {
        let canonical =
            fs::canonicalize(source_path).map_err(|err| {
                AppError::Plugin(format!("cannot read plugin folder {source_path}: {err}"))
            })?;
        if !canonical.is_dir() {
            return Err(AppError::NotDirectory(source_path.to_string()));
        }

        let manifest_raw = fs::read_to_string(canonical.join("plugin.json"))
            .map_err(|err| {
                AppError::Plugin(format!(
                    "folder is missing a readable plugin.json: {source_path} ({err})"
                ))
            })?;
        let manifest = parse_manifest(&manifest_raw, source_path)?;

        let entry = canonical.join(manifest.entry_file_name());
        if !entry.is_file() {
            return Err(AppError::Plugin(format!(
                "plugin entry file \"{}\" not found in {source_path}",
                manifest.entry_file_name()
            )));
        }

        let target = self.plugin_dir(&manifest.id)?;
        if target.exists() {
            return Err(AppError::AlreadyExists(format!(
                "plugin \"{}\" is already installed",
                manifest.id
            )));
        }

        let mut budget = MAX_PLUGIN_FOLDER_BYTES;
        copy_dir_recursive(&canonical, &target, &mut budget)?;
        Ok(self.read_installed(&target))
    }

    pub fn install_from_catalog(&self, catalog_id: &str) -> Result<InstalledPlugin, AppError> {
        let sample = BUILTIN_CATALOG
            .iter()
            .find(|&&(id, _, _, _)| id == catalog_id)
            .ok_or_else(|| {
                AppError::Plugin(format!("plugin catalog entry not found: {catalog_id}"))
            })?;

        let manifest = parse_manifest(sample.1, catalog_id)?;
        let target = self.plugin_dir(&manifest.id)?;
        if target.exists() {
            return Err(AppError::AlreadyExists(format!(
                "plugin \"{}\" is already installed",
                manifest.id
            )));
        }

        fs::create_dir_all(&target)?;
        fs::write(target.join("plugin.json"), sample.1)?;
        fs::write(target.join(manifest.entry_file_name()), sample.2)?;
        for &(file_name, content) in sample.3 {
            fs::write(target.join(file_name), content)?;
        }
        Ok(self.read_installed(&target))
    }

    /// Installs a plugin from a GitHub repository URL: download the zipball,
    /// extract into a staging temp dir, locate the plugin folder and run the
    /// regular `install_from_path` pipeline (manifest validation, duplicate
    /// check, copy budget). The staging dir is always cleaned up.
    pub async fn install_from_github(&self, url: &str) -> Result<InstalledPlugin, AppError> {
        let source =
            crate::plugins_github::parse_github_plugin_url(url).map_err(AppError::Plugin)?;
        let client = crate::plugins_github::plugin_client()?;
        let zip_bytes = crate::plugins_github::fetch_repo_zipball(&client, &source)
            .await
            .map_err(AppError::Plugin)?;

        let staging = std::env::temp_dir().join(format!(
            "lite-ide-plugin-dl-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        // 预清理防御上次异常残留的同名目录（uuid 撞名几乎不可能，但清理无害）。
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(&staging)?;

        let result = (|| {
            crate::plugins_github::extract_zipball(
                &zip_bytes,
                &staging,
                crate::plugins_github::MAX_ZIP_DECOMPRESSED_BYTES,
            )?;
            let plugin_root = crate::plugins_github::locate_plugin_root(
                &staging,
                source.subdir.as_deref(),
            )?;
            let plugin_root = plugin_root
                .to_str()
                .ok_or_else(|| AppError::Plugin("plugin folder path is not valid UTF-8".into()))?;
            self.install_from_path(plugin_root)
        })();
        let _ = fs::remove_dir_all(&staging);
        result
    }

    pub fn uninstall(&self, plugin_id: &str) -> Result<(), AppError> {
        // 按清单 id 扫描定位（broken 目录以文件夹名为身份），避免用户输入
        // 直接拼接路径；命中项的目录名来自枚举，不可能包含路径分量。
        let target = self
            .find_dir_by_plugin_id(plugin_id)?
            .ok_or_else(|| AppError::Plugin(format!("plugin not installed: {plugin_id}")))?;
        fs::remove_dir_all(target)?;
        Ok(())
    }

    pub fn read_entry(&self, plugin_id: &str) -> Result<String, AppError> {
        let dir = self
            .find_dir_by_plugin_id(plugin_id)?
            .ok_or_else(|| AppError::Plugin(format!("plugin not installed: {plugin_id}")))?;
        let manifest_raw = fs::read_to_string(dir.join("plugin.json"))
            .map_err(|_| AppError::Plugin(format!("plugin not installed: {plugin_id}")))?;
        let manifest = parse_manifest(&manifest_raw, plugin_id)?;

        // 与 read_installed 同一判据：manifest id 与目录名不一致的文件夹
        // 不参与加载（列表里已是 error 形态）。
        let folder_name = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if manifest.id != folder_name {
            return Err(AppError::Plugin(format!(
                "manifest id \"{}\" does not match folder name \"{folder_name}\"",
                manifest.id
            )));
        }

        // entry_file_name 已校验为不含分隔符的裸文件名，目录逃逸不可能发生。
        let entry = dir.join(manifest.entry_file_name());
        let size = entry
            .metadata()
            .map_err(|_| {
                AppError::Plugin(format!(
                    "plugin entry file \"{}\" not found",
                    manifest.entry_file_name()
                ))
            })?
            .len();
        // bundle 格式承载整包产物（含打包的依赖），允许更大的入口；
        // classic 脚本维持小体积上限。
        let max_bytes = if manifest.is_bundle() {
            MAX_BUNDLE_ENTRY_BYTES
        } else {
            MAX_ENTRY_BYTES
        };
        if size > max_bytes {
            return Err(AppError::Plugin(format!(
                "plugin entry exceeds {} KB",
                max_bytes / 1024
            )));
        }
        fs::read_to_string(&entry).map_err(|err| {
            AppError::Plugin(format!("cannot read plugin entry: {err}"))
        })
    }

    /// Reads a manifest-declared text asset (stylesheet or script chunk).
    /// Only assets named by the manifest are served — the plugin folder may
    /// contain arbitrary files that must stay unreachable.
    pub fn read_asset(&self, plugin_id: &str, file_name: &str) -> Result<String, AppError> {
        if !is_valid_asset_file_name(file_name) {
            return Err(AppError::InvalidName(format!(
                "invalid plugin asset file: {file_name}"
            )));
        }
        let dir = self
            .find_dir_by_plugin_id(plugin_id)?
            .ok_or_else(|| AppError::Plugin(format!("plugin not installed: {plugin_id}")))?;
        let manifest_raw = fs::read_to_string(dir.join("plugin.json"))
            .map_err(|_| AppError::Plugin(format!("plugin not installed: {plugin_id}")))?;
        let manifest = parse_manifest(&manifest_raw, plugin_id)?;

        let folder_name = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if manifest.id != folder_name {
            return Err(AppError::Plugin(format!(
                "manifest id \"{}\" does not match folder name \"{folder_name}\"",
                manifest.id
            )));
        }

        if !manifest.declares_asset(file_name) {
            return Err(AppError::Plugin(format!(
                "plugin asset not declared by manifest: {file_name}"
            )));
        }

        let asset = dir.join(file_name);
        let size = asset
            .metadata()
            .map_err(|_| {
                AppError::Plugin(format!("plugin asset file \"{file_name}\" not found"))
            })?
            .len();
        if size > MAX_ASSET_BYTES {
            return Err(AppError::Plugin(format!(
                "plugin asset exceeds {} KB",
                MAX_ASSET_BYTES / 1024
            )));
        }
        fs::read_to_string(&asset).map_err(|err| {
            AppError::Plugin(format!("cannot read plugin asset: {err}"))
        })
    }
}

/// Placeholder identity for folders whose manifest cannot be trusted; keeps
/// the folder uninstallable by falling back to its own directory name.
fn broken_manifest(dir_name: &str) -> PluginManifest {
    PluginManifest {
        id: dir_name.to_string(),
        name: dir_name.to_string(),
        version: String::new(),
        description: None,
        author: None,
        main: None,
        format: None,
        css: None,
        chunks: None,
        api: None,
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path, budget: &mut u64) -> Result<(), AppError> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &to, budget)?;
        } else if file_type.is_file() {
            let size = entry.metadata()?.len();
            if *budget < size {
                return Err(AppError::Plugin(format!(
                    "plugin folder exceeds the {} MB install limit",
                    MAX_PLUGIN_FOLDER_BYTES / (1024 * 1024)
                )));
            }
            *budget -= size;
            fs::copy(entry.path(), &to)?;
        }
        // 符号链接一律跳过：插件应为自包含文件夹。
    }
    Ok(())
}

/// Plugin ids double as folder names: ASCII letters/digits/`-`/`_` plus
/// internal dots (namespaced ids like `builtin.preview-markdown`); leading
/// or trailing dots are rejected (Windows strips trailing dots when creating
/// directories). Windows 保留设备名（NUL/CON/COM1…）也一并拒绝，否则安装会在
/// `root/<id>.exists()` 上得到误导性的 AlreadyExists。
pub fn is_valid_plugin_id(id: &str) -> bool {
    const RESERVED: &[&str] = &[
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
        "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    let lower = id.to_ascii_lowercase();
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('.')
        && !id.ends_with('.')
        && !RESERVED.contains(&lower.as_str())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Windows 保留设备名（NUL/CON/COM1…）在带扩展名时同样按设备解析。
fn is_windows_reserved_stem(name: &str) -> bool {
    const RESERVED: &[&str] = &[
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
        "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    RESERVED.contains(&stem.as_str())
}

/// Entry filenames must be bare `.js` filenames (no path components, no
/// drive-letter colon — Windows `Path::join` would discard the base directory
/// for `c:main.js` and escape the plugin root).
pub fn is_valid_entry_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.contains(['/', '\\', ':'])
        && name != "."
        && name != ".."
        && !is_windows_reserved_stem(name)
        && name.to_ascii_lowercase().ends_with(".js")
}

/// Asset filenames (stylesheet / chunk) must be bare `.css` or `.js`
/// filenames — no path components or drive letters, so directory escape is
/// impossible.
pub fn is_valid_asset_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.contains(['/', '\\', ':'])
        && name != "."
        && name != ".."
        && !is_windows_reserved_stem(name)
        && (name.to_ascii_lowercase().ends_with(".css")
            || name.to_ascii_lowercase().ends_with(".js"))
}

pub fn parse_manifest(raw: &str, source: &str) -> Result<PluginManifest, AppError> {
    let manifest: PluginManifest = serde_json::from_str(raw)
        .map_err(|err| AppError::Plugin(format!("invalid plugin.json in {source}: {err}")))?;
    if !is_valid_plugin_id(&manifest.id) {
        return Err(AppError::Plugin(format!(
            "invalid plugin id: {}",
            manifest.id
        )));
    }
    if manifest.name.trim().is_empty() || manifest.version.trim().is_empty() {
        return Err(AppError::Plugin(
            "plugin name and version must not be empty".to_string(),
        ));
    }
    if let Some(main) = &manifest.main {
        if !is_valid_entry_file_name(main) {
            return Err(AppError::Plugin(format!(
                "invalid plugin entry file: {main}"
            )));
        }
    }
    if let Some(format) = &manifest.format {
        if format != "classic" && format != "bundle" {
            return Err(AppError::Plugin(format!(
                "invalid plugin format: {format} (expected \"classic\" or \"bundle\")"
            )));
        }
    }
    if let Some(css) = &manifest.css {
        if !is_valid_asset_file_name(css) || !css.to_ascii_lowercase().ends_with(".css") {
            return Err(AppError::Plugin(format!(
                "invalid plugin css asset file: {css}"
            )));
        }
    }
    if let Some(chunks) = &manifest.chunks {
        for (name, file) in chunks {
            if name.is_empty() || name.len() > 64 {
                return Err(AppError::Plugin(format!(
                    "invalid plugin chunk name: {name}"
                )));
            }
            if !is_valid_asset_file_name(file) {
                return Err(AppError::Plugin(format!(
                    "invalid plugin chunk file for \"{name}\": {file}"
                )));
            }
        }
    }
    Ok(manifest)
}

#[tauri::command]
pub fn plugin_list(manager: tauri::State<'_, Arc<PluginManager>>) -> Result<PluginListResult, AppError> {
    manager.list()
}

#[tauri::command]
pub fn plugin_catalog(
    manager: tauri::State<'_, Arc<PluginManager>>,
) -> Result<Vec<CatalogPlugin>, AppError> {
    manager.catalog()
}

#[tauri::command]
pub fn plugin_install_from_path(
    manager: tauri::State<'_, Arc<PluginManager>>,
    source_path: String,
) -> Result<InstalledPlugin, AppError> {
    manager.install_from_path(&source_path)
}

#[tauri::command]
pub fn plugin_install_from_catalog(
    manager: tauri::State<'_, Arc<PluginManager>>,
    catalog_id: String,
) -> Result<InstalledPlugin, AppError> {
    manager.install_from_catalog(&catalog_id)
}

/// 网络下载放在 async 命令里执行；State 借用不跨 await（先 clone Arc）。
#[tauri::command]
pub async fn plugin_install_from_github(
    manager: tauri::State<'_, Arc<PluginManager>>,
    url: String,
) -> Result<InstalledPlugin, AppError> {
    let manager = manager.inner().clone();
    manager.install_from_github(&url).await
}

#[tauri::command]
pub fn plugin_uninstall(
    manager: tauri::State<'_, Arc<PluginManager>>,
    plugin_id: String,
) -> Result<(), AppError> {
    manager.uninstall(&plugin_id)
}

#[tauri::command]
pub fn plugin_read_entry(
    manager: tauri::State<'_, Arc<PluginManager>>,
    plugin_id: String,
) -> Result<String, AppError> {
    manager.read_entry(&plugin_id)
}

#[tauri::command]
pub fn plugin_read_asset(
    manager: tauri::State<'_, Arc<PluginManager>>,
    plugin_id: String,
    file_name: String,
) -> Result<String, AppError> {
    manager.read_asset(&plugin_id, &file_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_id_validation_rejects_traversal_and_separators() {
        assert!(is_valid_plugin_id("hello-status"));
        assert!(is_valid_plugin_id("theme_gruvbox_2"));
        // 内部点号（命名空间 id）允许，首尾点号拒绝。
        assert!(is_valid_plugin_id("builtin.preview-markdown"));
        assert!(!is_valid_plugin_id(".hidden"));
        assert!(!is_valid_plugin_id("trailing."));
        assert!(!is_valid_plugin_id(""));
        assert!(!is_valid_plugin_id("../etc"));
        assert!(!is_valid_plugin_id("a/b"));
        assert!(!is_valid_plugin_id("a\\b"));
        assert!(!is_valid_plugin_id(".."));
        assert!(!is_valid_plugin_id("你好"));
        assert!(!is_valid_plugin_id(&"x".repeat(65)));
        // Windows 保留设备名
        assert!(!is_valid_plugin_id("nul"));
        assert!(!is_valid_plugin_id("COM1"));
    }

    #[test]
    fn entry_file_name_validation_rejects_paths_and_non_js() {
        assert!(is_valid_entry_file_name("main.js"));
        assert!(is_valid_entry_file_name("Index.JS"));
        assert!(!is_valid_entry_file_name("src/main.js"));
        assert!(!is_valid_entry_file_name(".."));
        assert!(!is_valid_entry_file_name("main.ts"));
        assert!(!is_valid_entry_file_name(""));
        // Windows 盘符相对路径（Path::join 会截断基底目录逃出插件根）与保留设备名。
        assert!(!is_valid_entry_file_name("c:main.js"));
        assert!(!is_valid_entry_file_name("C:main.js"));
        assert!(!is_valid_entry_file_name("con.js"));
        assert!(!is_valid_entry_file_name("nul.js"));
    }

    #[test]
    fn manifest_parsing_enforces_required_fields() {
        let ok = r#"{ "id": "a", "name": "A", "version": "1.0.0", "main": "main.js" }"#;
        let manifest = parse_manifest(ok, "test").unwrap();
        assert_eq!(manifest.id, "a");
        assert_eq!(manifest.entry_file_name(), "main.js");

        // main 可省略，默认 main.js。
        let no_main = r#"{ "id": "a", "name": "A", "version": "1.0.0" }"#;
        assert_eq!(parse_manifest(no_main, "test").unwrap().entry_file_name(), "main.js");

        assert!(parse_manifest(r#"{ "id": "a b", "name": "A", "version": "1" }"#, "t").is_err());
        assert!(parse_manifest(r#"{ "id": "a", "name": "", "version": "1" }"#, "t").is_err());
        assert!(parse_manifest(r#"{ "id": "a", "name": "A", "version": "1", "main": "x.ts" }"#, "t").is_err());
        assert!(parse_manifest("not json", "t").is_err());
    }

    #[test]
    fn builtin_catalog_manifests_are_valid() {
        for &(id, manifest_raw, _, _) in BUILTIN_CATALOG {
            let manifest = parse_manifest(manifest_raw, id).unwrap();
            assert_eq!(manifest.id, id);
        }
    }

    fn unique_temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("lite-ide-plugins-test-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_sample_plugin(dir: &Path, id: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("plugin.json"),
            format!(
                r#"{{ "id": "{id}", "name": "{id}", "version": "0.1.0", "main": "main.js" }}"#
            ),
        )
        .unwrap();
        fs::write(dir.join("main.js"), "liteide.plugin({ activate() {} })").unwrap();
    }

    #[test]
    fn install_from_path_list_read_entry_and_uninstall_round_trip() {
        let workspace = unique_temp_dir("roundtrip");
        let source = workspace.join("source-plugin");
        write_sample_plugin(&source, "sample-a");

        let manager = PluginManager::with_root(workspace.join("root"));
        let installed = manager.install_from_path(source.to_str().unwrap()).unwrap();
        assert_eq!(installed.manifest.id, "sample-a");
        assert!(installed.error.is_none());

        // 重复安装同 id 被拒。
        assert!(manager.install_from_path(source.to_str().unwrap()).is_err());

        let list = manager.list().unwrap();
        assert_eq!(list.plugins.len(), 1);
        assert_eq!(list.plugins[0].manifest.id, "sample-a");

        assert!(manager
            .read_entry("sample-a")
            .unwrap()
            .contains("liteide.plugin"));

        // 目录安装走同一份内嵌内容。
        manager.install_from_catalog("hello-status").unwrap();
        assert!(manager.read_entry("hello-status").unwrap().contains("liteide.plugin"));
        assert_eq!(manager.list().unwrap().plugins.len(), 2);

        manager.uninstall("sample-a").unwrap();
        assert!(manager.read_entry("sample-a").is_err());
        assert_eq!(manager.list().unwrap().plugins.len(), 1);

        // 无效 id 无法当作用户输入越权删目录。
        assert!(manager.uninstall("../root").is_err());

        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn install_from_path_rejects_folder_without_manifest() {
        let workspace = unique_temp_dir("invalid");
        let source = workspace.join("no-manifest");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("main.js"), "liteide.plugin({})").unwrap();

        let manager = PluginManager::with_root(workspace.join("root"));
        let err = manager.install_from_path(source.to_str().unwrap()).unwrap_err();
        assert!(err.to_string().contains("plugin.json"));

        // 损坏 manifest 的已装目录在列表里以 error 形态出现且可卸载。
        let broken = manager.root.join("broken-plugin");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join("plugin.json"), "not json").unwrap();
        let list = manager.list().unwrap();
        let entry = list.plugins.iter().find(|p| p.dir_name == "broken-plugin").unwrap();
        assert!(entry.error.is_some());
        manager.uninstall("broken-plugin").unwrap();
        assert!(manager.list().unwrap().plugins.is_empty());

        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn folder_with_mismatched_manifest_id_is_flagged_but_uninstallable() {
        let workspace = unique_temp_dir("mismatch");
        let manager = PluginManager::with_root(workspace.join("root"));

        // 手动放入的文件夹名与其 manifest id 不一致：以 error 形态暴露，
        // 身份回退为文件夹名，卸载/读取均按目录命中而不是报 not installed。
        let dir = manager.root.join("gruvbox-master");
        write_sample_plugin(&dir, "theme-gruvbox");
        let list = manager.list().unwrap();
        let entry = list.plugins.iter().find(|p| p.dir_name == "gruvbox-master").unwrap();
        assert!(entry.error.as_deref().unwrap().contains("does not match folder name"));
        assert_eq!(entry.manifest.id, "gruvbox-master");

        assert!(manager.read_entry("theme-gruvbox").is_err());
        manager.uninstall("gruvbox-master").unwrap();
        assert!(manager.list().unwrap().plugins.is_empty());

        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn read_entry_rejects_oversized_entry_scripts() {
        let workspace = unique_temp_dir("oversize");
        let manager = PluginManager::with_root(workspace.join("root"));
        let dir = manager.root.join("chunky-plugin");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("plugin.json"),
            r#"{ "id": "chunky-plugin", "name": "Chunky", "version": "0.1.0" }"#,
        )
        .unwrap();
        fs::write(dir.join("main.js"), "x".repeat(600 * 1024)).unwrap();

        let err = manager.read_entry("chunky-plugin").unwrap_err();
        assert!(err.to_string().contains("exceeds"));

        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn manifest_v2_fields_are_validated() {
        let bundle = r#"{
            "id": "b", "name": "B", "version": "1.0.0",
            "main": "plugin.js", "format": "bundle", "css": "plugin.css",
            "chunks": { "logView": "log-view.js" }, "api": 2
        }"#;
        let manifest = parse_manifest(bundle, "test").unwrap();
        assert!(manifest.is_bundle());
        assert_eq!(manifest.entry_file_name(), "plugin.js");
        assert!(manifest.declares_asset("plugin.css"));
        assert!(manifest.declares_asset("log-view.js"));
        assert!(!manifest.declares_asset("other.css"));

        // 非法 format / 带路径的 css / 非 js chunk 一律拒绝。
        assert!(parse_manifest(
            r#"{ "id": "b", "name": "B", "version": "1", "format": "esm" }"#,
            "t"
        )
        .is_err());
        assert!(parse_manifest(
            r#"{ "id": "b", "name": "B", "version": "1", "css": "assets/plugin.css" }"#,
            "t"
        )
        .is_err());
        assert!(parse_manifest(
            r#"{ "id": "b", "name": "B", "version": "1", "chunks": { "a": "a.ts" } }"#,
            "t"
        )
        .is_err());
        assert!(parse_manifest(
            r#"{ "id": "b", "name": "B", "version": "1", "api": "2" }"#,
            "t"
        )
        .is_err());
    }

    #[test]
    fn asset_file_name_validation_rejects_paths_and_other_extensions() {
        assert!(is_valid_asset_file_name("plugin.css"));
        assert!(is_valid_asset_file_name("log-view.js"));
        assert!(is_valid_asset_file_name("Chunk.CSS"));
        assert!(!is_valid_asset_file_name("assets/plugin.css"));
        assert!(!is_valid_asset_file_name("a\\b.css"));
        assert!(!is_valid_asset_file_name("readme.md"));
        assert!(!is_valid_asset_file_name(""));
        assert!(!is_valid_asset_file_name(".."));
        // Windows 盘符相对路径与保留设备名。
        assert!(!is_valid_asset_file_name("c:plugin.css"));
        assert!(!is_valid_asset_file_name("C:plugin.css"));
        assert!(!is_valid_asset_file_name("con.css"));
        assert!(!is_valid_asset_file_name("com1.js"));
    }

    #[test]
    fn catalog_bundle_sample_installs_with_assets_and_serves_declared_only() {
        let workspace = unique_temp_dir("bundle-sample");
        let manager = PluginManager::with_root(workspace.join("root"));

        let installed = manager.install_from_catalog("bundle-notes").unwrap();
        assert!(installed.error.is_none());

        let css = manager.read_asset("bundle-notes", "plugin.css").unwrap();
        assert!(css.contains("tailwindcss"));
        let chunk = manager.read_asset("bundle-notes", "log-view.js").unwrap();
        assert!(!chunk.is_empty());

        // 入口本身未被 manifest 声明为资产，不可经 read_asset 捞取。
        assert!(manager.read_asset("bundle-notes", "plugin.js").is_err());
        // 未声明文件与穿越路径被拒。
        assert!(manager.read_asset("bundle-notes", "plugin.json").is_err());
        assert!(manager.read_asset("bundle-notes", "../plugin.json").is_err());
        assert!(manager.read_asset("bundle-notes", "secret.txt").is_err());
        // 未安装插件。
        assert!(manager.read_asset("nope", "plugin.css").is_err());

        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn read_asset_rejects_oversized_assets() {
        let workspace = unique_temp_dir("asset-oversize");
        let manager = PluginManager::with_root(workspace.join("root"));
        let dir = manager.root.join("fat-assets");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("plugin.json"),
            r#"{ "id": "fat-assets", "name": "Fat", "version": "1.0.0", "css": "plugin.css" }"#,
        )
        .unwrap();
        fs::write(dir.join("plugin.css"), "x".repeat(7 * 1024 * 1024)).unwrap();

        let err = manager.read_asset("fat-assets", "plugin.css").unwrap_err();
        assert!(err.to_string().contains("exceeds"));

        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn bundle_format_entries_get_a_larger_size_cap_than_classic() {
        let workspace = unique_temp_dir("bundle-cap");
        let source = workspace.join("big-bundle");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("plugin.json"),
            r#"{ "id": "big-bundle", "name": "Big", "version": "1.0.0", "format": "bundle" }"#,
        )
        .unwrap();
        fs::write(source.join("main.js"), "x".repeat(600 * 1024)).unwrap();

        let manager2 = PluginManager::with_root(workspace.join("root"));
        manager2.install_from_path(source.to_str().unwrap()).unwrap();
        // 600 KB 的 classic 入口会被拒（见 oversize 测试），bundle 放行。
        assert_eq!(manager2.read_entry("big-bundle").unwrap().len(), 600 * 1024);

        let _ = fs::remove_dir_all(&workspace);
    }
}
