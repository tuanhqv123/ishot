import { useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { X } from "./icons";

// Borderless always-on-top window that just shows the pinned capture. The whole
// surface is a drag region (move it anywhere); a hover close button + Esc
// dismiss it. The window's initial size already matches the image aspect, so the
// image fills it edge-to-edge.
export default function Pin() {
	const params = new URLSearchParams(location.search);
	const path = params.get("path") || "";
	const src = path ? convertFileSrc(path) : "";

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") getCurrentWindow().close();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return (
		<div
			data-tauri-drag-region
			className="group relative h-screen w-screen cursor-default select-none overflow-hidden rounded-[10px] bg-transparent"
		>
			<img
				src={src}
				alt=""
				draggable={false}
				className="pointer-events-none block h-full w-full rounded-[10px] object-fill"
			/>
			<button
				onClick={() => getCurrentWindow().close()}
				title="Close (Esc)"
				className="absolute left-2 top-2 flex h-[22px] w-[22px] items-center justify-center rounded-full border-none bg-black/55 text-white opacity-0 backdrop-blur-[6px] transition-opacity group-hover:opacity-100"
			>
				<X size={13} />
			</button>
		</div>
	);
}
