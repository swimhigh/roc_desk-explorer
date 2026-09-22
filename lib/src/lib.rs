//! 资源管理器：本地与远程文件浏览
//! 
//! This crate is the stable integration boundary for the host and standalone shell.
pub const TOOL_NAME: &str = "roc_desk-explorer";
pub const TOOL_DESCRIPTION: &str = "资源管理器：本地与远程文件浏览";

/// Returns the user-visible metadata used by the standalone shell and host launcher.
pub fn tool_info() -> (&'static str, &'static str) {
    (TOOL_NAME, TOOL_DESCRIPTION)
}
