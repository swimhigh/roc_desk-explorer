import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { localFsService } from "./services/localFsService";
import type { FileEntry } from "./types/bindings";

/**
 * 双栏 Total Commander 式本地文件管理器——对应宿主 roc_desk 的
 * "资源管理器"工作台（`LocalExplorerScreen.tsx`）里"本地↔本地"这部分功能。
 *
 * 这个独立版只搬本地文件操作（19 个 `local_*` 命令都是纯本地的），不包含宿主版本
 * 的 SSH/Agent 远程标签页、内嵌终端——这两块依赖的后端命令(`sftp_*`/`agent_*`/
 * PTY)不在 `roc_desk-explorer` 这个工具的范围内，要等 SSH 工具收尾时再接（见
 * 宿主仓库 docs/MULTI_REPO_SPLIT_PROGRESS.md 的 Explorer 章节）。双栏、多标签、
 * F3-F8 功能键、复制/移动到对面这些和宿主行为保持一致。
 */

type Side = "left" | "right";
const OTHER: Record<Side, Side> = { left: "right", right: "left" };

interface FileTab {
  id: string;
  label: string;
  path: string;
  entries: FileEntry[];
  loading: boolean;
  selected: string[];
  anchor: string | null;
  filter: string;
  renaming: string | null;
  renameValue: string;
}

interface PaneState {
  tabs: FileTab[];
  activeId: string;
}

let tabSeq = 0;
function makeTabId(): string {
  tabSeq += 1;
  return `tab-${Date.now()}-${tabSeq}`;
}

const TABS_KEY = "roc_desk-explorer-standalone-tabs";
function loadPersistedPaths(side: Side): string[] {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<Side, string[]>>;
      const paths = parsed[side];
      if (Array.isArray(paths) && paths.every((p) => typeof p === "string")) return paths;
    }
  } catch {
    /* 存量数据格式不对就当没有 */
  }
  return [];
}
function savePersistedPaths(pane: Record<Side, PaneState>) {
  const data: Record<Side, string[]> = {
    left: pane.left.tabs.map((t) => t.path),
    right: pane.right.tabs.map((t) => t.path),
  };
  localStorage.setItem(TABS_KEY, JSON.stringify(data));
}

