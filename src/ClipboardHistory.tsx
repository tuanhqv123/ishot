import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";

type HistoryItem = {
  path: string;
  kind: "image" | "text";
  created_at_ms: number;
  size_bytes: number;
  width: number | null;
  height: number | null;
};

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export default function ClipboardHistory() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [textCache, setTextCache] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState(0);
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await invoke<HistoryItem[]>("list_clipboard_history");
      setItems(rows);
      // Prefetch text for first 20 text items so previews appear instantly.
      const toFetch = rows.filter((r) => r.kind === "text").slice(0, 20);
      for (const r of toFetch) {
        try {
          const txt = await invoke<string>("read_clipboard_text", { path: r.path });
          setTextCache((c) => ({ ...c, [r.path]: txt }));
        } catch {
          // ignore individual read failures
        }
      }
    } catch (e) {
      console.error("list_clipboard_history failed", e);
    }
  }, []);

  useEffect(() => {
    refresh();
    invoke<boolean>("is_clipboard_paused").then(setPaused).catch(() => {});
    const win = getCurrentWindow();
    const unlistenPromise = win.onFocusChanged(({ payload: focused }) => {
      if (focused) refresh();
    });
    const interval = window.setInterval(refresh, 2000);
    return () => {
      unlistenPromise.then((u) => u()).catch(() => {});
      window.clearInterval(interval);
    };
  }, [refresh]);

  const filtered = items.filter((it) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    if (it.kind === "text") {
      const text = textCache[it.path] || "";
      return text.toLowerCase().includes(q);
    }
    return it.path.toLowerCase().includes(q);
  });

  useEffect(() => {
    if (selected >= filtered.length) setSelected(Math.max(0, filtered.length - 1));
  }, [filtered.length, selected]);

  const copyAndHide = useCallback(async (item: HistoryItem) => {
    try {
      await invoke("copy_clipboard_item", { path: item.path });
      await getCurrentWindow().hide();
    } catch (e) {
      console.error("copy failed", e);
    }
  }, []);

  const deleteItem = useCallback(async (item: HistoryItem) => {
    try {
      await invoke("delete_clipboard_item", { path: item.path });
      await refresh();
    } catch (e) {
      console.error("delete failed", e);
    }
  }, [refresh]);

  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        await getCurrentWindow().hide();
        return;
      }
      // Ignore navigation keys when typing in the search box.
      const target = e.target as HTMLElement;
      const inInput = target && target.tagName === "INPUT";

      if (e.key === "ArrowDown") {
        if (inInput) return;
        e.preventDefault();
        setSelected((s) => Math.min(filtered.length - 1, s + 1));
      } else if (e.key === "ArrowUp") {
        if (inInput) return;
        e.preventDefault();
        setSelected((s) => Math.max(0, s - 1));
      } else if (e.key === "Enter") {
        if (inInput) {
          // Allow Enter in search to also copy the top result.
        }
        e.preventDefault();
        const item = filtered[selected];
        if (item) await copyAndHide(item);
      } else if ((e.key === "Backspace" || e.key === "Delete") && !inInput) {
        e.preventDefault();
        const item = filtered[selected];
        if (item) await deleteItem(item);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, selected, copyAndHide, deleteItem]);

  const togglePause = async () => {
    try {
      const next = await invoke<boolean>("toggle_clipboard_pause");
      setPaused(next);
    } catch (e) {
      console.error(e);
    }
  };

  const clearAll = async () => {
    if (!window.confirm("Clear all clipboard history?")) return;
    try {
      await invoke("clear_clipboard_history");
      await refresh();
    } catch (e) {
      console.error(e);
    }
  };

  // Lazy fetch text on demand for any item currently visible but uncached.
  useEffect(() => {
    const toFetch = filtered
      .filter((it) => it.kind === "text" && textCache[it.path] === undefined)
      .slice(0, 30);
    if (toFetch.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const it of toFetch) {
        if (cancelled) return;
        try {
          const txt = await invoke<string>("read_clipboard_text", { path: it.path });
          if (cancelled) return;
          setTextCache((c) => ({ ...c, [it.path]: txt }));
        } catch {
          /* ignore */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filtered, textCache]);

  return (
    <div className="ch-root">
      <div className="ch-topbar">
        <input
          className="ch-search"
          placeholder="Search clipboard…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        <button
          className={paused ? "ch-btn active" : "ch-btn"}
          onClick={togglePause}
          title="Pause clipboard capture"
        >
          {paused ? "Paused" : "Pause"}
        </button>
        <button className="ch-btn" onClick={clearAll} title="Clear all history">
          Clear
        </button>
      </div>

      <div className="ch-list" ref={listRef}>
        {filtered.length === 0 && (
          <div className="ch-empty">
            {items.length === 0 ? "No clipboard history yet." : "No matches."}
          </div>
        )}
        {filtered.map((it, idx) => (
          <Card
            key={it.path}
            item={it}
            selected={idx === selected}
            text={textCache[it.path]}
            onCopy={() => copyAndHide(it)}
            onDelete={() => deleteItem(it)}
            onSelect={() => setSelected(idx)}
          />
        ))}
      </div>

      <div className="ch-footer">↑↓ navigate · ↵ copy · ⌫ delete · esc close</div>
    </div>
  );
}

function Card({
  item,
  selected,
  text,
  onCopy,
  onDelete,
  onSelect,
}: {
  item: HistoryItem;
  selected: boolean;
  text: string | undefined;
  onCopy: () => void;
  onDelete: () => void;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selected && ref.current) {
      ref.current.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  return (
    <div
      ref={ref}
      className={selected ? "ch-card selected" : "ch-card"}
      onClick={onCopy}
      onMouseEnter={onSelect}
    >
      <button
        className="ch-delete"
        title="Delete"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        ×
      </button>
      {item.kind === "image" ? (
        <>
          <img className="ch-img" src={convertFileSrc(item.path)} alt="clipboard image" />
          <div className="ch-card-meta">
            <span>
              {item.width ?? "?"}×{item.height ?? "?"} · {formatSize(item.size_bytes)}
            </span>
            <span>{relativeTime(item.created_at_ms)}</span>
          </div>
        </>
      ) : (
        <>
          <div className="ch-text">
            {text === undefined ? "…" : text.length > 200 ? text.slice(0, 200) + "…" : text}
          </div>
          <div className="ch-card-meta">
            <span>{text ? `${text.length} chars` : formatSize(item.size_bytes)}</span>
            <span>{relativeTime(item.created_at_ms)}</span>
          </div>
        </>
      )}
    </div>
  );
}
