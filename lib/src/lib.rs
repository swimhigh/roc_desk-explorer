//! 资源管理器：本地与远程文件浏览
//!
//! This crate is the stable integration boundary for the host and standalone
//! shell. It provides the 19 `local_*` Tauri commands (in the [`cmd`] module)
//! that back the resource-manager's "local filesystem" surface (Total
//! Commander-style dual-pane browsing, plus the "loose file" editor/preview
//! path that isn't bound to any workspace).
//!
//! Remote (SFTP / Windows Agent) browsing is intentionally NOT part of this
//! crate yet -- it overlaps with `roc_desk-ssh` and will be resolved when
//! that tool's split lands (see `docs/MULTI_REPO_SPLIT_PLAN.md` in the host
//! repository). The one command that stayed behind in the host is
//! `take_pending_open_paths`: it reads `AppState.pending_open_paths`, which
//! is host-specific state populated from `std::env::args()` on cold start
//! (Windows "Open with" / file association), and has no meaning outside the
//! host application.

pub const TOOL_NAME: &str = "roc_desk-explorer";
pub const TOOL_DESCRIPTION: &str = "资源管理器：本地与远程文件浏览";

/// Returns the user-visible metadata used by the standalone shell and host launcher.
pub fn tool_info() -> (&'static str, &'static str) {
    (TOOL_NAME, TOOL_DESCRIPTION)
}

/// The `#[tauri::command]` functions themselves must live in a submodule
/// (not directly at the crate root) -- Tauri's command macro emits a
/// `#[macro_export]` macro_rules item *and* a self-referential `pub use` of
/// the same name in the enclosing scope. At crate root those two land in the
/// exact same namespace and rustc rejects it as a duplicate definition
/// (`E0255`); one module of indirection keeps the two scopes distinct.
/// `standalone/src/main.rs` and the host reference these as
/// `roc_desk_explorer::cmd::local_list_dir`, etc.
pub mod cmd {
    use base64::Engine;
    use tauri::AppHandle;

    use roc_desk_common::fsops::{FileOps, LocalFileOps};
    use roc_desk_common::fsops::{
        FileContent, FileEntry, WriteOutcome, BINARY_PREVIEW_MAX_BYTES,
        EXECUTABLE_INSPECT_MAX_BYTES,
    };
    use roc_desk_common::binary_info::{self, BinaryInfo};
    use roc_desk_common::jar_info::{self, JarInfo};
    use roc_desk_common::{encoding, office_convert};
    use roc_desk_core::error::AppError;

    // -----------------------------------------------------------------------
    // Drive / directory navigation
    // -----------------------------------------------------------------------

    #[tauri::command]
    pub async fn local_list_dir(path: String) -> Result<Vec<FileEntry>, AppError> {
        LocalFileOps.list_dir(&path).await
    }

    /// Total Commander 式盘符列表：Windows 下浏览 D:\、E:\ 等必须能切换盘符。
    /// `A`..`Z` 逐个探测 `X:\` 是否存在——没有现成的"列出所有盘符" API 值得为这一个
    /// 小功能引入额外依赖。非 Windows 平台没有盘符概念，返回根目录。
    #[tauri::command]
    pub fn local_list_drives() -> Vec<String> {
        #[cfg(windows)]
        {
            (b'A'..=b'Z')
                .filter_map(|b| {
                    let letter = b as char;
                    let root = format!("{letter}:\\");
                    std::path::Path::new(&root)
                        .exists()
                        .then(|| format!("{letter}:/"))
                })
                .collect()
        }
        #[cfg(not(windows))]
        {
            vec!["/".to_string()]
        }
    }

    #[tauri::command]
    pub fn local_home_dir() -> Result<String, AppError> {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map(|p| p.replace('\\', "/"))
            .map_err(|_| AppError::Internal("无法定位用户主目录".into()))
    }

    /// 从外部窗口拖真实文件进双栏浏览器时，只有路径字符串，不带是文件还是目录——但
    /// 上传/复制命令的 `is_dir` 参数是真正决定走"整目录递归"还是"单文件"分支的，
    /// 不能瞎猜，调用方必须先问一次。
    #[tauri::command]
    pub async fn local_is_dir(path: String) -> Result<bool, AppError> {
        tokio::fs::metadata(&path)
            .await
            .map(|m| m.is_dir())
            .map_err(|e| AppError::Internal(format!("无法读取 {path}：{e}")))
    }

    // -----------------------------------------------------------------------
    // Total Commander 式本地双栏文件操作（不做工作区边界校验）
    // -----------------------------------------------------------------------

    #[tauri::command]
    pub async fn local_delete(path: String, is_dir: bool) -> Result<(), AppError> {
        let _ = is_dir;
        tokio::task::spawn_blocking(move || {
            trash::delete(&path).map_err(|e| AppError::Internal(format!("移入回收站失败: {e}")))
        })
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??;
        Ok(())
    }

    #[tauri::command]
    pub async fn local_rename(from: String, to: String) -> Result<(), AppError> {
        LocalFileOps.rename(&from, &to).await
    }

    #[tauri::command]
    pub async fn local_copy(from: String, to: String, is_dir: bool) -> Result<(), AppError> {
        LocalFileOps.copy(&from, &to, is_dir).await
    }

