import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface ProgressPayload {
  thumbnail?: string;
}

/**
 * Scroll-capture panel. Reproduces the original vanilla scroll-panel.html
 * behavior exactly (live preview thumbnail bottom-right, Esc/scroll-esc finish,
 * finalize_scroll_to_clipboard, result/error close), EXCEPT guidance/warning
 * hints now route to the bottom-center HUD pill via show_hud instead of
 * bottom-right floating text. The finalize "saved" confirmation is shown by
 * Rust (commands/scroll_capture.rs) — not duplicated here.
 */
export default function ScrollPanel() {
  const [thumb, setThumb] = useState<string | null>(null);

  // One-shot guards / cross-listener state held in refs (don't trigger renders).
  const cleaned = useRef(false);
  const gotFirstFrame = useRef(false);

  useEffect(() => {
    const win = getCurrentWindow();

    function cleanup() {
      if (cleaned.current) return;
      cleaned.current = true;
      emit("scroll-capture-done");
      win.close();
    }

    // FINISH = stop capture + copy result to clipboard.
    async function finish() {
      try {
        // Rust shows the saved-confirmation HUD pill itself.
        await invoke("finalize_scroll_to_clipboard");
      } catch (e) {
        console.error(e);
      } finally {
        invoke("hide_scroll_border").catch(() => {});
        cleanup();
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      }
    }
    window.addEventListener("keydown", onKeyDown);

    // Pre-capture hints via the bottom-center HUD. On mount: the scroll hint.
    // After 3s with no first frame: "Press Esc to finish". HUD auto-fades, so
    // no revert/loop logic needed.
    invoke("show_hud", { text: "Scroll down or right, steadily" }).catch(() => {});
    const hintTimer = window.setTimeout(() => {
      if (gotFirstFrame.current) return;
      invoke("show_hud", { text: "Press Esc to finish" }).catch(() => {});
    }, 3000);

    const unlisten: Promise<UnlistenFn>[] = [];

    // Esc pressed while ANOTHER window has focus: Rust relays a global Esc here.
    unlisten.push(listen("scroll-esc", () => finish()));

    unlisten.push(
      listen<ProgressPayload>("scroll-capture-progress", (ev) => {
        const p = ev.payload;
        if (p?.thumbnail) {
          setThumb("data:image/jpeg;base64," + p.thumbnail);
          if (!gotFirstFrame.current) gotFirstFrame.current = true;
        }
      }),
    );

    unlisten.push(
      listen<string>("scroll-capture-warning", (ev) => {
        if (ev.payload === "scroll-too-fast") {
          invoke("show_hud", { text: "⚠ Scroll slower for clean stitching" }).catch(() => {});
        }
      }),
    );

    // Rust shows the saved-confirmation HUD pill itself.
    unlisten.push(listen("scroll-capture-result", () => cleanup()));
    unlisten.push(listen("scroll-capture-error", () => cleanup()));

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearTimeout(hintTimer);
      for (const u of unlisten) u.then((fn) => fn()).catch(() => {});
    };
  }, []);

  return (
    <div className="flex h-screen w-screen select-none items-end justify-end p-[12px]">
      {thumb && (
        <img
          src={thumb}
          alt=""
          draggable={false}
          className="w-[220px] rounded-[8px] pointer-events-none select-none [-webkit-user-drag:none]"
        />
      )}
    </div>
  );
}
