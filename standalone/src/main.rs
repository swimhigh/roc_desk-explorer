#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            roc_desk_explorer::cmd::local_list_dir,
            roc_desk_explorer::cmd::local_list_drives,
            roc_desk_explorer::cmd::local_home_dir,
            roc_desk_explorer::cmd::local_is_dir,
            roc_desk_explorer::cmd::local_delete,
            roc_desk_explorer::cmd::local_rename,
            roc_desk_explorer::cmd::local_copy,
            roc_desk_explorer::cmd::local_create_dir,
            roc_desk_explorer::cmd::local_move,
            roc_desk_explorer::cmd::local_read_file,
            roc_desk_explorer::cmd::local_write_file,
            roc_desk_explorer::cmd::local_read_file_with_encoding,
            roc_desk_explorer::cmd::local_write_file_with_encoding,
            roc_desk_explorer::cmd::local_read_binary_preview,
            roc_desk_explorer::cmd::local_open_externally,
            roc_desk_explorer::cmd::local_convert_legacy_office_to_pdf,
            roc_desk_explorer::cmd::local_inspect_binary,
            roc_desk_explorer::cmd::local_peek_is_binary,
            roc_desk_explorer::cmd::local_inspect_jar,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run standalone tool");
}
