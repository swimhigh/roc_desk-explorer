//! 资源管理器：本地与远程文件浏览
//! 
//! This crate is the stable integration boundary for the host and standalone shell.
pub const TOOL_NAME: &str = "roc_desk-explorer";
pub const TOOL_DESCRIPTION: &str = "资源管理器：本地与远程文件浏览";

/// Returns the user-visible metadata used by the standalone shell and host launcher.
pub fn tool_info() -> (&'static str, &'static str) {
    (TOOL_NAME, TOOL_DESCRIPTION)
}

pub use roc_desk_common::fsops::{FileOps, LocalFileOps};

/// Lists a local directory through the shared filesystem contract.
pub async fn list_local_dir(path: &str) -> Result<Vec<roc_desk_common::fsops::FileEntry>, roc_desk_core::error::AppError> {
    use roc_desk_common::fsops::FileOps;
    LocalFileOps.list_dir(path).await
}

/// Reads a local text or binary file using the shared encoding-safe response.
pub async fn read_local_file(path: &str) -> Result<roc_desk_common::fsops::FileContent, roc_desk_core::error::AppError> {
    use roc_desk_common::fsops::FileOps;
    LocalFileOps.read_file(path).await
}

/// Writes a file and reports an optimistic-concurrency conflict instead of overwriting it.
pub async fn write_local_file(path: &str, text: &str, expected_mtime: Option<i64>) -> Result<roc_desk_common::fsops::WriteOutcome, roc_desk_core::error::AppError> {
    use roc_desk_common::fsops::FileOps;
    LocalFileOps.write_file(path, text, expected_mtime).await
}
