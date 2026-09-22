#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<roc_desk_common::fsops::FileEntry>, String> { roc_desk_explorer::list_local_dir(&path).await.map_err(|e| e.to_string()) }
fn main() { tauri::Builder::default().invoke_handler(tauri::generate_handler![list_dir]).run(tauri::generate_context!()).expect("failed to run standalone tool"); }