async function withBusyCursor<T>(fn: () => Promise<T>): Promise<T> {
  document.body.style.cursor = "wait";
  try {
    return await fn();
  } finally {
    document.body.style.cursor = "";
  }
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

function parentOf(path: string): string | null {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return null;
  const parent = trimmed.slice(0, idx);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}

function joinChildPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

function currentDrive(path: string): string {
  const m = /^([A-Za-z]:)\//.exec(path);
  return m ? m[1] : "";
}

function formatBytes(size: number | null | undefined): string {
  if (size === null || size === undefined) return "—";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatTime(modified: number | null | undefined): string {
  if (modified === null || modified === undefined) return "—";
  const d = new Date(modified * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function transferOne(entry: FileEntry, dstDir: string, mode: "copy" | "move"): Promise<void> {
  const target = joinChildPath(dstDir, entry.name);
  if (mode === "copy") await localFsService.copy(entry.path, target, entry.is_dir);
  else await localFsService.move(entry.path, target, entry.is_dir);
}

type Toast = { id: number; kind: "error" | "success"; text: string };
let toastSeq = 0;

type Menu = { side: Side; tabId: string; entry: FileEntry | null; x: number; y: number };
type DeleteTarget = { side: Side; tabId: string; entries: FileEntry[] };

export default function App() {
  const [pane, setPane] = useState<Record<Side, PaneState>>({
    left: { tabs: [], activeId: "" },
    right: { tabs: [], activeId: "" },
  });
  const [activeSide, setActiveSide] = useState<Side>("left");
  const [drives, setDrives] = useState<string[]>([]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const listRefs = useRef<Record<Side, HTMLDivElement | null>>({ left: null, right: null });
  const restoringRef = useRef(true);

  const push = useCallback((kind: Toast["kind"], text: string) => {
    toastSeq += 1;
    const id = toastSeq;
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const getTab = useCallback((side: Side, tabId: string): FileTab | undefined => pane[side].tabs.find((t) => t.id === tabId), [pane]);
  const activeTab = useCallback((side: Side): FileTab | undefined => getTab(side, pane[side].activeId), [getTab, pane]);

  const updateTab = useCallback((side: Side, tabId: string, patch: Partial<FileTab> | ((t: FileTab) => Partial<FileTab>)) => {
    setPane((prev) => ({
      ...prev,
      [side]: {
        ...prev[side],
        tabs: prev[side].tabs.map((t) => (t.id === tabId ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t)),
      },
    }));
  }, []);

  const navigate = useCallback(async (side: Side, tab: FileTab, path: string) => {
    updateTab(side, tab.id, { loading: true });
    try {
      const entries = await withBusyCursor(() => localFsService.listDir(path));
      const label = path.split(/[\\/]/).filter(Boolean).pop() || path;
      updateTab(side, tab.id, { path, entries, loading: false, selected: [], anchor: null, renaming: null, label });
    } catch (e) {
      updateTab(side, tab.id, { loading: false });
      push("error", `打开目录失败：${String(e)}`);
    }
  }, [updateTab, push]);

  const refresh = useCallback(async (side: Side, tabId: string) => {
    const tab = getTab(side, tabId);
    if (tab) await navigate(side, tab, tab.path);
  }, [getTab, navigate]);

  const addTab = useCallback((side: Side, path: string) => {
    const id = makeTabId();
    const tab: FileTab = {
      id,
      label: path,
      path,
      entries: [],
      loading: false,
      selected: [],
      anchor: null,
      filter: "",
      renaming: null,
      renameValue: "",
    };
    setPane((prev) => ({ ...prev, [side]: { tabs: [...prev[side].tabs, tab], activeId: id } }));
    setActiveSide(side);
    void navigate(side, tab, path);
  }, [navigate]);

  const closeTab = useCallback((side: Side, tabId: string) => {
    setPane((prev) => {
      const tabs = prev[side].tabs.filter((t) => t.id !== tabId);
      if (tabs.length === 0) return prev; // 每栏至少留一个标签
      const activeId = prev[side].activeId === tabId ? tabs[tabs.length - 1].id : prev[side].activeId;
      return { ...prev, [side]: { tabs, activeId } };
    });
  }, []);

  useEffect(() => {
    void localFsService.listDrives().then(setDrives).catch(() => {});
    (async () => {
      for (const side of ["left", "right"] as Side[]) {
        const persisted = loadPersistedPaths(side);
        if (persisted.length === 0) {
          const home = await localFsService.homeDir().catch(() => "C:/");
          addTab(side, home);
        } else {
          for (const p of persisted) addTab(side, p);
        }
      }
      restoringRef.current = false;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (restoringRef.current) return;
    savePersistedPaths(pane);
  }, [pane]);

  const visible = useCallback((tab: FileTab): FileEntry[] => {
    const sorted = sortEntries(tab.entries);
    if (!tab.filter) return sorted;
    const q = tab.filter.toLowerCase();
    return sorted.filter((e) => e.name.toLowerCase().includes(q));
  }, []);

  const openEntry = useCallback((side: Side, tab: FileTab, entry: FileEntry) => {
    if (entry.is_dir) {
      void navigate(side, tab, entry.path);
      return;
    }
    void withBusyCursor(() => localFsService.openExternally(entry.path)).catch((e) =>
      push("error", `打开失败：${String(e)}`),
    );
  }, [navigate, push]);

  const selectEntry = useCallback((side: Side, tab: FileTab, entry: FileEntry, e: React.MouseEvent) => {
    setActiveSide(side);
    updateTab(side, tab.id, (t) => {
      if (e.shiftKey && t.anchor) {
        const list = visible(t);
        const ai = list.findIndex((it) => it.path === t.anchor);
        const bi = list.findIndex((it) => it.path === entry.path);
        if (ai !== -1 && bi !== -1) {
          const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
          return { selected: list.slice(lo, hi + 1).map((it) => it.path) };
        }
      }
      if (e.ctrlKey || e.metaKey) {
        const set = new Set(t.selected);
        if (set.has(entry.path)) set.delete(entry.path);
        else set.add(entry.path);
        return { selected: [...set], anchor: entry.path };
      }
      return { selected: [entry.path], anchor: entry.path };
    });
  }, [updateTab, visible]);

  const startRename = useCallback((side: Side, tab: FileTab, entry: FileEntry) => {
    updateTab(side, tab.id, { renaming: entry.path, renameValue: entry.name });
  }, [updateTab]);

  const commitRename = useCallback(async (side: Side, tab: FileTab, entry: FileEntry) => {
    const newName = tab.renameValue.trim();
    updateTab(side, tab.id, { renaming: null });
    if (!newName || newName === entry.name) return;
    const to = joinChildPath(parentOf(entry.path) ?? tab.path, newName);
    try {
      await localFsService.rename(entry.path, to);
      await refresh(side, tab.id);
    } catch (e) {
      push("error", `重命名失败：${String(e)}`);
    }
  }, [updateTab, refresh, push]);

  const newFolder = useCallback(async (side: Side, tab: FileTab) => {
    const existing = new Set(tab.entries.map((e) => e.name));
    let name = "新建文件夹";
    let i = 1;
    while (existing.has(name)) {
      i += 1;
      name = `新建文件夹 ${i}`;
    }
    const path = joinChildPath(tab.path, name);
    try {
      await localFsService.createDir(path);
      await refresh(side, tab.id);
      updateTab(side, tab.id, { renaming: path, renameValue: name, selected: [path], anchor: path });
    } catch (e) {
      push("error", `新建文件夹失败：${String(e)}`);
    }
  }, [refresh, updateTab, push]);

  const transferSelected = useCallback(async (side: Side, mode: "copy" | "move") => {
    const src = activeTab(side);
    const dst = activeTab(OTHER[side]);
    if (!src || !dst) return;
    const items = src.entries.filter((e) => src.selected.includes(e.path));
    if (items.length === 0) return;
    let failed = 0;
    for (const item of items) {
      try {
        await transferOne(item, dst.path, mode);
      } catch (e) {
        failed += 1;
        push("error", `${item.name}：${String(e)}`);
      }
    }
    await refresh(OTHER[side], dst.id);
    if (mode === "move") await refresh(side, src.id);
    if (failed === 0) push("success", `${mode === "copy" ? "复制" : "移动"}完成（${items.length} 项）`);
  }, [activeTab, refresh, push]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const { side, tabId, entries } = deleteTarget;
    const tab = getTab(side, tabId);
    setDeleteTarget(null);
    if (!tab) return;
    let failed = 0;
    for (const entry of entries) {
      try {
        await localFsService.deletePath(entry.path, entry.is_dir);
      } catch (e) {
        failed += 1;
        push("error", `${entry.name}：${String(e)}`);
      }
    }
    await refresh(side, tabId);
    if (failed === 0) push("success", `已删除 ${entries.length} 项`);
  }, [deleteTarget, getTab, refresh, push]);

  const onListKeyDown = useCallback((side: Side, tab: FileTab) => (e: React.KeyboardEvent<HTMLDivElement>) => {
    const list = visible(tab);
    if (e.key === "Delete") {
      const selected = list.filter((it) => tab.selected.includes(it.path));
      if (selected.length > 0) setDeleteTarget({ side, tabId: tab.id, entries: selected });
      return;
    }
    if (e.key === "F5" || e.key === "F6") {
      e.preventDefault();
      void transferSelected(side, e.key === "F5" ? "copy" : "move");
      return;
    }
    if (e.key === "F7") {
      e.preventDefault();
      void newFolder(side, tab);
      return;
    }
    if (e.key === "F8") {
      e.preventDefault();
      const selected = list.filter((it) => tab.selected.includes(it.path));
      if (selected.length) setDeleteTarget({ side, tabId: tab.id, entries: selected });
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (list.length === 0) return;
    e.preventDefault();
    const idx = list.findIndex((it) => it.path === tab.anchor);
    const nextIdx = idx === -1 ? 0 : e.key === "ArrowDown" ? Math.min(idx + 1, list.length - 1) : Math.max(idx - 1, 0);
    const next = list[nextIdx];
    updateTab(side, tab.id, { selected: [next.path], anchor: next.path });
    listRefs.current[side]?.querySelector<HTMLElement>(`[data-path="${CSS.escape(next.path)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [visible, transferSelected, newFolder, updateTab]);

  const activeSrcTab = activeTab(activeSide);
  const activeSelectedCount = activeSrcTab?.selected.length ?? 0;

  const renderPane = (side: Side) => {
    const paneState = pane[side];
    const tab = activeTab(side);
    const isActive = activeSide === side;
    if (!tab) return <div style={styles.pane} />;
    const list = visible(tab);
    return (
      <div style={styles.pane} onMouseDownCapture={() => setActiveSide(side)}>
        <div style={styles.tabBar}>
          {paneState.tabs.map((t) => (
            <div
              key={t.id}
              className="explorer-std-tab"
              style={{
                ...styles.tab,
                ...(t.id === paneState.activeId ? styles.tabActive : {}),
              }}
              title={t.path}
              onClick={() => {
                setActiveSide(side);
                setPane((prev) => ({ ...prev, [side]: { ...prev[side], activeId: t.id } }));
              }}
            >
              <span style={styles.tabLabel}>{t.label}</span>
              {paneState.tabs.length > 1 && (
                <span
                  style={styles.tabClose}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(side, t.id);
                  }}
                >
                  ×
                </span>
              )}
            </div>
          ))}
          <button
            style={styles.tabAdd}
            title="新建标签页（复制当前目录）"
            onClick={() => addTab(side, tab.path)}
          >
            +
          </button>
        </div>

        <div style={styles.toolbar}>
          <select
            style={{ ...styles.input, width: 56, flex: "none" }}
            value={currentDrive(tab.path)}
            onChange={(e) => e.target.value && void navigate(side, tab, `${e.target.value}/`)}
            title="切换盘符"
          >
            {drives.map((d) => (
              <option key={d} value={d.replace(/\/$/, "")}>
                {d}
              </option>
            ))}
          </select>
          <button
            style={styles.iconBtn}
            title="上级目录"
            disabled={parentOf(tab.path) === null}
            onClick={() => {
              const up = parentOf(tab.path);
              if (up !== null) void navigate(side, tab, up);
            }}
          >
            ↑
          </button>
          <button style={styles.iconBtn} title="主目录" onClick={() => void localFsService.homeDir().then((h) => navigate(side, tab, h))}>
            ⌂
          </button>
          <input
            style={{ ...styles.input, flex: 1, fontFamily: "monospace" }}
            value={tab.path}
            onChange={(e) => updateTab(side, tab.id, { path: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") void navigate(side, tab, tab.path);
            }}
          />
          <button style={styles.iconBtn} title="刷新" onClick={() => void refresh(side, tab.id)}>
            ⟳
          </button>
        </div>

        <div style={styles.filterBar}>
          <input
            style={{ ...styles.input, flex: 1 }}
            placeholder="过滤文件名…"
            value={tab.filter}
            onChange={(e) => updateTab(side, tab.id, { filter: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape" && tab.filter) {
                e.stopPropagation();
                updateTab(side, tab.id, { filter: "" });
              }
            }}
          />
        </div>

        <div
          ref={(el) => { listRefs.current[side] = el; }}
          tabIndex={0}
          onFocus={() => setActiveSide(side)}
          onKeyDown={onListKeyDown(side, tab)}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest("[data-file-row]")) return;
            e.preventDefault();
            setActiveSide(side);
            setMenu({ side, tabId: tab.id, entry: null, x: e.clientX, y: e.clientY });
          }}
          style={{ ...styles.list, outline: isActive ? "1px solid #3b82f6" : "none", outlineOffset: -1 }}
        >
          <div style={styles.fileHeader}>
            <span>名称</span>
            <span>大小</span>
            <span>修改时间</span>
          </div>
          {tab.loading ? (
            <div style={styles.emptyMsg}>加载中…</div>
          ) : list.length === 0 ? (
            <div style={styles.emptyMsg}>{tab.filter ? "没有匹配的文件" : "此目录是空的"}</div>
          ) : (
            list.map((entry) => (
              <div
                key={entry.path}
                data-file-row
                data-path={entry.path}
                style={{
                  ...styles.fileRow,
                  ...(tab.selected.includes(entry.path) ? styles.fileRowSelected : {}),
                }}
                onClick={(e) => selectEntry(side, tab, entry, e)}
                onDoubleClick={() => openEntry(side, tab, entry)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  selectEntry(side, tab, entry, e);
                  setMenu({ side, tabId: tab.id, entry, x: e.clientX, y: e.clientY });
                }}
              >
                {tab.renaming === entry.path ? (
                  <input
                    autoFocus
                    style={styles.renameInput}
                    value={tab.renameValue}
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => updateTab(side, tab.id, { renameValue: e.target.value })}
                    onBlur={() => void commitRename(side, tab, entry)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename(side, tab, entry);
                      else if (e.key === "Escape") updateTab(side, tab.id, { renaming: null });
                    }}
                  />
                ) : (
                  <span style={styles.fileName}>
                    {entry.is_dir ? "📁" : "📄"} {entry.name}
                  </span>
                )}
                <span style={styles.fileMeta}>{entry.is_dir ? "—" : formatBytes(entry.size)}</span>
                <span style={styles.fileMeta}>{formatTime(entry.modified)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    );
  };

  const menuItems = useMemo(() => {
    if (!menu) return [] as { label: string; danger?: boolean; onClick: () => void }[];
    const tab = getTab(menu.side, menu.tabId);
    if (!tab) return [];
    const entry = menu.entry;
    const items: { label: string; danger?: boolean; onClick: () => void }[] = [];
    if (entry) {
      items.push({ label: entry.is_dir ? "打开" : "用默认程序打开", onClick: () => openEntry(menu.side, tab, entry) });
      items.push({ label: "重命名", onClick: () => startRename(menu.side, tab, entry) });
      items.push({ label: `复制到${menu.side === "left" ? "右" : "左"}侧`, onClick: () => void transferSelected(menu.side, "copy") });
      items.push({ label: `移动到${menu.side === "left" ? "右" : "左"}侧`, onClick: () => void transferSelected(menu.side, "move") });
      items.push({
        label: "删除",
        danger: true,
        onClick: () => {
          const entries = tab.entries.filter((e) => tab.selected.includes(e.path));
          setDeleteTarget({ side: menu.side, tabId: tab.id, entries: entries.length > 0 ? entries : [entry] });
        },
      });
    }
    items.push({ label: "新建文件夹 (F7)", onClick: () => void newFolder(menu.side, tab) });
    return items;
  }, [menu, getTab, openEntry, startRename, transferSelected, newFolder]);

  return (
    <div style={styles.root} onClick={() => menu && setMenu(null)}>
      <div style={styles.panes}>
        {renderPane("left")}
        <div style={styles.divider} />
        {renderPane("right")}
      </div>

      <div style={styles.functionBar}>
        <button style={styles.fnBtn} onClick={() => void transferSelected(activeSide, "copy")} disabled={activeSelectedCount === 0}>
          <kbd style={styles.kbd}>F5</kbd> 复制
        </button>
        <button style={styles.fnBtn} onClick={() => void transferSelected(activeSide, "move")} disabled={activeSelectedCount === 0}>
          <kbd style={styles.kbd}>F6</kbd> 移动
        </button>
        <button style={styles.fnBtn} onClick={() => activeSrcTab && void newFolder(activeSide, activeSrcTab)} disabled={!activeSrcTab}>
          <kbd style={styles.kbd}>F7</kbd> 新建
        </button>
        <button
          style={styles.fnBtn}
          onClick={() =>
            activeSrcTab &&
            setDeleteTarget({
              side: activeSide,
              tabId: activeSrcTab.id,
              entries: activeSrcTab.entries.filter((e) => activeSrcTab.selected.includes(e.path)),
            })
          }
          disabled={activeSelectedCount === 0}
        >
          <kbd style={styles.kbd}>F8</kbd> 删除
        </button>
        <button style={styles.fnBtn} onClick={() => void getCurrentWindow().close()}>
          <kbd style={styles.kbd}>Alt+F4</kbd> 退出
        </button>
      </div>

      <div style={styles.actionBar}>
        <button
          style={styles.actionBtn}
          title="重命名（选中一项）"
          disabled={activeSelectedCount !== 1}
          onClick={() => {
            if (!activeSrcTab) return;
            const entry = activeSrcTab.entries.find((e) => e.path === activeSrcTab.selected[0]);
            if (entry) startRename(activeSide, activeSrcTab, entry);
          }}
        >
          重命名
        </button>
        <button style={styles.actionBtn} title="复制到对面标签" disabled={activeSelectedCount === 0} onClick={() => void transferSelected(activeSide, "copy")}>
          复制→对面
        </button>
        <button style={styles.actionBtn} title="移动到对面标签" disabled={activeSelectedCount === 0} onClick={() => void transferSelected(activeSide, "move")}>
          移动→对面
        </button>
        <button
          style={{ ...styles.actionBtn, color: "#f87171" }}
          title="删除选中项"
          disabled={activeSelectedCount === 0}
          onClick={() =>
            activeSrcTab &&
            setDeleteTarget({
              side: activeSide,
              tabId: activeSrcTab.id,
              entries: activeSrcTab.entries.filter((e) => activeSrcTab.selected.includes(e.path)),
            })
          }
        >
          删除
        </button>
        <span style={styles.statusText}>
          {activeSelectedCount > 0
            ? `已选中 ${activeSelectedCount} 项（${activeSide === "left" ? "左" : "右"}侧）`
            : "点选文件后可用工具栏或右键操作；「+」新建标签页"}
        </span>
      </div>

      {menu && (
        <div style={{ ...styles.contextMenu, left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menuItems.map((item, i) => (
            <div
              key={i}
              style={{ ...styles.menuItem, ...(item.danger ? { color: "#f87171" } : {}) }}
              onClick={() => {
                item.onClick();
                setMenu(null);
              }}
            >
              {item.label}
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <div style={styles.modalOverlay}>
          <div style={styles.modal}>
            <div style={{ marginBottom: 12 }}>
              确定要删除
              {deleteTarget.entries.length === 1 ? (
                <> {deleteTarget.entries[0].is_dir ? "目录" : "文件"} “{deleteTarget.entries[0].name}”</>
              ) : (
                <> {deleteTarget.entries.length} 项</>
              )}
              吗？（移入回收站）
            </div>
            <div style={styles.modalActions}>
              <button style={styles.actionBtn} onClick={() => setDeleteTarget(null)}>
                取消
              </button>
              <button style={{ ...styles.actionBtn, color: "#f87171" }} onClick={() => void confirmDelete()}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={styles.toastStack}>
        {toasts.map((t) => (
          <div key={t.id} style={{ ...styles.toast, ...(t.kind === "error" ? styles.toastError : styles.toastSuccess) }}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100vh", background: "#111827", color: "#e5e7eb", userSelect: "none", fontSize: 12 },
  panes: { flex: 1, display: "flex", overflow: "hidden", minHeight: 0 },
  divider: { width: 1, background: "#374151", flexShrink: 0 },
  pane: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 },
  tabBar: { display: "flex", alignItems: "center", height: 26, overflowX: "auto", borderBottom: "1px solid #374151", flexShrink: 0 },
  tab: { display: "flex", alignItems: "center", gap: 4, padding: "0 8px", height: "100%", cursor: "pointer", borderRight: "1px solid #1f2937", whiteSpace: "nowrap", flexShrink: 0 },
  tabActive: { background: "#1f2937" },
  tabLabel: { maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" },
  tabClose: { color: "#9ca3af", cursor: "pointer", padding: "0 2px" },
  tabAdd: { width: 22, height: 22, flexShrink: 0, background: "transparent", color: "#e5e7eb", border: "none", cursor: "pointer" },
  toolbar: { display: "flex", alignItems: "center", gap: 4, padding: "3px 4px", borderBottom: "1px solid #1f2937", flexShrink: 0 },
  filterBar: { display: "flex", alignItems: "center", gap: 4, padding: "3px 4px", borderBottom: "1px solid #1f2937", flexShrink: 0 },
  input: { height: 22, fontSize: 12, background: "#0b1220", color: "#e5e7eb", border: "1px solid #374151", borderRadius: 4, padding: "0 6px" },
  iconBtn: { height: 22, width: 22, background: "#1f2937", color: "#e5e7eb", border: "1px solid #374151", borderRadius: 4, cursor: "pointer", flexShrink: 0 },
  list: { flex: 1, overflowY: "auto" },
  fileHeader: { display: "grid", gridTemplateColumns: "1fr 90px 110px", padding: "4px 8px", borderBottom: "1px solid #374151", color: "#9ca3af", position: "sticky", top: 0, background: "#111827" },
  fileRow: { display: "grid", gridTemplateColumns: "1fr 90px 110px", padding: "4px 8px", cursor: "default", borderBottom: "1px solid #1a2332" },
  fileRowSelected: { background: "#1e3a5f" },
  fileName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  fileMeta: { color: "#9ca3af", textAlign: "right" },
  emptyMsg: { padding: 16, fontSize: 12, color: "#9ca3af" },
  renameInput: { width: "100%", height: 18, fontSize: 12, background: "#0b1220", color: "#e5e7eb", border: "1px solid #3b82f6", borderRadius: 3, padding: "0 4px" },
  functionBar: { display: "flex", borderTop: "1px solid #374151", flexShrink: 0 },
  fnBtn: { flex: 1, background: "#1f2937", color: "#e5e7eb", border: "1px solid #1f2937", padding: "6px 4px", cursor: "pointer", fontSize: 12 },
  kbd: { background: "#374151", borderRadius: 3, padding: "1px 4px", marginRight: 4, fontSize: 11 },
  actionBar: { display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderTop: "1px solid #374151", flexShrink: 0 },
  actionBtn: { background: "#1f2937", color: "#e5e7eb", border: "1px solid #374151", borderRadius: 4, padding: "4px 10px", cursor: "pointer", fontSize: 12 },
  statusText: { marginLeft: "auto", fontSize: 11, color: "#9ca3af" },
  contextMenu: { position: "fixed", background: "#1f2937", border: "1px solid #374151", borderRadius: 4, padding: 4, minWidth: 140, zIndex: 20, boxShadow: "0 4px 12px rgba(0,0,0,0.4)" },
  menuItem: { padding: "6px 10px", borderRadius: 4, cursor: "pointer" },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 30 },
  modal: { background: "#1f2937", border: "1px solid #374151", borderRadius: 6, padding: 16, minWidth: 320 },
  modalActions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 },
  toastStack: { position: "fixed", right: 12, bottom: 12, display: "flex", flexDirection: "column", gap: 6, zIndex: 40 },
  toast: { padding: "8px 12px", borderRadius: 4, fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,0.4)" },
  toastError: { background: "#7f1d1d", color: "#fecaca" },
  toastSuccess: { background: "#14532d", color: "#bbf7d0" },
};
