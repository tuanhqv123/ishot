import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { GRADIENT_PRESETS, gradientCss } from "./gradients";
import Dropdown from "./Dropdown";

// Modifier bitmask mirrors the Rust side: 1=Cmd, 2=Shift, 4=Alt, 8=Ctrl.
const MOD_META = 1;
const MOD_SHIFT = 2;
const MOD_ALT = 4;
const MOD_CTRL = 8;

type ShortcutSpec = { modifiers: number; key: string };
type Shortcuts = { capture: ShortcutSpec; clipboard: ShortcutSpec };
type AiConfig = { base_url: string; model: string };
// Screenshot-background appearance. Fixed contract — must match the Rust
// AppearanceConfig exactly so the get_settings/save_settings round-trip works.
//   kind  : "gradient" | "color" | "wallpaper" | "image"
//   value : gradient preset id | hex color | custom image path ("" for wallpaper)
type AppearanceKind = "gradient" | "color" | "wallpaper" | "image";
type AppearanceConfig = {
  enabled: boolean;
  kind: AppearanceKind;
  value: string;
  padding: number;
  radius: number;
  shadow: boolean;
};
type SettingsT = {
  shortcuts: Shortcuts;
  retention: number;
  ai: AiConfig;
  appearance: AppearanceConfig;
};

// Defaults applied in code when an older settings.json lacks `appearance`, so the
// controls render and the next save persists it.
const DEFAULT_APPEARANCE: AppearanceConfig = {
  // Off by default ("None") — keeps plain captures fast. Compositing onto a
  // wallpaper/gradient (bigger canvas + image decode) is opt-in.
  enabled: false,
  kind: "gradient",
  value: "peach",
  padding: 64,
  radius: 16,
  shadow: true,
};

// Nearest preset value, so the radius/padding dropdown always shows a word label
// (Small/Medium/…) instead of a bare number, even for legacy saved values.
function nearest(v: number, opts: { value: string }[]): string {
  return opts.reduce((best, o) =>
    Math.abs(+o.value - v) < Math.abs(+best.value - v) ? o : best,
  ).value;
}

// Gradient presets come from the SHARED module (src/gradients.ts) so the picker,
// the live preview here, and the overlay's renderFinalImage all use identical
// ids + color stops (preview == exported image).

// Solid-color swatches. Persisted as appearance.value = the hex string.
// 7 basic solid colours.
const COLOR_PRESETS: string[] = [
  "#ffffff",
  "#f2f2f7",
  "#1c1c1e",
  "#0a84ff",
  "#ff375f",
  "#30d158",
  "#ff9f0a",
];
const COLOR_LABELS: Record<string, string> = {
  "#ffffff": "White",
  "#f2f2f7": "Off-white",
  "#1c1c1e": "Charcoal",
  "#0a84ff": "Blue",
  "#ff375f": "Pink",
  "#30d158": "Green",
  "#ff9f0a": "Orange",
};
// Radius/padding as easy preset options (instead of fiddly sliders).
const RADIUS_OPTIONS = [
  { value: "0", label: "None" },
  { value: "8", label: "Small" },
  { value: "16", label: "Medium" },
  { value: "24", label: "Large" },
  { value: "40", label: "Extra large" },
];
const PADDING_OPTIONS = [
  { value: "0", label: "None" },
  { value: "32", label: "Small" },
  { value: "64", label: "Medium" },
  { value: "96", label: "Large" },
  { value: "128", label: "Extra large" },
];

// Resolves the CSS `background` for a given appearance, using a cached
// convertFileSrc URL for wallpaper/custom-image so the live preview shows the
// real backdrop. Returns undefined for kinds with no resolvable image yet.
function backgroundCss(
  appearance: AppearanceConfig,
  wallpaperSrc: string | null,
): string | undefined {
  switch (appearance.kind) {
    case "gradient":
      return gradientCss(appearance.value);
    case "color":
      return appearance.value || "#1c1c1e";
    case "wallpaper":
      return wallpaperSrc
        ? `center / cover no-repeat url("${wallpaperSrc}")`
        : "#1c1c1e";
    case "image":
      return appearance.value
        ? `center / cover no-repeat url("${convertFileSrc(appearance.value)}")`
        : "#1c1c1e";
  }
}

