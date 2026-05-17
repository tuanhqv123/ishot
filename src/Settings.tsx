import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Modifier bitmask mirrors the Rust side: 1=Cmd, 2=Shift, 4=Alt, 8=Ctrl.
const MOD_META = 1;
const MOD_SHIFT = 2;
const MOD_ALT = 4;
const MOD_CTRL = 8;

type ShortcutSpec = { modifiers: number; key: string };
type Shortcuts = { capture: ShortcutSpec; clipboard: ShortcutSpec };
type AiConfig = { base_url: string; model: string };
type SettingsT = {
  shortcuts: Shortcuts;
  retention: number;
  ai: AiConfig;
};

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

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<SettingsT>("get_settings");
      setSettings(s);
      const present = await invoke<boolean>("has_api_key");
      setHasKey(present);
      setLoaded(true);
    } catch (e) {
      console.error("load settings failed", e);
    }
  }, []);

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

  const onSave = async () => {
    try {
      await invoke("save_settings", { settings });
      setStatus("Saved.");
      setTimeout(() => setStatus(null), 1500);
    } catch (e) {
      console.error("save_settings failed", e);
      setStatus(`Save failed: ${e}`);
    }
  };

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
            <input
              className="st-input"
              type="text"
              value={settings.ai.model}
              onChange={(e) => updateAi({ model: e.target.value })}
            />
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
      </div>

      <div className="st-footer">
        {status && <div className="st-status">{status}</div>}
        <div className="st-footer-buttons">
          <button className="st-btn st-btn-ghost" onClick={hide} type="button">
            Cancel
          </button>
          <button className="st-btn st-btn-primary" onClick={onSave} type="button">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
