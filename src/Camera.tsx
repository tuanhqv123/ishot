import { useEffect, useRef, useState } from "react";

// Circular webcam bubble (Loom-style). It's a normal on-screen window, so the
// screen recorder captures it automatically when it's within the recorded area.
// Draggable via the whole surface (data-tauri-drag-region).
export default function Camera() {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let stream: MediaStream | null = null;
		navigator.mediaDevices
			.getUserMedia({ video: { width: 640, height: 640 }, audio: false })
			.then((s) => {
				stream = s;
				if (videoRef.current) videoRef.current.srcObject = s;
			})
			.catch((e) => {
				console.error("camera getUserMedia failed", e);
				setError("No camera access");
			});
		return () => stream?.getTracks().forEach((t) => t.stop());
	}, []);

	return (
		<div
			data-tauri-drag-region
			className="flex h-screen w-screen items-center justify-center overflow-hidden rounded-full bg-black shadow-[0_8px_30px_rgba(0,0,0,0.45)]"
			style={{ boxShadow: "0 8px 30px rgba(0,0,0,0.45), inset 0 0 0 2px rgba(255,255,255,0.15)" }}
		>
			{error ? (
				<span className="px-3 text-center text-[11px] text-white/70">{error}</span>
			) : (
				<video
					ref={videoRef}
					autoPlay
					playsInline
					muted
					className="h-full w-full object-cover"
					style={{ transform: "scaleX(-1)" }}
				/>
			)}
		</div>
	);
}