    #[tauri::command]
    pub async fn local_create_dir(path: String) -> Result<(), AppError> {
        LocalFileOps.create_dir(&path).await
    }

    /// "移动"：同一卷内先尝试原子 `rename`；跨盘符 `rename` 会报错（`std::fs::rename`
    /// 的固有限制），这时退化成"整份复制到目的地、成功后删掉源"，和资源管理器/Total
    /// Commander 跨盘移动文件时的实际行为一致。
    #[tauri::command]
    pub async fn local_move(from: String, to: String, is_dir: bool) -> Result<(), AppError> {
        if LocalFileOps.rename(&from, &to).await.is_ok() {
            return Ok(());
        }
        LocalFileOps.copy(&from, &to, is_dir).await?;
        LocalFileOps.delete(&from, is_dir).await
    }

    // -----------------------------------------------------------------------
    // "游离文件"读写/预览（拖拽、Ctrl+O、Windows 文件关联直接打开，不属于任何工作区）
    // -----------------------------------------------------------------------

    #[tauri::command]
    pub async fn local_read_file(path: String) -> Result<FileContent, AppError> {
        LocalFileOps.read_file_for_editor(&path).await
    }

    #[tauri::command]
    pub async fn local_write_file(
        path: String,
        content: String,
        expected_mtime: Option<i64>,
    ) -> Result<WriteOutcome, AppError> {
        LocalFileOps
            .write_file(&path, &content, expected_mtime)
            .await
    }

    #[tauri::command]
    pub async fn local_read_file_with_encoding(
        path: String,
        encoding_label: String,
    ) -> Result<FileContent, AppError> {
        let (bytes, mtime, total_size, truncated) =
            LocalFileOps.read_bytes_for_editor(&path).await?;
        let text = encoding::decode_with(&bytes, &encoding_label).map_err(AppError::Internal)?;
        Ok(FileContent {
            text,
            encoding: encoding_label,
            mtime,
            total_size,
            truncated,
        })
    }

    #[tauri::command]
    pub async fn local_write_file_with_encoding(
        path: String,
        content: String,
        encoding_label: String,
        expected_mtime: Option<i64>,
    ) -> Result<WriteOutcome, AppError> {
        let bytes = encoding::encode_with(&content, &encoding_label).map_err(AppError::Internal)?;
        LocalFileOps
            .write_file_bytes(&path, &bytes, expected_mtime)
            .await
    }

    #[tauri::command]
    pub async fn local_read_binary_preview(path: String) -> Result<String, AppError> {
        let bytes = LocalFileOps
            .read_binary_for_preview(&path, BINARY_PREVIEW_MAX_BYTES)
            .await?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    #[tauri::command]
    pub async fn local_open_externally(
        app_handle: AppHandle,
        path: String,
    ) -> Result<(), AppError> {
        open_path_or_launch_exe(&app_handle, &path)
    }

    #[tauri::command]
    pub async fn local_convert_legacy_office_to_pdf(path: String) -> Result<String, AppError> {
        let tmp_dir = std::env::temp_dir().join("roc_desk_office_convert");
        let pdf_path =
            office_convert::convert_to_pdf(std::path::Path::new(&path), &tmp_dir).await?;
        let bytes = tokio::fs::read(&pdf_path).await.map_err(AppError::from)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    #[tauri::command]
    pub async fn local_inspect_binary(path: String) -> Result<BinaryInfo, AppError> {
        let bytes = LocalFileOps
            .read_binary_for_preview(&path, EXECUTABLE_INSPECT_MAX_BYTES)
            .await?;
        binary_info::inspect(&bytes)
    }

    #[tauri::command]
    pub async fn local_peek_is_binary(path: String) -> Result<bool, AppError> {
        let (head, _mtime) = LocalFileOps.read_file_raw_bounded(&path, 64).await?;
        Ok(binary_info::looks_like_binary(&head))
    }

    #[tauri::command]
    pub async fn local_inspect_jar(path: String) -> Result<JarInfo, AppError> {
        let bytes = LocalFileOps
            .read_binary_for_preview(&path, EXECUTABLE_INSPECT_MAX_BYTES)
            .await?;
        jar_info::inspect(&bytes)
    }

    /// "用系统默认程序打开"：大多数文件类型交给 Tauri opener 插件；可执行文件（.exe）
    /// 单独处理——`open_path` 不会把子进程工作目录设成 exe 自己所在的文件夹，很多读
    /// 同目录配置文件的程序会因此找不到自己的配置。直接 spawn 该 exe、显式设置工作
    /// 目录为其父目录，效果才等价于"双击打开"。
    fn open_path_or_launch_exe(app_handle: &AppHandle, path: &str) -> Result<(), AppError> {
        let is_exe = std::path::Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("exe"))
            .unwrap_or(false);
        if is_exe {
            let mut cmd = std::process::Command::new(path);
            if let Some(dir) = std::path::Path::new(path).parent() {
                cmd.current_dir(dir);
            }
            cmd.spawn()
                .map_err(|e| AppError::Internal(format!("启动进程失败：{e}")))?;
            return Ok(());
        }
        use tauri_plugin_opener::OpenerExt;
        app_handle
            .opener()
            .open_path(path, None::<&str>)
            .map_err(|e| AppError::Internal(e.to_string()))
    }
}
