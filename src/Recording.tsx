import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Pause, Play, Square } from "lucide-react";

interface RecordingStatus {
	recording: boolean;
	paused: boolean;
}

// Minimal in-recording controls: red dot + timer + pause + stop. The record
// SETUP (source/mic/camera) lives in the capture toolbar's Row 2 — this bar is
// only shown while recording, so it stays small and isn't redundant.
export default function Recording() {
	const [status, setStatus] = useState<RecordingStatus>({
		recording: false,
		paused: false,
	});
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		invoke<RecordingStatus>("recording_status").then(setStatus).catch(() => {});
		const un = listen<RecordingStatus>("recording-state", (e) =>
			setStatus(e.payload),
		);
		return () => {
			un.then((f) => f());
		};
	}, []);

	useEffect(() => {
		if (!status.recording || status.paused) return;
		const t = setInterval(() => setElapsed((e) => e + 1), 1000);
		return () => clearInterval(t);
	}, [status.recording, status.paused]);

	const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(
		elapsed % 60,
	).padStart(2, "0")}`;

	const stop = useCallback(async () => {
		try {
			await invoke("stop_recording");
		} catch (e) {
			console.error("stop_recording", e);
		}
		invoke("close_camera_bubble").catch(() => {});
		getCurrentWindow().close();
	}, []);

	const togglePause = useCallback(async () => {
		try {
			await invoke(status.paused ? "resume_recording" : "pause_recording");
		} catch (e) {
			console.error("pause/resume", e);
		}
	}, [status.paused]);

	const iconBtn: CSSProperties = {
		width: 28,
		height: 28,
		border: "none",
		borderRadius: "var(--radius-s)",
		cursor: "pointer",
		background: "transparent",
		color: "var(--label)",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
	};

	return (
		<div
			style={{
				position: "fixed",
				inset: 0,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			<div
				data-tauri-drag-region
				title="Drag to move"
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					height: "100%",
					padding: "0 10px",
					background: "var(--surface)",
					borderRadius: "var(--radius-m)",
					boxShadow: "var(--shadow-pop)",
					userSelect: "none",
					cursor: "grab",
				}}
			>
				<span
					style={{
						width: 9,
						height: 9,
						borderRadius: "50%",
						background: "#ff3b30",
						flexShrink: 0,
						opacity: status.paused ? 0.4 : 1,
					}}
				/>
				<span
					style={{
						fontVariantNumeric: "tabular-nums",
						fontWeight: 600,
						fontSize: 13,
						color: "var(--label)",
						minWidth: 42,
					}}
				>
					{mmss}
				</span>
				<button
					type="button"
					title={status.paused ? "Resume" : "Pause"}
					onClick={togglePause}
					style={iconBtn}
				>
					{status.paused ? <Play size={16} /> : <Pause size={16} />}
				</button>
				<button
					type="button"
					title="Stop"
					onClick={stop}
					style={{
						...iconBtn,
						width: "auto",
						padding: "0 10px",
						gap: 6,
						background: "var(--accent)",
						color: "#fff",
						fontSize: 13,
						fontWeight: 600,
					}}
				>
					<Square size={11} fill="currentColor" />
					Stop
				</button>
			</div>
		</div>
	);
}
