// Shared gradient presets so the Settings picker/preview and the
// renderFinalImage compositor stay in sync — same ids AND same color stops.
// (They drifted once when defined separately; keep this the single source.)
export interface GradientPreset {
	id: string;
	from: string;
	to: string;
}

export const GRADIENT_PRESETS: GradientPreset[] = [
	{ id: "indigo", from: "#667eea", to: "#764ba2" },
	{ id: "ocean", from: "#2193b0", to: "#6dd5ed" },
	{ id: "lavender", from: "#a18cd1", to: "#fbc2eb" },
	{ id: "peach", from: "#ffecd2", to: "#fcb69f" },
	{ id: "mint", from: "#43e97b", to: "#38f9d7" },
	{ id: "slate", from: "#3a4452", to: "#1c2230" },
];

export function gradientById(id: string): GradientPreset {
	return GRADIENT_PRESETS.find((g) => g.id === id) ?? GRADIENT_PRESETS[0];
}

/** CSS string for the Settings swatches + live preview. */
export function gradientCss(id: string): string {
	const p = gradientById(id);
	return `linear-gradient(135deg, ${p.from} 0%, ${p.to} 100%)`;
}