function modsToString(mods: number): string[] {
  const out: string[] = [];
  if (mods & MOD_CTRL) out.push("⌃");
  if (mods & MOD_ALT) out.push("⌥");
  if (mods & MOD_SHIFT) out.push("⇧");
  if (mods & MOD_META) out.push("⌘");
  return out;
}

// Maps a browser KeyboardEvent.code to the Rust-side string identifier
// expected by str_to_code. Only letters, digits, F1-F12 and Space are
// allowed — everything else is rejected so the user can't bind something
// that won't round-trip through tauri's global shortcut codes.
function eventToKey(e: KeyboardEvent): string | null {
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  if (code === "Space") return "Space";
  return null;
}

function ShortcutInput({
  spec,
  onChange,
}: {
  spec: ShortcutSpec;
  onChange: (s: ShortcutSpec) => void;
}) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      // Ignore lone modifier presses — wait for a real key.
      if (["Meta", "Shift", "Alt", "Control"].includes(e.key)) return;
      const key = eventToKey(e);
      if (!key) return;
      let mods = 0;
      if (e.metaKey) mods |= MOD_META;
      if (e.shiftKey) mods |= MOD_SHIFT;
      if (e.altKey) mods |= MOD_ALT;
      if (e.ctrlKey) mods |= MOD_CTRL;
      if (mods === 0) return; // require at least one modifier
      onChange({ modifiers: mods, key });
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);

  const pills = modsToString(spec.modifiers);
  return (
    <button
      className={recording ? "st-shortcut recording" : "st-shortcut"}
      onClick={() => setRecording((r) => !r)}
      type="button"
    >
      {recording ? (
        <span className="st-shortcut-hint">Press keys… (Esc to cancel)</span>
      ) : (
        <>
          {pills.map((p) => (
            <span key={p} className="st-key">{p}</span>
          ))}
          <span className="st-key">{spec.key}</span>
        </>
      )}
    </button>
  );
}

