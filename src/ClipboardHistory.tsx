import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type HistoryItem = {
  path: string;
  kind: "image" | "text";
  // Small cached thumbnail for fast list rendering (images only).
  thumb?: string | null;
  // Other backend fields (created_at_ms, size_bytes, width, height) are
  // intentionally unused — the UI shows content only, no metadata.
};

export default function ClipboardHistory() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [textCache, setTextCache] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState(0);
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await invoke<HistoryItem[]>("list_clipboard_history");
      setItems(rows);
      const toFetch = rows.filter((r) => r.kind === "text").slice(0, 30);
      for (const r of toFetch) {
        try {
          const txt = await invoke<string>("read_clipboard_text", { path: r.path });
          setTextCache((c) => ({ ...c, [r.path]: txt }));
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      console.error("list_clipboard_history failed", e);
    }
  }, []);

  useEffect(() => {
    refresh();
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

  // ESC just hides the panel — the native NSPanel stays alive for instant
  // re-show. tauri-nspanel's resign_key hook auto-hides on click outside
  // so we only need to handle keyboard dismiss here.
  const hide = useCallback(async () => {
    getCurrentWindow().hide().catch(() => {});
  }, []);

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
      await hide();
    } catch (e) {
      console.error("copy failed", e);
    }
  }, [hide]);

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
        await hide();
        return;
      }
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
  }, [filtered, selected, copyAndHide, deleteItem, hide]);

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
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
      </div>

        <div className="ch-list" ref={listRef}>
          {filtered.length === 0 && (
            <div className="ch-empty">
              {items.length === 0 ? "No clipboard history yet" : "No matches"}
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
  return (
    <div
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
        <img
          className="ch-img"
          src={convertFileSrc(item.thumb || item.path)}
          alt=""
          decoding="async"
        />
      ) : (
        <div className="ch-text">
          {text === undefined ? "…" : text.length > 400 ? text.slice(0, 400) + "…" : text}
        </div>
      )}
    </div>
  );
}
