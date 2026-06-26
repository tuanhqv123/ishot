import { useEffect, useRef, useState } from "react";

/**
 * Frosted bottom-center HUD pill. Reproduces the original inline-HTML hud.html
 * exactly: read `text` (+ optional `ms`) from the query string, fade/scale in
 * via a double rAF, then fade out ~1.55s later. Rust (services/hud.rs) still
 * loads hud.html?text=... and tears down the window ~2s after that.
 */
export default function Hud() {
  const params = new URLSearchParams(location.search);
  const text = params.get("text") || "";

  // "hidden" → initial (opacity 0, nudged down/scaled), "show" → visible,
  // "hide" → fading back out before the window is destroyed.
  const [phase, setPhase] = useState<"hidden" | "show" | "hide">("hidden");
  const raf1 = useRef(0);
  const raf2 = useRef(0);
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    // Double rAF so the initial (hidden) styles paint first, then transition in.
    raf1.current = requestAnimationFrame(() => {
      raf2.current = requestAnimationFrame(() => setPhase("show"));
    });
    // Fade out just before Rust closes the window (~2s).
    hideTimer.current = window.setTimeout(() => setPhase("hide"), 1550);

    return () => {
      cancelAnimationFrame(raf1.current);
      cancelAnimationFrame(raf2.current);
      if (hideTimer.current !== undefined) clearTimeout(hideTimer.current);
    };
  }, []);

  const shown = phase === "show";

  return (
    <div className="flex h-screen w-screen select-none items-center justify-center [font-family:-apple-system,BlinkMacSystemFont,'SF_Pro_Text',sans-serif]">
      <div
        className={[
          "max-w-[92%] truncate px-[22px] py-[11px] rounded-[22px]",
          "bg-[rgba(32,32,34,0.82)] backdrop-blur-[24px] backdrop-saturate-[1.6]",
          "text-[13px] font-medium tracking-[0.01em] text-white/95",
          "shadow-[0_10px_36px_rgba(0,0,0,0.38),inset_0_0_0_0.5px_rgba(255,255,255,0.12)]",
          "transition-[opacity,transform] ease-out",
          phase === "hide" ? "duration-[280ms]" : "duration-[180ms]",
          shown
            ? "opacity-100 translate-y-0 scale-100"
            : phase === "hide"
              ? "opacity-0 translate-y-[4px] scale-[0.985]"
              : "opacity-0 translate-y-[6px] scale-[0.97]",
        ].join(" ")}
      >
        {text}
      </div>
    </div>
  );
}
