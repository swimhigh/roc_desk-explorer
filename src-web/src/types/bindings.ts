// 对应后端 roc_desk_common::fsops::FileEntry（F:\code\wuyou\roc_tools\roc_desk-common\
// common\src\fsops.rs）。这里只是这个仓库自己的最小前端类型定义，不是自动生成的绑定。
export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number | null;
  modified?: number | null;
}
