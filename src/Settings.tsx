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
  enabled: false,
  kind: "gradient",
  value: "",
  padding: 48,
  radius: 12,
  shadow: true,
};

// Gradient presets come from the SHARED module (src/gradients.ts) so the picker,
// the live preview here, and the overlay's renderFinalImage all use identical
// ids + color stops (preview == exported image).

// Solid-color swatches. Persisted as appearance.value = the hex string.
const COLOR_PRESETS: string[] = [
  "#ffffff",
  "#f2f2f7",
  "#1c1c1e",
  "#0a84ff",
  "#ff375f",
  "#30d158",
];
const COLOR_LABELS: Record<string, string> = {
  "#ffffff": "White",
  "#f2f2f7": "Off-white",
  "#1c1c1e": "Charcoal",
  "#0a84ff": "Blue",
  "#ff375f": "Pink",
  "#30d158": "Green",
};

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
  const [savingKey, setSavingKey] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Available model ids fetched from {base_url}/models. Populates the
  // datalist hint dropdown next to the model input; the input itself stays
  // free-form so users can also type a model id manually (handy for unlisted
  // proxy endpoints).
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  // Anchor for the model dropdown — used to pin the floating list directly
  // under the input with `position: fixed`, avoiding parent overflow clipping.
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const [modelDropdownPos, setModelDropdownPos] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const computeDropdownPos = useCallback(() => {
    const el = modelInputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setModelDropdownPos({ top: r.bottom + 4, left: r.left, width: r.width });
  }, []);

  // Resolved file:// src for the current desktop wallpaper, cached so the live
  // preview can render it. Fetched lazily when the "Current wallpaper" kind is
  // chosen (or already active on load).
  const [wallpaperSrc, setWallpaperSrc] = useState<string | null>(null);

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
      const selected = await invoke<string | string[] | null>(
        "plugin:dialog|open",
        {
          options: {
            multiple: false,
            directory: false,
            filters: [
              {
                name: "Images",
                extensions: ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff"],
              },
            ],
          },
        },
      );
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (path) updateAppearance({ kind: "image", value: path });
    } catch (e) {
      console.error("image picker failed", e);
      setStatus(`Could not open file picker: ${e}`);
    }
  };

  const selectWallpaper = () => {
    updateAppearance({ kind: "wallpaper", value: "" });
    if (!wallpaperSrc) loadWallpaper();
  };

  // Background-type dropdown: switch kind, keeping/seeding a sensible value.
  const onKindChange = (kind: AppearanceKind) => {
    const v = settings.appearance.value;
    if (kind === "gradient")
      updateAppearance({
        kind,
        value: GRADIENT_PRESETS.some((g) => g.id === v) ? v : GRADIENT_PRESETS[0].id,
      });
    else if (kind === "color")
      updateAppearance({ kind, value: /^#/.test(v) ? v : COLOR_PRESETS[0] });
    else if (kind === "wallpaper") selectWallpaper();
    else updateAppearance({ kind: "image" });
  };

  const app = settings.appearance;
  const previewBg = backgroundCss(app, wallpaperSrc);

  const onSaveKey = async () => {
    if (!apiKeyInput.trim()) return;
    setSavingKey(true);
    try {
      await invoke("set_api_key", { key: apiKeyInput });
      setApiKeyInput("");
      setHasKey(true);
    } catch (e) {
      console.error(e);
      setStatus(`API key save failed: ${e}`);
    } finally {
      setSavingKey(false);
    }
  };

  const onClearKey = async () => {
    try {
      await invoke("clear_api_key");
      setHasKey(false);
    } catch (e) {
      console.error(e);
    }
  };

  const onFetchModels = async () => {
    if (!settings) return;
    setFetchingModels(true);
    setStatus(null);
    try {
      // Pass the in-flight base_url + api_key (if just typed) explicitly so the
      // user can probe a provider BEFORE pressing Save. Backend falls back to
      // the keychain-stored key when apiKeyInput is empty.
      const ids = await invoke<string[]>("list_ai_models", {
        baseUrl: settings.ai.base_url,
        apiKey: apiKeyInput,
      });
      setAvailableModels(ids);
      computeDropdownPos();
      setModelDropdownOpen(ids.length > 0);
      setStatus(`Found ${ids.length} model${ids.length === 1 ? "" : "s"}.`);
      setTimeout(() => setStatus(null), 2000);
    } catch (e) {
      console.error("list_ai_models failed", e);
      setStatus(`Fetch failed: ${e}`);
    } finally {
      setFetchingModels(false);
    }
  };

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
            <div className="st-model-wrap">
              <div className="st-key-row">
                <input
                  ref={modelInputRef}
                  className="st-input"
                  type="text"
                  value={settings.ai.model}
                  onFocus={() => {
                    if (availableModels.length > 0) {
                      computeDropdownPos();
                      setModelDropdownOpen(true);
                    }
                  }}
                  onChange={(e) => updateAi({ model: e.target.value })}
                  placeholder="gpt-4o-mini"
                />
                <button
                  className="st-btn"
                  onClick={onFetchModels}
                  disabled={fetchingModels || !settings.ai.base_url.trim()}
                  title="Fetch models from {base_url}/models"
                  type="button"
                >
                  {fetchingModels ? "…" : "Fetch"}
                </button>
              </div>
              {modelDropdownOpen && availableModels.length > 0 && (
                <>
                  {/* Click-outside scrim — covers everything else in the panel
                      so any non-dropdown click closes the menu. */}
                  <div
                    className="st-dropdown-scrim"
                    onClick={() => setModelDropdownOpen(false)}
                  />
                  <ul
                    className="st-dropdown"
                    role="listbox"
                    style={
                      modelDropdownPos
                        ? {
                            top: modelDropdownPos.top,
                            left: modelDropdownPos.left,
                            width: modelDropdownPos.width,
                          }
                        : undefined
                    }
                  >
                    {availableModels.map((m) => (
                      <li
                        key={m}
                        className={
                          m === settings.ai.model
                            ? "st-dropdown-item selected"
                            : "st-dropdown-item"
                        }
                        onClick={() => {
                          updateAi({ model: m });
                          setModelDropdownOpen(false);
                        }}
                        role="option"
                        aria-selected={m === settings.ai.model}
                      >
                        {m}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
          <div className="st-row">
            <div className="st-label">API key</div>
            <div className="st-key-row">
              <input
                className="st-input"
                type="password"
                placeholder={hasKey ? "••••••••" : "sk-…"}
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
              />
              <button
                className="st-btn"
                onClick={onSaveKey}
                disabled={savingKey || !apiKeyInput.trim()}
                type="button"
              >
                Save
              </button>
              {hasKey && (
                <button className="st-btn st-btn-ghost" onClick={onClearKey} type="button">
                  Clear
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="st-section">
          <div className="st-section-title">Screenshot Background</div>

          <div className="st-row">
            <div className="st-label">
              Enable
              <div className="st-hint">Composite screenshots onto a backdrop</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={app.enabled}
              className={app.enabled ? "st-switch on" : "st-switch"}
              onClick={() => updateAppearance({ enabled: !app.enabled })}
            >
              <span className="st-switch-knob" />
            </button>
          </div>

          <div className={app.enabled ? "st-bg-controls" : "st-bg-controls disabled"}>
            {/* Type dropdown — compact, replaces the long swatch grid. */}
            <div className="st-row">
              <div className="st-label">Type</div>
              <Dropdown
                value={app.kind}
                onChange={(v) => onKindChange(v as AppearanceKind)}
                options={[
                  { value: "gradient", label: "Gradient" },
                  { value: "color", label: "Solid color" },
                  { value: "wallpaper", label: "Current wallpaper" },
                  { value: "image", label: "Custom image…" },
                ]}
              />
            </div>

            {app.kind === "gradient" && (
              <div className="st-row">
                <div className="st-label">Style</div>
                <Dropdown
                  value={app.value}
                  onChange={(v) => updateAppearance({ value: v })}
                  options={GRADIENT_PRESETS.map((g) => ({
                    value: g.id,
                    label: g.id.charAt(0).toUpperCase() + g.id.slice(1),
                  }))}
                />
              </div>
            )}

            {app.kind === "color" && (
              <div className="st-row">
                <div className="st-label">Color</div>
                <Dropdown
                  value={app.value}
                  onChange={(v) => updateAppearance({ value: v })}
                  options={COLOR_PRESETS.map((c) => ({
                    value: c,
                    label: COLOR_LABELS[c] ?? c,
                  }))}
                />
              </div>
            )}

            {app.kind === "image" && (
              <div className="st-row">
                <button type="button" className="st-btn" onClick={pickCustomImage}>
                  Choose image…
                </button>
                {app.value && (
                  <div className="st-bg-path" title={app.value}>
                    {app.value.split("/").pop()}
                  </div>
                )}
              </div>
            )}

            {/* Sliders (left) + live preview (right), side by side. The preview
                updates radius/padding/shadow live as the user drags. */}
            <div className="st-row st-bg-preview-row">
              <div className="st-bg-sliders">
                <div className="st-slider-label">
                  <span>Radius</span>
                  <span className="st-hint">{app.radius}px</span>
                </div>
                <input
                  className="st-slider"
                  type="range"
                  min={0}
                  max={48}
                  value={app.radius}
                  onChange={(e) =>
                    updateAppearance({ radius: parseInt(e.target.value, 10) })
                  }
                />
                <div className="st-slider-label">
                  <span>Padding</span>
                  <span className="st-hint">{app.padding}px</span>
                </div>
                <input
                  className="st-slider"
                  type="range"
                  min={0}
                  max={160}
                  value={app.padding}
                  onChange={(e) =>
                    updateAppearance({ padding: parseInt(e.target.value, 10) })
                  }
                />
                <div className="st-slider-label">
                  <span>Shadow</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={app.shadow}
                    className={app.shadow ? "st-switch on" : "st-switch"}
                    onClick={() => updateAppearance({ shadow: !app.shadow })}
                  >
                    <span className="st-switch-knob" />
                  </button>
                </div>
              </div>
              <div
                className={
                  "st-preview-tile" +
                  (app.kind === "gradient" || app.kind === "color"
                    ? " grain"
                    : "")
                }
                style={{ background: previewBg }}
              >
                <div
                  className="st-preview-shot"
                  style={{
                    borderRadius: app.radius,
                    inset: `${Math.round((app.padding / 160) * 26)}px`,
                    boxShadow: app.shadow ? "0 2px 7px rgba(0,0,0,0.4)" : "none",
                  }}
                />
              </div>
            </div>
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
