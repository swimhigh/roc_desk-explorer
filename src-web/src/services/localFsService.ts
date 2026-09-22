import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "../types/bindings";

/** 独立版资源管理器唯一用到的本地文件系统命令封装，和 standalone/src/main.rs 里
 * 注册的 19 个 `roc_desk_explorer::cmd::local_*` 命令一一对应。 */
export const localFsService = {
  listDir(path: string): Promise<FileEntry[]> {
    return invoke("local_list_dir", { path });
  },
  homeDir(): Promise<string> {
    return invoke("local_home_dir");
  },
  listDrives(): Promise<string[]> {
    return invoke("local_list_drives");
  },
  isDir(path: string): Promise<boolean> {
    return invoke("local_is_dir", { path });
  },
  deletePath(path: string, isDir: boolean): Promise<void> {
    return invoke("local_delete", { path, isDir });
  },
  rename(from: string, to: string): Promise<void> {
    return invoke("local_rename", { from, to });
  },
  copy(from: string, to: string, isDir: boolean): Promise<void> {
    return invoke("local_copy", { from, to, isDir });
  },
  move(from: string, to: string, isDir: boolean): Promise<void> {
    return invoke("local_move", { from, to, isDir });
  },
  createDir(path: string): Promise<void> {
    return invoke("local_create_dir", { path });
  },
  openExternally(path: string): Promise<void> {
    return invoke("local_open_externally", { path });
  },
};
