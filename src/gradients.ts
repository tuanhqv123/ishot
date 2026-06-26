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
	// Dark — kept visually distinct from each other.
	{ id: "midnight", label: "Midnight", from: "#232526", to: "#414345" }, // graphite
	{ id: "royal", label: "Royal", from: "#0f2027", to: "#2c5364" }, // deep teal-navy
	{ id: "plum", label: "Plum", from: "#41295a", to: "#2f0743" }, // dark purple
	// Light
	{ id: "peach", label: "Peach", from: "#ffecd2", to: "#fcb69f" },
	{ id: "sky", label: "Sky", from: "#a1c4fd", to: "#c2e9fb" },
	{ id: "daylight", label: "Daylight", from: "#e0eafc", to: "#cfdef3" },
	// Pastel
	{ id: "lavender", label: "Lavender", from: "#a18cd1", to: "#fbc2eb" },
	{ id: "blush", label: "Blush", from: "#ee9ca7", to: "#ffdde1" },
	{ id: "mint", label: "Mint", from: "#d4fc79", to: "#96e6a1" },
];

export function gradientById(id: string): GradientPreset {
	return GRADIENT_PRESETS.find((g) => g.id === id) ?? GRADIENT_PRESETS[0];
}

/** CSS `background` for the Settings swatches + live preview. */
export function gradientCss(id: string): string {
	const p = gradientById(id);
	return `linear-gradient(${p.angle ?? 135}deg, ${p.from} 0%, ${p.to} 100%)`;
}
