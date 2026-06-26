import { useEffect, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { X } from "lucide-react";

// Post-record preview: plays the clip (native scrubber = timeline) and shows a
// thumbnail strip generated from the video, with Save / Discard.
export default function RecordingPreview() {
	const path = new URLSearchParams(location.search).get("path") || "";
	const src = path ? convertFileSrc(path) : "";
	const [thumbs, setThumbs] = useState<string[]>([]);
	const [saved, setSaved] = useState<string | null>(null);

	// Generate ~8 thumbnails. Load the file as a blob first so the canvas draw
	// isn't tainted by the asset protocol (which would block toDataURL).
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
					v.onerror = () => rej(new Error("metadata"));
				});
				const dur = v.duration || 0;
				const N = 8;
				const out: string[] = [];
				const canvas = document.createElement("canvas");
				for (let i = 0; i < N && !cancelled; i++) {
					const t = (dur * (i + 0.5)) / N;
					await new Promise<void>((res) => {
						v.onseeked = () => res();
						v.currentTime = Math.min(t, Math.max(0, dur - 0.05));
					});
					const ar = v.videoHeight / v.videoWidth || 0.56;
					canvas.width = 160;
					canvas.height = Math.round(160 * ar);
					canvas.getContext("2d")!.drawImage(v, 0, 0, canvas.width, canvas.height);
					out.push(canvas.toDataURL("image/jpeg", 0.6));
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

	const save = async () => {
		try {
			const dest = await invoke<string>("save_recording", { path });
			setSaved(dest);
		} catch (e) {
			console.error("save_recording", e);
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
	const closeWin = () => getCurrentWindow().close();

	return (
		<div className="flex h-screen w-screen flex-col gap-3 bg-[rgba(24,24,26,0.99)] p-4 text-white select-none">
			<div className="flex items-center justify-between">
				<span className="text-[13px] font-semibold">Recording preview</span>
				<button
					type="button"
					onClick={closeWin}
					className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-white/70 hover:bg-white/20"
				>
					<X size={15} />
				</button>
			</div>

			<video
				src={src}
				controls
				autoPlay
				className="min-h-0 flex-1 rounded-lg bg-black"
				style={{ objectFit: "contain", width: "100%" }}
			/>

			{thumbs.length > 0 && (
				<div className="flex gap-1 overflow-x-auto rounded-md bg-black/30 p-1">
					{thumbs.map((t, i) => (
						<img
							key={i}
							src={t}
							alt=""
							className="h-12 shrink-0 rounded"
							draggable={false}
						/>
					))}
				</div>
			)}

			<div className="flex items-center justify-between">
				<span className="text-[12px] text-white/45">
					{saved ? `Saved → ${saved}` : ""}
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
