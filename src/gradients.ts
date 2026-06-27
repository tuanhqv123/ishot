// Shared gradient presets so the Settings picker/preview and the
// renderFinalImage compositor stay in sync — same ids AND same color stops.
// (They drifted once when defined separately; keep this the single source.)
// A spread of moods: dark, light, pastel — all simple two-stop gradients.
export interface GradientPreset {
	id: string;
	label: string;
	from: string;
	to: string;
	angle?: number;
}

export const GRADIENT_PRESETS: GradientPreset[] = [
	// Curated — each distinct and clean, none muddy. Dark → cool → warm → fresh.
	{ id: "midnight", label: "Midnight", from: "#232526", to: "#414345" }, // graphite
	{ id: "ocean", label: "Ocean", from: "#2193b0", to: "#6dd5ed" }, // cyan blue
	{ id: "lush", label: "Lush", from: "#654ea3", to: "#eaafc8" }, // purple → pink
	{ id: "sunset", label: "Sunset", from: "#ff7e5f", to: "#feb47b" }, // warm orange
	{ id: "peach", label: "Peach", from: "#ffecd2", to: "#fcb69f" },
	{ id: "sky", label: "Sky", from: "#a1c4fd", to: "#c2e9fb" },
	{ id: "blush", label: "Blush", from: "#ee9ca7", to: "#ffdde1" },
	{ id: "aqua", label: "Aqua", from: "#43e97b", to: "#38f9d7" }, // fresh mint-teal
];

export function gradientById(id: string): GradientPreset {
	return GRADIENT_PRESETS.find((g) => g.id === id) ?? GRADIENT_PRESETS[0];
}

/** CSS `background` for the Settings swatches + live preview. */
export function gradientCss(id: string): string {
	const p = gradientById(id);
	return `linear-gradient(${p.angle ?? 135}deg, ${p.from} 0%, ${p.to} 100%)`;
}
