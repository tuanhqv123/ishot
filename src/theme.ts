// Shared theme resolver. Every themed window imports theme.css and calls
// initTheme() once on startup. The single source of truth is the `theme` field
// in settings ("system" | "light" | "dark"), broadcast to all windows via the
// existing `settings-changed` event — so flipping it in Settings updates every
// open window live. "system" follows the macOS appearance in real time.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ThemePref = "system" | "light" | "dark";

const darkMq = () => window.matchMedia("(prefers-color-scheme: dark)");

function resolved(pref: ThemePref): "light" | "dark" {
	if (pref === "system") return darkMq().matches ? "dark" : "light";
	return pref;
}

function apply(pref: ThemePref) {
	document.documentElement.dataset.theme = resolved(pref);
}

// Apply a best-guess immediately at import time (system) so there's no flash of
// the wrong theme before settings load.
apply("system");

export async function initTheme(): Promise<void> {
	let pref: ThemePref = "system";
	try {
		const s = await invoke<{ theme?: ThemePref }>("get_settings");
		pref = s?.theme ?? "system";
	} catch {
		// keep the system guess
	}
	apply(pref);

	// Follow macOS light/dark changes while on "system".
	darkMq().addEventListener("change", () => {
		if (pref === "system") apply(pref);
	});

	// React to in-app theme changes broadcast from Settings.
	await listen<{ theme?: ThemePref }>("settings-changed", (e) => {
		pref = e.payload?.theme ?? "system";
		apply(pref);
	});
}
