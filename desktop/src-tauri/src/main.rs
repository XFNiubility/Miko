// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    // Determine if we should start in portable mode and set CLAUDE_CONFIG_DIR
    // before any Tauri/WebView2 initialization.
    //
    // Mode resolution order:
    //   1. External CLAUDE_CONFIG_DIR env var (batch script etc.) — always respected
    //   2. Persisted app-mode.json saying "portable"
    //   3. Auto-detect: default portable dir already has data files
    //
    // In "default" mode the app does NOT set CLAUDE_CONFIG_DIR itself.
    // It relies on the env var (if set externally) or falls back to system dirs.
    // All existing std::env::var("CLAUDE_CONFIG_DIR") checks in lib.rs handle this.

    if let Some(portable_dir) = determine_startup_portable_dir() {
        std::env::set_var(
            "CLAUDE_CONFIG_DIR",
            portable_dir.to_string_lossy().to_string(),
        );
        std::env::set_var("CC_HAHA_APP_PORTABLE_DIR", "1");
        configure_layered_env(Some(&portable_dir));
    } else if let Ok(config_dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        configure_layered_env(Some(Path::new(&config_dir)));
    } else {
        configure_layered_env(None);
    }

    // Redirect WebView2 user data into the cache layer instead of the install dir.
    if let Ok(cache_root) = std::env::var("KIMO_CACHE_ROOT") {
        let webview_data = PathBuf::from(&cache_root).join("EBWebView");
        if let Err(e) = fs::create_dir_all(&webview_data) {
            eprintln!("[desktop] failed to create EBWebView dir: {e}");
        }
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview_data);
    }

    miko_desktop_lib::run()
}

fn set_env_if_missing(key: &str, value: PathBuf) {
    if std::env::var_os(key).is_none() {
        std::env::set_var(key, value.to_string_lossy().to_string());
    }
}

fn create_env_dir_if_set(key: &str) {
    if let Some(value) = std::env::var_os(key) {
        if let Err(e) = fs::create_dir_all(PathBuf::from(value)) {
            eprintln!("[desktop] failed to create {key} dir: {e}");
        }
    }
}

fn current_exe_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.parent().map(Path::to_path_buf)
}

fn get_default_portable_dir() -> Option<PathBuf> {
    let exe_dir = current_exe_dir()?;
    Some(exe_dir.join("CLAUDE_CONFIG_DIR"))
}

