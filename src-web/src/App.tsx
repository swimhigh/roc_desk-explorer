import { useCallback, useEffect, useMemo, useState } from "react";
import { localFsService } from "./services/localFsService";
import type { FileEntry } from "./types/bindings";

type ClipboardItem = { path: string; isDir: boolean; mode: "copy" | "move" };

type Dialog =
  | { kind: "newFolder" }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "delete"; entry: FileEntry };

type ContextMenuState = { x: number; y: number; entry: FileEntry | null };

function parentPath(path: string): string | null {
  const normalized = path.replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  if (idx < 0) return null;
  // 保留盘符根目录的斜杠，例如 "C:" -> "C:/"
  if (idx === 0) return "/";
  if (/^[A-Za-z]:$/.test(normalized.slice(0, idx))) {
    return normalized.slice(0, idx) + "/";
  }
  return normalized.slice(0, idx);
}

function joinPath(dir: string, name: string): string {
  if (dir.endsWith("/")) return dir + name;
  return dir + "/" + name;
}

function formatSize(size: number | null | undefined): string {
  if (size === null || size === undefined) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatTime(modified: number | null | undefined): string {
  if (modified === null || modified === undefined) return "";
  const date = new Date(modified * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export default function App() {
  const [path, setPath] = useState<string>("");
  const [pathInput, setPathInput] = useState<string>("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [drives, setDrives] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardItem | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogInput, setDialogInput] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (dir: string) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const list = await localFsService.listDir(dir);
      list.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        return a.name.localeCompare(b.name, "zh-CN");
      });
      setEntries(list);
      setPath(dir);
      setPathInput(dir);
      setSelected(null);
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [home, driveList] = await Promise.all([
          localFsService.homeDir(),
          localFsService.listDrives(),
        ]);
        setDrives(driveList);
        await load(home);
      } catch (e) {
        setErrorMsg(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!contextMenu) return;
    const onClick = () => closeContextMenu();
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [contextMenu, closeContextMenu]);

  const goUp = useCallback(() => {
    const parent = parentPath(path);
    if (parent) load(parent);
  }, [path, load]);

  const openEntry = useCallback(
    async (entry: FileEntry) => {
      if (entry.is_dir) {
        load(entry.path);
        return;
      }
      try {
        await localFsService.openExternally(entry.path);
      } catch (e) {
        setErrorMsg(String(e));
      }
    },
    [load],
  );

  const runAction = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setErrorMsg(null);
      try {
        await fn();
        await load(path);
      } catch (e) {
        setErrorMsg(String(e));
      } finally {
        setBusy(false);
      }
    },
    [load, path],
  );

  const selectedEntry = useMemo(
    () => entries.find((e) => e.path === selected) ?? null,
    [entries, selected],
  );

  const handlePaste = useCallback(() => {
    if (!clipboard) return;
    const targetName = clipboard.path.split("/").filter(Boolean).pop() ?? "copy";
    const dest = joinPath(path, targetName);
    runAction(async () => {
      if (clipboard.mode === "copy") {
        await localFsService.copy(clipboard.path, dest, clipboard.isDir);
      } else {
        await localFsService.move(clipboard.path, dest, clipboard.isDir);
        setClipboard(null);
      }
    });
  }, [clipboard, path, runAction]);

  const submitDialog = useCallback(() => {
    if (!dialog) return;
    const name = dialogInput.trim();
    if (!name) return;
    if (dialog.kind === "newFolder") {
      runAction(() => localFsService.createDir(joinPath(path, name)));
    } else if (dialog.kind === "rename") {
      const dest = joinPath(parentPath(dialog.entry.path) ?? path, name);
      runAction(() => localFsService.rename(dialog.entry.path, dest));
    }
    setDialog(null);
    setDialogInput("");
  }, [dialog, dialogInput, path, runAction]);

  const confirmDelete = useCallback(() => {
    if (!dialog || dialog.kind !== "delete") return;
    runAction(() => localFsService.deletePath(dialog.entry.path, dialog.entry.is_dir));
    setDialog(null);
  }, [dialog, runAction]);

  return (
    <div style={styles.root} onContextMenu={(e) => e.preventDefault()}>
      <div style={styles.toolbar}>
        <button style={styles.btn} onClick={goUp} disabled={!parentPath(path)}>
          ↑ 上级
        </button>
        <button style={styles.btn} onClick={() => load(path)}>
          ⟳ 刷新
        </button>
        <input
          style={styles.pathInput}
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") load(pathInput);
          }}
        />
        {drives.length > 0 && (
          <select
            style={styles.btn}
            value=""
            onChange={(e) => {
              if (e.target.value) load(e.target.value);
            }}
          >
            <option value="">盘符</option>
            {drives.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        )}
        <button
          style={styles.btn}
          onClick={() => {
            setDialog({ kind: "newFolder" });
            setDialogInput("");
          }}
        >
          + 新建文件夹
        </button>
        <button style={styles.btn} disabled={!clipboard} onClick={handlePaste}>
          粘贴
        </button>
        <button
          style={styles.btn}
          disabled={!selectedEntry}
          onClick={() =>
            selectedEntry &&
            setClipboard({ path: selectedEntry.path, isDir: selectedEntry.is_dir, mode: "copy" })
          }
        >
          复制
        </button>
        <button
          style={styles.btn}
          disabled={!selectedEntry}
          onClick={() =>
            selectedEntry &&
            setClipboard({ path: selectedEntry.path, isDir: selectedEntry.is_dir, mode: "move" })
          }
        >
          剪切
        </button>
        <button
          style={styles.btn}
          disabled={!selectedEntry}
          onClick={() => {
            if (!selectedEntry) return;
            setDialog({ kind: "rename", entry: selectedEntry });
            setDialogInput(selectedEntry.name);
          }}
        >
          重命名
        </button>
        <button
          style={{ ...styles.btn, color: "#f87171" }}
          disabled={!selectedEntry}
          onClick={() => selectedEntry && setDialog({ kind: "delete", entry: selectedEntry })}
        >
          删除
        </button>
      </div>

      {errorMsg && <div style={styles.error}>{errorMsg}</div>}
      {(loading || busy) && <div style={styles.status}>处理中…</div>}

      <div style={styles.listWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>名称</th>
              <th style={{ ...styles.th, width: 100, textAlign: "right" }}>大小</th>
              <th style={{ ...styles.th, width: 150 }}>修改时间</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.path}
                style={{
                  ...styles.row,
                  background: selected === entry.path ? "#1f2937" : "transparent",
                }}
                onClick={() => setSelected(entry.path)}
                onDoubleClick={() => openEntry(entry)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSelected(entry.path);
                  setContextMenu({ x: e.clientX, y: e.clientY, entry });
                }}
              >
                <td style={styles.td}>
                  {entry.is_dir ? "📁" : "📄"} {entry.name}
                </td>
                <td style={{ ...styles.td, textAlign: "right" }}>
                  {entry.is_dir ? "" : formatSize(entry.size)}
                </td>
                <td style={styles.td}>{formatTime(entry.modified)}</td>
              </tr>
            ))}
            {entries.length === 0 && !loading && (
              <tr>
                <td style={styles.td} colSpan={3}>
                  （空目录）
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {contextMenu && (
        <div
          style={{ ...styles.contextMenu, left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.entry && (
            <>
              <div style={styles.menuItem} onClick={() => openEntry(contextMenu.entry!)}>
                打开
              </div>
              <div
                style={styles.menuItem}
                onClick={() => {
                  setClipboard({
                    path: contextMenu.entry!.path,
                    isDir: contextMenu.entry!.is_dir,
                    mode: "copy",
                  });
                  closeContextMenu();
                }}
              >
                复制
              </div>
              <div
                style={styles.menuItem}
                onClick={() => {
                  setClipboard({
                    path: contextMenu.entry!.path,
                    isDir: contextMenu.entry!.is_dir,
                    mode: "move",
                  });
                  closeContextMenu();
                }}
              >
                剪切
              </div>
              <div
                style={styles.menuItem}
                onClick={() => {
                  setDialog({ kind: "rename", entry: contextMenu.entry! });
                  setDialogInput(contextMenu.entry!.name);
                  closeContextMenu();
                }}
              >
                重命名
              </div>
              <div
                style={{ ...styles.menuItem, color: "#f87171" }}
                onClick={() => {
                  setDialog({ kind: "delete", entry: contextMenu.entry! });
                  closeContextMenu();
                }}
              >
                删除
              </div>
            </>
          )}
          <div
            style={{ ...styles.menuItem, opacity: clipboard ? 1 : 0.4 }}
            onClick={() => {
              if (clipboard) handlePaste();
              closeContextMenu();
            }}
          >
            粘贴
          </div>
          <div
            style={styles.menuItem}
            onClick={() => {
              setDialog({ kind: "newFolder" });
              setDialogInput("");
              closeContextMenu();
            }}
          >
            新建文件夹
          </div>
        </div>
      )}

      {dialog && dialog.kind !== "delete" && (
        <div style={styles.modalOverlay}>
          <div style={styles.modal}>
            <div style={{ marginBottom: 8 }}>
              {dialog.kind === "newFolder" ? "新建文件夹" : "重命名"}
            </div>
            <input
              autoFocus
              style={styles.modalInput}
              value={dialogInput}
              onChange={(e) => setDialogInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitDialog();
                if (e.key === "Escape") setDialog(null);
              }}
            />
            <div style={styles.modalActions}>
              <button style={styles.btn} onClick={() => setDialog(null)}>
                取消
              </button>
              <button style={styles.btn} onClick={submitDialog}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog && dialog.kind === "delete" && (
        <div style={styles.modalOverlay}>
          <div style={styles.modal}>
            <div style={{ marginBottom: 12 }}>
              确定要删除 “{dialog.entry.name}” 吗？（移入回收站）
            </div>
            <div style={styles.modalActions}>
              <button style={styles.btn} onClick={() => setDialog(null)}>
                取消
              </button>
              <button style={{ ...styles.btn, color: "#f87171" }} onClick={confirmDelete}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    userSelect: "none",
  },
  toolbar: {
    display: "flex",
    gap: 6,
    alignItems: "center",
    padding: 8,
    borderBottom: "1px solid #374151",
    flexWrap: "wrap",
  },
  btn: {
    background: "#1f2937",
    color: "#e5e7eb",
    border: "1px solid #374151",
    borderRadius: 4,
    padding: "6px 10px",
    cursor: "pointer",
  },
  pathInput: {
    flex: 1,
    minWidth: 200,
    background: "#0b1220",
    color: "#e5e7eb",
    border: "1px solid #374151",
    borderRadius: 4,
    padding: "6px 8px",
  },
  error: {
    padding: "6px 12px",
    background: "#7f1d1d",
    color: "#fecaca",
  },
  status: {
    padding: "4px 12px",
    color: "#9ca3af",
  },
  listWrap: {
    flex: 1,
    overflow: "auto",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
  },
  th: {
    textAlign: "left",
    padding: "6px 12px",
    borderBottom: "1px solid #374151",
    color: "#9ca3af",
    position: "sticky",
    top: 0,
    background: "#111827",
  },
  row: {
    cursor: "default",
  },
  td: {
    padding: "5px 12px",
    borderBottom: "1px solid #1f2937",
    whiteSpace: "nowrap",
  },
  contextMenu: {
    position: "fixed",
    background: "#1f2937",
    border: "1px solid #374151",
    borderRadius: 4,
    padding: 4,
    minWidth: 120,
    zIndex: 20,
    boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
  },
  menuItem: {
    padding: "6px 10px",
    borderRadius: 4,
    cursor: "pointer",
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 30,
  },
  modal: {
    background: "#1f2937",
    border: "1px solid #374151",
    borderRadius: 6,
    padding: 16,
    minWidth: 320,
  },
  modalInput: {
    width: "100%",
    background: "#0b1220",
    color: "#e5e7eb",
    border: "1px solid #374151",
    borderRadius: 4,
    padding: "6px 8px",
  },
  modalActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 12,
  },
};