export default function Settings() {
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<SettingsT | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  // Model ids fetched from {base_url}/models — populated automatically whenever
  // the base URL / API key changes (no manual "Fetch" button). Shown in a
  // standard Dropdown like the other settings.
  const [availableModels, setAvailableModels] = useState<string[]>([]);

  // Resolved file:// src for the current desktop wallpaper, cached so the live
  // preview can render it. Fetched lazily when the "Current wallpaper" kind is
  // chosen (or already active on load).
  const [wallpaperSrc, setWallpaperSrc] = useState<string | null>(null);

  // "Launch at login" (moved here from the tray menu) + the running version,
  // shown in the footer.
  const [autostart, setAutostart] = useState(false);
  const [version, setVersion] = useState("");
  // "Support" toggles into two region options (both open a web link).
  const [donateOpen, setDonateOpen] = useState(false);

  const openUrl = (url: string) => {
    invoke("plugin:shell|open", { path: url }).catch((e) =>
      console.error("open url failed", e),
    );
  };

  useEffect(() => {
    (async () => {
      try {
        setAutostart(await invoke<boolean>("get_autostart"));
        setVersion(await invoke<string>("get_app_version"));
      } catch (e) {
        console.error("load autostart/version failed", e);
      }
    })();
  }, []);

  const toggleAutostart = async () => {
    const next = !autostart;
    setAutostart(next);
    try {
      await invoke("set_autostart", { enabled: next });
    } catch (e) {
      console.error("set_autostart failed", e);
      setAutostart(!next); // revert on failure
    }
  };

  const loadWallpaper = useCallback(async () => {
    try {
      const path = await invoke<string>("get_desktop_wallpaper_path");
      setWallpaperSrc(path ? convertFileSrc(path) : null);
    } catch (e) {
      console.error("get_desktop_wallpaper_path failed", e);
      setWallpaperSrc(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<SettingsT>("get_settings");
      // Older configs predate `appearance` — default it in so the controls
      // render and the next save persists the field.
      const appearance: AppearanceConfig = {
        ...DEFAULT_APPEARANCE,
        ...(s.appearance ?? {}),
      };
      setSettings({ ...s, appearance });
      if (appearance.kind === "wallpaper") loadWallpaper();
      const present = await invoke<boolean>("has_api_key");
      setHasKey(present);
      setLoaded(true);
    } catch (e) {
      console.error("load settings failed", e);
    }
  }, [loadWallpaper]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const hide = useCallback(() => {
    getCurrentWindow().hide().catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === "Escape" && tag !== "INPUT") {
        e.preventDefault();
        hide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hide]);

  // Auto-save: persist on any change (debounced) so the user never has to
  // remember to hit Save. Skips the first run after load so opening Settings
  // doesn't trigger a redundant write.
  const savedOnce = useRef(false);
  useEffect(() => {
    if (!loaded || !settings) return;
    if (!savedOnce.current) {
      savedOnce.current = true;
      return;
    }
    const t = setTimeout(() => {
      invoke("save_settings", { settings }).catch((e) =>
        console.error("auto-save failed", e),
      );
    }, 400);
    return () => clearTimeout(t);
  }, [settings, loaded]);

  // Auto-save the API key as the user types (debounced) — no Save button.
  // Empty input is left alone (it just means "unchanged"), so the stored key
  // isn't wiped by an empty field.
  useEffect(() => {
    if (!loaded) return;
    const key = apiKeyInput.trim();
    if (!key) return;
    const t = setTimeout(() => {
      invoke("set_api_key", { key })
        .then(() => setHasKey(true))
        .catch((e) => {
          console.error("set_api_key failed", e);
          setStatus(`API key save failed: ${e}`);
        });
    }, 600);
    return () => clearTimeout(t);
  }, [apiKeyInput, loaded]);

  // Auto-fetch the model list whenever the base URL / API key changes
  // (debounced) — no manual "Fetch" button.
  const baseUrl = settings?.ai.base_url ?? "";
  useEffect(() => {
    if (!loaded || !baseUrl.trim()) return;
    const t = setTimeout(() => {
      invoke<string[]>("list_ai_models", { baseUrl, apiKey: apiKeyInput })
        .then((ids) => setAvailableModels(ids))
        .catch((e) => console.error("list_ai_models failed", e));
    }, 700);
    return () => clearTimeout(t);
  }, [baseUrl, apiKeyInput, hasKey, loaded]);

  if (!loaded || !settings) {
    return <div className="st-root"><div className="st-loading">Loading…</div></div>;
  }

  const update = (patch: Partial<SettingsT>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s));
  };
  const updateShortcuts = (patch: Partial<Shortcuts>) => {
    setSettings((s) => (s ? { ...s, shortcuts: { ...s.shortcuts, ...patch } } : s));
  };
  const updateAi = (patch: Partial<AiConfig>) => {
    setSettings((s) => (s ? { ...s, ai: { ...s.ai, ...patch } } : s));
  };
  const updateAppearance = (patch: Partial<AppearanceConfig>) => {
    setSettings((s) =>
      s ? { ...s, appearance: { ...s.appearance, ...patch } } : s,
    );
  };

  // Opens a native image file picker via the dialog plugin's IPC bridge (the
  // @tauri-apps/plugin-dialog JS package isn't a dependency, so we call the
  // underlying command directly). Returns a single absolute path or null.
  const pickCustomImage = async () => {
    try {
      // Native picker (Rust): suppresses the Settings panel's resign-key
      // auto-hide while the NSOpenPanel is up, so Finder actually appears.
      const path = await invoke<string | null>("pick_background_image");
      if (path) updateAppearance({ enabled: true, kind: "image", value: path });
    } catch (e) {
      console.error("image picker failed", e);
      setStatus(`Could not open file picker: ${e}`);
    }
  };

  const selectWallpaper = () => {
    updateAppearance({ enabled: true, kind: "wallpaper", value: "" });
    loadWallpaper(); // always re-read so it reflects the CURRENT wallpaper
  };

  // ONE unified background picker. "none" turns the backdrop off; everything
  // else turns it on. Value is prefixed: g:<id> / c:<hex> / wallpaper / image /
  // none. Decodes the selection into enabled + kind + value.
  const onBgChange = (v: string) => {
    if (v === "none") updateAppearance({ enabled: false });
    else if (v.startsWith("g:"))
      updateAppearance({ enabled: true, kind: "gradient", value: v.slice(2) });
    else if (v.startsWith("c:"))
      updateAppearance({ enabled: true, kind: "color", value: v.slice(2) });
    else if (v === "wallpaper") selectWallpaper();
    // Open the picker right away; pickCustomImage commits kind+value only once
    // a file is actually chosen (cancel = no change, no blank image background).
    else if (v === "image") pickCustomImage();
  };

  const app = settings.appearance;
  // When "None" (disabled), the preview shows a neutral tile with the bare shot.
  const previewBg = app.enabled ? backgroundCss(app, wallpaperSrc) : "#2c2c2e";

  // Model dropdown options = fetched models, with the current value always
  // present (so a manually-configured / unlisted model still shows).
  const modelOptions = (() => {
    const ids = [...availableModels];
    const cur = settings.ai.model;
    if (cur && !ids.includes(cur)) ids.unshift(cur);
    return ids.map((m) => ({ value: m, label: m }));
  })();

  return (
    <div className="st-root">
      <div className="st-header">
        <div className="st-title">Settings</div>
      </div>

      <div className="st-body">
        <section className="st-section">
          <div className="st-section-title">Shortcuts</div>
          <div className="st-row">
            <div className="st-label">Capture</div>
            <ShortcutInput
              spec={settings.shortcuts.capture}
              onChange={(capture) => updateShortcuts({ capture })}
            />
          </div>
          <div className="st-row">
            <div className="st-label">Clipboard history</div>
            <ShortcutInput
              spec={settings.shortcuts.clipboard}
              onChange={(clipboard) => updateShortcuts({ clipboard })}
            />
          </div>
        </section>

        <section className="st-section">
          <div className="st-section-title">General</div>
          <div className="st-row">
            <div className="st-label">
              Launch at login
              <div className="st-hint">Open iShot automatically on startup</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autostart}
              className={autostart ? "st-switch on" : "st-switch"}
              onClick={toggleAutostart}
            >
              <span className="st-switch-knob" />
            </button>
          </div>
        </section>

        <section className="st-section">
          <div className="st-section-title">History</div>
          <div className="st-row">
            <div className="st-label">
              Retention
              <div className="st-hint">Max items kept in clipboard history</div>
            </div>
            <input
              className="st-input st-input-num"
              type="number"
              min={1}
              max={1000}
              value={settings.retention}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!Number.isFinite(n)) return;
                update({ retention: Math.min(1000, Math.max(1, n)) });
              }}
            />
          </div>
        </section>

        <section className="st-section">
          <div className="st-section-title">AI</div>
          <div className="st-row">
            <div className="st-label">Base URL</div>
            <input
              className="st-input"
              type="text"
              value={settings.ai.base_url}
              onChange={(e) => updateAi({ base_url: e.target.value })}
            />
          </div>
          <div className="st-row">
            <div className="st-label">Model</div>
            <Dropdown
              value={settings.ai.model}
              onChange={(v) => updateAi({ model: v })}
              maxHeight={200}
              options={modelOptions}
            />
          </div>
          <div className="st-row">
            <div className="st-label">API key</div>
            <input
              className="st-input"
              type="password"
              placeholder={hasKey ? "•••••••• (saved)" : "sk-…"}
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
          </div>
        </section>

        <section className="st-section">
          <div className="st-section-title">Screenshot Background</div>

          {/* No Enable/Shadow toggles — "None" in the Background dropdown turns
              the backdrop off. The preview is a small SQUARE on the right (a
              top-left CORNER crop) spanning the 3 rows' height, so a change
              shows right beside the control that made it. */}
          <div className="st-bg-grid">
            <div className="st-bg-controls">
              {/* ONE picker with everything: current wallpaper (default),
                  custom image, none, then gradients + solid colours. */}
              <div className="st-row">
                <div className="st-label">Background</div>
                <Dropdown
                  value={
                    !app.enabled
                      ? "none"
                      : app.kind === "gradient"
                        ? `g:${app.value}`
                        : app.kind === "color"
                          ? `c:${app.value}`
                          : app.kind
                  }
                  onChange={onBgChange}
                  maxHeight={200}
                  options={[
                    { value: "wallpaper", label: "Current wallpaper" },
                    { value: "image", label: "Custom image…" },
                    { value: "none", label: "None" },
                    ...GRADIENT_PRESETS.map((g) => ({
                      value: `g:${g.id}`,
                      label: g.label,
                      swatch: gradientCss(g.id),
                    })),
                    ...COLOR_PRESETS.map((c) => ({
                      value: `c:${c}`,
                      label: COLOR_LABELS[c] ?? c,
                      swatch: c,
                    })),
                  ]}
                />
              </div>

              <div className="st-row">
                <div className="st-label">Corner radius</div>
                <Dropdown
                  value={nearest(app.radius, RADIUS_OPTIONS)}
                  onChange={(v) => updateAppearance({ radius: parseInt(v, 10) })}
                  options={RADIUS_OPTIONS}
                />
              </div>

              <div className="st-row">
                <div className="st-label">Padding</div>
                <Dropdown
                  value={nearest(app.padding, PADDING_OPTIONS)}
                  onChange={(v) => updateAppearance({ padding: parseInt(v, 10) })}
                  options={PADDING_OPTIONS}
                />
              </div>
            </div>

            <div
              className={
                "st-bg-preview-square" +
                (app.enabled && (app.kind === "gradient" || app.kind === "color")
                  ? " grain"
                  : "")
              }
              style={{ background: previewBg }}
            >
              <div
                className="st-bg-preview-corner"
                style={{
                  top: app.enabled ? Math.round(app.padding * 0.32) : 0,
                  left: app.enabled ? Math.round(app.padding * 0.32) : 0,
                  borderRadius: app.enabled ? app.radius : 0,
                  boxShadow:
                    app.enabled && app.shadow ? "0 6px 18px rgba(0,0,0,0.45)" : "none",
                }}
              />
            </div>
          </div>
        </section>

        <section className="st-section">
          <div className="st-about">
            {/* App name = hyperlink to the repo so people can star it. */}
            <button
              type="button"
              className="st-about-name"
              title="Star on GitHub ★"
              onClick={() => openUrl("https://github.com/tuanhqv123/ishot")}
            >
              iShot {version}
            </button>
            <div className="st-about-tagline">
              If iShot saves you a few clicks every day, that already means a
              lot.
            </div>

            {/* "Support" → REPLACED by the two region options when clicked. */}
            {!donateOpen && (
              <button
                type="button"
                className="st-support-btn"
                onClick={() => setDonateOpen(true)}
              >
                Support
              </button>
            )}

            {donateOpen && (
              <div className="st-donate-panel">
                <div className="st-donate-choose">
                  <button
                    type="button"
                    className="st-donate-opt"
                    onClick={() => {
                      openUrl("https://ko-fi.com/tuantran1849");
                      setDonateOpen(false);
                    }}
                  >
                    International
                  </button>
                  <button
                    type="button"
                    className="st-donate-opt"
                    onClick={() => {
                      openUrl(
                        "https://vietqr.app/img?acc=1409200477&bank=Techcombank&template=qronly&showinfo=true",
                      );
                      setDonateOpen(false);
                    }}
                  >
                    Vietnam
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="st-footer">
        {status && <div className="st-status">{status}</div>}
        <div className="st-footer-buttons">
          <button className="st-btn st-btn-primary" onClick={hide} type="button">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
