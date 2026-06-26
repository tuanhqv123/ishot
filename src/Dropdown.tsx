import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "./icons";

export interface DropdownOption {
	value: string;
	label: string;
	/** Optional CSS background (color or gradient) shown as a swatch chip. */
	swatch?: string;
	/** Non-selectable group label (e.g. "Dark", "Light"). */
	header?: boolean;
}

function Swatch({ bg }: { bg: string }) {
	return (
		<span
			style={{
				flexShrink: 0,
				width: 18,
				height: 18,
				borderRadius: 5,
				background: bg,
				boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18)",
			}}
		/>
	);
}

/**
 * Reusable custom dropdown matching the app's dark-frosted aesthetic (HUD /
 * Settings panel) — replaces the out-of-place native <select>. Self-contained
 * inline styles so it looks identical in any window (Settings, record bar).
 */
export default function Dropdown({
	value,
	options,
	onChange,
	minWidth,
	openUp,
	onOpenChange,
	light,
	maxHeight = 260,
}: {
	value: string;
	options: DropdownOption[];
	onChange: (v: string) => void;
	minWidth?: number;
	/** Open the menu above the trigger (for bars pinned to the screen bottom). */
	openUp?: boolean;
	/** Notified when the menu opens/closes (e.g. to resize a tiny host window). */
	onOpenChange?: (open: boolean) => void;
	/** Light theme — matches the app's capture toolbar (uses styles.css tokens). */
	light?: boolean;
	/** Cap the menu height so a long list scrolls instead of overflowing its
	 *  host window (e.g. the fixed-height Settings panel). */
	maxHeight?: number;
}) {
	// Theme: light reuses the app toolbar tokens (styles.css); dark matches HUD.
	const t = light
		? {
				trigBg: "rgba(0,0,0,0.05)",
				trigBgOpen: "var(--hover)",
				text: "var(--label)",
				menuBg: "var(--surface)",
				menuShadow: "var(--shadow-pop)",
				itemText: "var(--label)",
				itemHover: "var(--hover)",
				selBg: "var(--accent)",
			}
		: {
				trigBg: "rgba(255,255,255,0.1)",
				trigBgOpen: "rgba(255,255,255,0.16)",
				text: "rgba(255,255,255,0.98)",
				menuBg: "rgba(44,44,46,0.98)",
				menuShadow: "0 10px 30px rgba(0,0,0,0.5)",
				itemText: "rgba(255,255,255,0.9)",
				itemHover: "rgba(255,255,255,0.1)",
				selBg: "rgba(10,132,255,0.9)",
			};
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{
		left: number;
		width: number;
		maxH: number;
		top?: number;
		bottom?: number;
	} | null>(null);
	const ref = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);

	const setOpenNotify = (v: boolean) => {
		// Position the menu with FIXED coords from the trigger so it isn't clipped
		// by the Settings panel's scroll/overflow (which hid the lower options).
		if (v && triggerRef.current) {
			const r = triggerRef.current.getBoundingClientRect();
			const margin = 8;
			const desiredH = Math.min(maxHeight, options.length * 34 + 8);
			const spaceBelow = window.innerHeight - r.bottom - margin;
			const spaceAbove = r.top - margin;
			// Open downward by default; flip up only when there isn't room below
			// AND there's more room above. `openUp` forces a direction when set.
			const up = openUp ?? (spaceBelow < desiredH && spaceAbove > spaceBelow);
			const maxH = Math.max(96, Math.min(desiredH, up ? spaceAbove : spaceBelow));
			// Anchor the EDGE adjacent to the trigger (top when down, bottom when
			// up) so the menu always sits flush against it — no floating gap,
			// regardless of how tall the rendered list ends up being.
			setPos(
				up
					? { left: r.left, width: r.width, maxH, bottom: window.innerHeight - r.top + 4 }
					: { left: r.left, width: r.width, maxH, top: r.bottom + 4 },
			);
		}
		setOpen(v);
		onOpenChange?.(v);
	};

	useEffect(() => {
		if (!open) return;
		const close = (e: Event) => {
			if (ref.current && !ref.current.contains(e.target as Node))
				setOpenNotify(false);
		};
		document.addEventListener("mousedown", close);
		// The menu is position:fixed, so it doesn't follow when the host (e.g.
		// the Settings body) scrolls — it'd float detached. Close on any scroll
		// outside the menu itself (internal menu scrolling is ignored).
		window.addEventListener("scroll", close, true);
		return () => {
			document.removeEventListener("mousedown", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [open]);

	const current = options.find((o) => o.value === value);

	return (
		<div
			ref={ref}
			style={{ position: "relative", flex: 1, minWidth: minWidth ?? 0 }}
		>
			<button
				ref={triggerRef}
				type="button"
				onClick={() => setOpenNotify(!open)}
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 8,
					width: "100%",
					height: 30,
					padding: "0 10px",
					borderRadius: 7,
					border: "none",
					background: open ? t.trigBgOpen : t.trigBg,
					color: t.text,
					fontSize: 13,
					fontFamily: "inherit",
					cursor: "pointer",
					outline: "none",
				}}
			>
				<span
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
						overflow: "hidden",
					}}
				>
					{current?.swatch && <Swatch bg={current.swatch} />}
					<span
						style={{
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						}}
					>
						{current?.label ?? value}
					</span>
				</span>
				<ChevronDown size={15} style={{ opacity: 0.55, flexShrink: 0 }} />
			</button>
			{open && pos && (
				<ul
					role="listbox"
					style={{
						position: "fixed",
						top: pos.top,
						bottom: pos.bottom,
						left: pos.left,
						width: pos.width,
						maxHeight: pos.maxH,
						overflowY: "auto",
						margin: 0,
						padding: 4,
						listStyle: "none",
						background: t.menuBg,
						borderRadius: 8,
						boxShadow: t.menuShadow,
						zIndex: 1000,
					}}
				>
					{options.map((o, i) => {
						// Non-selectable group label.
						if (o.header) {
							return (
								<li
									key={`h:${o.label}:${i}`}
									role="presentation"
									style={{
										padding: "8px 10px 4px",
										fontSize: 10.5,
										fontWeight: 700,
										letterSpacing: "0.06em",
										textTransform: "uppercase",
										color: t.itemText,
										opacity: 0.5,
										cursor: "default",
									}}
								>
									{o.label}
								</li>
							);
						}
						const sel = o.value === value;
						return (
							<li
								key={o.value}
								role="option"
								aria-selected={sel}
								onClick={() => {
									onChange(o.value);
									setOpen(false);
								}}
								onMouseEnter={(e) => {
									if (!sel)
										(e.currentTarget as HTMLElement).style.background =
											t.itemHover;
								}}
								onMouseLeave={(e) => {
									if (!sel)
										(e.currentTarget as HTMLElement).style.background =
											"transparent";
								}}
								style={{
									display: "flex",
									alignItems: "center",
									gap: 8,
									padding: "6px 10px",
									borderRadius: 5,
									fontSize: 13,
									cursor: "pointer",
									whiteSpace: "nowrap",
									overflow: "hidden",
									color: sel ? "#fff" : t.itemText,
									background: sel ? t.selBg : "transparent",
								}}
							>
								{o.swatch && <Swatch bg={o.swatch} />}
								<span
									style={{
										overflow: "hidden",
										textOverflow: "ellipsis",
									}}
								>
									{o.label}
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