fn default_user_data_root() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|dir| dir.join("Miko").join("data"));
    }

    #[cfg(target_os = "macos")]
    {
        return std::env::var_os("HOME").map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Miko")
                .join("data")
        });
    }

    #[cfg(target_os = "linux")]
    {
        return std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share")))
            .map(|dir| dir.join("Miko").join("data"));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

fn default_cache_root() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|dir| dir.join("Miko"));
    }

    #[cfg(target_os = "macos")]
    {
        return std::env::var_os("HOME").map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Caches")
                .join("Miko")
        });
    }

    #[cfg(target_os = "linux")]
    {
        return std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
            .map(|dir| dir.join("Miko"));
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

fn default_workspace_root() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .map(|dir| dir.join("Documents").join("Miko").join("mikospace"));
    }

    #[cfg(target_os = "macos")]
    {
        return std::env::var_os("HOME").map(|home| {
            PathBuf::from(home)
                .join("Documents")
                .join("Miko")
                .join("mikospace")
        });
    }

    #[cfg(target_os = "linux")]
    {
        return std::env::var_os("HOME").map(|home| {
            PathBuf::from(home)
                .join("Documents")
                .join("Miko")
                .join("mikospace")
        });
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

fn is_default_portable_config_dir(config_dir: &Path) -> bool {
    get_default_portable_dir()
        .as_ref()
        .map(|default_dir| default_dir == config_dir)
        .unwrap_or(false)
}

fn has_bundled_data_children(dir: &Path) -> bool {
    ["agents", "skills", "tools", "marketplace", "mcp-templates"]
        .iter()
        .any(|name| dir.join(name).is_dir())
}

fn bundled_data_root_candidate(dir: PathBuf) -> Option<PathBuf> {
    if has_bundled_data_children(&dir) {
        return Some(dir);
    }

    let data_dir = dir.join("data");
    if has_bundled_data_children(&data_dir) {
        return Some(data_dir);
    }

    None
}

fn resolve_bundled_data_root(exe_dir: &Path) -> Option<PathBuf> {
    let portable_root = exe_dir.join("bundled-data");
    if portable_root.exists() {
        return Some(portable_root);
    }

    for candidate in [
        exe_dir.join("resources"),
        exe_dir.join("_up_"),
        exe_dir.join("_up_").join("_up_"),
        exe_dir.join("_up"),
        exe_dir.join("_up").join("_up"),
        exe_dir.to_path_buf(),
    ] {
        if let Some(root) = bundled_data_root_candidate(candidate) {
            return Some(root);
        }
    }

    None
}

fn configure_layered_env(portable_config_dir: Option<&Path>) {
    let exe_dir = current_exe_dir();

    if let Some(exe_dir) = exe_dir.as_ref() {
        if let Some(bundled_data) = resolve_bundled_data_root(exe_dir) {
            set_env_if_missing("KIMO_BUNDLED_DATA_ROOT", bundled_data);
        }
    }

    if let Some(config_dir) = portable_config_dir {
        if let Some(exe_dir) = exe_dir.as_ref().filter(|_| is_default_portable_config_dir(config_dir)) {
            set_env_if_missing("KIMO_DATA_ROOT", exe_dir.join("userdata").join("data"));
            set_env_if_missing("KIMO_CACHE_ROOT", exe_dir.join("userdata").join("cache"));
            set_env_if_missing("KIMO_WORKSPACE_ROOT", exe_dir.join("mikospace"));
        } else {
            set_env_if_missing("KIMO_DATA_ROOT", config_dir.join("data"));
            set_env_if_missing("KIMO_CACHE_ROOT", config_dir.join("cache"));
            set_env_if_missing("KIMO_WORKSPACE_ROOT", config_dir.join("mikospace"));
        }
    } else {
        if let Some(data_root) = default_user_data_root() {
            set_env_if_missing("KIMO_DATA_ROOT", data_root);
        }
        if let Some(workspace_root) = default_workspace_root() {
            set_env_if_missing("KIMO_WORKSPACE_ROOT", workspace_root);
        }
        if let Some(cache_root) = default_cache_root() {
            set_env_if_missing("KIMO_CACHE_ROOT", cache_root);
        }
    }

    create_env_dir_if_set("KIMO_DATA_ROOT");
    create_env_dir_if_set("KIMO_CACHE_ROOT");
    create_env_dir_if_set("KIMO_WORKSPACE_ROOT");
}

/// Determine if we should start in portable mode.
/// Returns the portable config directory path if yes, None for default mode.
fn determine_startup_portable_dir() -> Option<PathBuf> {
    // 1. 如果外部已经设置了 CLAUDE_CONFIG_DIR 环境变量，我们不应该覆盖它，直接返回 None 让 main 保持原样
    if std::env::var("CLAUDE_CONFIG_DIR").is_ok() {
        return None;
    }

    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let mut default_portable = exe_dir.to_path_buf();
    default_portable.push("CLAUDE_CONFIG_DIR");

    // 辅助函数：读取 app-mode.json 获取模式和自定义便携路径
    fn get_mode_from_config(dir: &std::path::Path) -> Option<(String, Option<PathBuf>)> {
        let path = dir.join("app-mode.json");
        let data = std::fs::read_to_string(&path).ok()?;
        let parsed: serde_json::Value = serde_json::from_str(&data).ok()?;
        let mode = parsed
            .get("mode")
            .and_then(|m| m.as_str())
            .unwrap_or("default")
            .to_ascii_lowercase();
        let portable_dir = parsed
            .get("portable_dir")
            .and_then(|v| v.as_str())
            .map(PathBuf::from);
        Some((mode, portable_dir))
    }

    // 2. 优先检查便携目录本地的配置文件（保证移动便携版到新电脑依然生效，并能正确处理切回默认模式）
    if let Some((mode, portable_dir)) = get_mode_from_config(&default_portable) {
        if mode == "portable" {
            if dir_has_portable_data(&default_portable) {
                return Some(default_portable.clone());
            }
            return Some(portable_dir.unwrap_or(default_portable.clone()));
        } else {
            return None; // 明确设置了 default，直接使用系统默认
        }
    }

    // 3. 检查系统全局配置
    #[cfg(target_os = "windows")]
    let system_config: Option<PathBuf> = std::env::var("APPDATA").ok().map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let system_config: Option<PathBuf> = std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join("Library").join("Application Support"));
    #[cfg(target_os = "linux")]
    let system_config: Option<PathBuf> = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .map(|h| PathBuf::from(h).join(".config"))
        });

    if let Some(ref sys_cfg) = system_config {
        // 修复：必须使用 Tauri 默认的 bundle identifier
        let app_subdir = sys_cfg.join("com.kimo.desktop");
        if let Some((mode, portable_dir)) = get_mode_from_config(&app_subdir) {
            if mode == "portable" {
                return Some(portable_dir.unwrap_or(default_portable.clone()));
            } else {
                return None; // 明确设置了 default
            }
        }
    }

    // 4. 自动检测：如果默认便携目录中已经存在数据文件，则自动进入便携模式
    fn dir_has_portable_data(dir: &std::path::Path) -> bool {
        if !dir.is_dir() {
            return false;
        }
        [
            "settings.json",
            ".claude.json",
            ".mcp.json",
            "window-state.json",
            "terminal-config.json",
        ]
            .iter()
            .any(|f| dir.join(f).is_file())
            || dir.join("Cache").is_dir()
            || dir.join("EBWebView").is_dir()
            || dir.join("projects").is_dir()
            || dir.join("skills").is_dir()
            || dir.join("plugins").is_dir()
            || dir.join("cowork_plugins").is_dir()
    }

    if dir_has_portable_data(&default_portable) {
        return Some(default_portable);
    }

    None
}
