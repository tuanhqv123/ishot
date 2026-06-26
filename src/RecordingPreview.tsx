import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { X } from "lucide-react";

// Post-record preview with a TRIM strip: drag the two handles to set start/end;
// Save exports only that range (and closes the window).
export default function RecordingPreview() {
	const path = new URLSearchParams(location.search).get("path") || "";
	const src = path ? convertFileSrc(path) : "";
	const videoRef = useRef<HTMLVideoElement>(null);
	const trackRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<null | "start" | "end">(null);
	const [dur, setDur] = useState(0);
	const [start, setStart] = useState(0);
	const [end, setEnd] = useState(0);
	const [thumbs, setThumbs] = useState<string[]>([]);
	const [err, setErr] = useState<string | null>(null);

	const onLoaded = () => {
		const d = videoRef.current?.duration || 0;
		if (d && Number.isFinite(d)) {
			setDur(d);
			setEnd(d);
			setStart(0);
		}
	};

	// Thumbnails for the strip (best-effort; blob-loaded to avoid canvas taint).
	useEffect(() => {
		if (!src) return;
		let cancelled = false;
		let objUrl: string | null = null;
		(async () => {
			try {
				const blob = await (await fetch(src)).blob();
				objUrl = URL.createObjectURL(blob);
				const v = document.createElement("video");
				v.src = objUrl;
				v.muted = true;
				await new Promise<void>((res, rej) => {
					v.onloadedmetadata = () => res();
					v.onerror = () => rej(new Error("meta"));
				});
				const d = v.duration || 0;
				const N = 10;
				const out: string[] = [];
				const canvas = document.createElement("canvas");
				for (let i = 0; i < N && !cancelled; i++) {
					const t = (d * (i + 0.5)) / N;
					await new Promise<void>((res) => {
						v.onseeked = () => res();
						v.currentTime = Math.min(t, Math.max(0, d - 0.05));
					});
					await new Promise((r) => requestAnimationFrame(() => r(null)));
					const ar = v.videoHeight / v.videoWidth || 0.56;
					canvas.width = 120;
					canvas.height = Math.round(120 * ar);
					canvas.getContext("2d")!.drawImage(v, 0, 0, canvas.width, canvas.height);
					out.push(canvas.toDataURL("image/jpeg", 0.5));
					if (!cancelled) setThumbs([...out]);
				}
			} catch (e) {
				console.error("thumbnails failed", e);
			}
		})();
		return () => {
			cancelled = true;
			if (objUrl) URL.revokeObjectURL(objUrl);
		};
	}, [src]);

	// Drag the trim handles.
	useEffect(() => {
		const move = (e: PointerEvent) => {
			const side = dragRef.current;
			if (!side || !trackRef.current || !dur) return;
			const r = trackRef.current.getBoundingClientRect();
			let f = (e.clientX - r.left) / r.width;
			f = Math.max(0, Math.min(1, f));
			const t = f * dur;
			if (side === "start") {
				const ns = Math.min(t, end - 0.2);
				setStart(Math.max(0, ns));
				if (videoRef.current) videoRef.current.currentTime = Math.max(0, ns);
			} else {
				const ne = Math.max(t, start + 0.2);
				setEnd(Math.min(dur, ne));
				if (videoRef.current) videoRef.current.currentTime = Math.min(dur, ne);
			}
		};
		const up = () => {
			dragRef.current = null;
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		return () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
	}, [dur, start, end]);

	const fmt = (s: number) =>
		`${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
	const pct = (t: number) => (dur ? (t / dur) * 100 : 0);

	const save = async () => {
		const trimmed = start > 0.1 || end < dur - 0.1;
		try {
			await invoke("save_recording", {
				path,
				start: trimmed ? start : null,
				end: trimmed ? end : null,
			});
			getCurrentWindow().close();
		} catch (e) {
			console.error("save_recording", e);
			setErr(String(e));
		}
	};
	const discard = async () => {
		try {
			await invoke("discard_recording", { path });
		} catch (e) {
			console.error("discard_recording", e);
		}
		getCurrentWindow().close();
	};

	const handle = (left: number): React.CSSProperties => ({
		position: "absolute",
		top: -2,
		bottom: -2,
		left: `${left}%`,
		width: 12,
		marginLeft: -6,
		borderRadius: 4,
		background: "#0a84ff",
		cursor: "ew-resize",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
	});

	return (
		<div className="flex h-screen w-screen flex-col gap-3 bg-[rgba(24,24,26,0.99)] p-4 text-white select-none">
			<div className="flex items-center justify-between">
				<span className="text-[13px] font-semibold">Recording preview</span>
				<button
					type="button"
					onClick={() => getCurrentWindow().close()}
					className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-white/70 hover:bg-white/20"
				>
					<X size={15} />
				</button>
			</div>

			<video
				ref={videoRef}
				src={src}
				controls
				autoPlay
				onLoadedMetadata={onLoaded}
				className="min-h-0 flex-1 rounded-lg bg-black"
				style={{ objectFit: "contain", width: "100%" }}
			/>

			{/* Trim strip */}
			<div
				ref={trackRef}
				className="relative h-14 overflow-hidden rounded-md bg-black/40"
			>
				<div className="absolute inset-0 flex">
					{thumbs.map((t, i) => (
						<img
							key={i}
							src={t}
							alt=""
							className="h-full flex-1 object-cover"
							draggable={false}
						/>
					))}
				</div>
				{/* dim outside selection */}
				<div
					className="absolute inset-y-0 left-0 bg-black/60"
					style={{ width: `${pct(start)}%` }}
				/>
				<div
					className="absolute inset-y-0 right-0 bg-black/60"
					style={{ width: `${100 - pct(end)}%` }}
				/>
				{/* selection outline */}
				<div
					className="absolute inset-y-0 border-y-2 border-[#0a84ff]"
					style={{ left: `${pct(start)}%`, width: `${pct(end) - pct(start)}%` }}
				/>
				<div
					style={handle(pct(start))}
					onPointerDown={(e) => {
						e.preventDefault();
						dragRef.current = "start";
					}}
				/>
				<div
					style={handle(pct(end))}
					onPointerDown={(e) => {
						e.preventDefault();
						dragRef.current = "end";
					}}
				/>
			</div>

			<div className="flex items-center justify-between">
				<span className="text-[12px] text-white/55">
					{err ? (
						<span className="text-[#ff6b6b]">{err}</span>
					) : (
						`${fmt(start)} – ${fmt(end)}  ·  ${fmt(end - start)} selected`
					)}
				</span>
				<div className="flex gap-2">
					<button
						type="button"
						onClick={discard}
						className="h-9 rounded-lg bg-white/10 px-4 text-[13px] font-medium text-white hover:bg-white/20"
					>
						Discard
					</button>
					<button
						type="button"
						onClick={save}
						className="h-9 rounded-lg bg-[#0a84ff] px-4 text-[13px] font-semibold text-white hover:bg-[#3a9bff]"
					>
						Save…
					</button>
				</div>
			</div>
		</div>
	);
}
