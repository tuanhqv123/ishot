import { useLayoutEffect, useRef, useState } from "react";
import type { LucideIcon } from "./icons";

// Shared icon wrapper: Phosphor glyphs have uneven optical footprints, so a
// raw `size={N}` makes some icons look bigger/smaller than others. We measure
// the rendered glyph's bounding box (getBBox, in viewBox units) and scale it so
// every icon fills the SAME optical box — the app-wide standard size.
export function ToolIcon({
	icon: Icon,
	box = 18,
}: {
	icon: LucideIcon;
	box?: number;
}) {
	const ref = useRef<HTMLSpanElement>(null);
	const [size, setSize] = useState(box);
	useLayoutEffect(() => {
		const svg = ref.current?.querySelector("svg") as SVGSVGElement | null;
		if (!svg) return;
		try {
			const bb = svg.getBBox(); // in the icon's own viewBox units
			const m = Math.max(bb.width, bb.height);
			// Use the icon's real viewBox (Phosphor = 256, lucide = 24) so glyphs
			// from either set normalize to the same on-screen optical box.
			const unit = svg.viewBox?.baseVal?.width || 256;
			if (m > 0) setSize((box * unit) / m);
		} catch {
			/* getBBox throws if not laid out yet — keep default size */
		}
	}, [box]);
	return (
		<span
			ref={ref}
			style={{
				width: box,
				height: box,
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			<Icon size={size} />
		</span>
	);
}
