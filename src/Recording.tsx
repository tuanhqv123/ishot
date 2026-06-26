import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
	Mic,
	MicOff,
	Video,
	VideoOff,
	Circle,
	Pause,
	Play,
	Square,
	X,
} from "lucide-react";
import Dropdown, { type DropdownOption } from "./Dropdown";

interface MonitorInfo {
	x: number;
	y: number;
	width: number;
	height: number;
	scale_factor: number;
}
interface WindowInfo {
	id: number;
	app_name: string;
	title: string;
	w: number;
	h: number;
}
interface CaptureTargets {
	monitors: MonitorInfo[];
	windows: WindowInfo[];
}
interface RecordingStatus {
	recording: boolean;
	paused: boolean;
}

type SourceValue = string;

// Icon button matching the app's ToolBtn (light toolbar).
const toolBtn = (active = false): CSSProperties => ({
	width: "var(--ctrl)",
	height: "var(--ctrl)",
	padding: 0,
	border: "none",
	borderRadius: "var(--radius-s)",
	cursor: "pointer",
	background: active ? "var(--accent)" : "transparent",
	color: active ? "#fff" : "var(--label)",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
});

export default function Recording() {
	const [targets, setTargets] = useState<CaptureTargets | null>(null);
	const [source, setSource] = useState<SourceValue>("screen:0");
	const [mic, setMic] = useState(false);
	const [camera, setCamera] = useState(false);
	const [status, setStatus] = useState<RecordingStatus>({
		recording: false,
		paused: false,
	});
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		invoke<CaptureTargets>("list_capture_targets")
			.then(setTargets)
			.catch((e) => console.error("list_capture_targets", e));
		// Initialise from current state — the bar is often opened *after*
		// recording already started (from the toolbar Record flow).
		invoke<RecordingStatus>("recording_status")
			.then(setStatus)
			.catch(() => {});
		const un = listen<RecordingStatus>("recording-state", (e) =>
			setStatus(e.payload),
		);
		return () => {
			un.then((f) => f());
		};
	}, []);

	// Elapsed timer: counts up while recording and not paused.
	useEffect(() => {
		if (!status.recording) {
			setElapsed(0);
			return;
		}
		if (status.paused) return;
		const t = setInterval(() => setElapsed((e) => e + 1), 1000);
		return () => clearInterval(t);
	}, [status.recording, status.paused]);
	const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(
		elapsed % 60,
	).padStart(2, "0")}`;

	// The source menu can exceed the bar window; ask the backend to grow the
	// window upward while it's open (Rust main-thread sizing is the reliable path).
	const onMenuOpen = useCallback((open: boolean) => {
		invoke("set_recorder_expanded", { expanded: open }).catch((e) =>
			console.error("set_recorder_expanded", e),
		);
	}, []);

	const start = useCallback(async () => {
		const [kind, idStr] = source.split(":");
		try {
			await invoke("start_recording", {
				opts: {
					source: kind === "window" ? "window" : "screen",
					window_id: kind === "window" ? Number(idStr) : null,
					monitor: kind === "screen" ? Number(idStr) : null,
					mic,
					camera,
					crop: null,
				},
			});
		} catch (e) {
			console.error("start_recording", e);
		}
	}, [source, mic, camera]);

	const stop = useCallback(async () => {
		try {
			await invoke<string | null>("stop_recording");
			invoke("close_camera_bubble").catch(() => {});
		} catch (e) {
			console.error("stop_recording", e);
		}
	}, []);

	const toggleCamera = useCallback(() => {
		setCamera((on) => {
			const next = !on;
			invoke(next ? "open_camera_bubble" : "close_camera_bubble").catch(() => {});
			return next;
		});
	}, []);

	const togglePause = useCallback(async () => {
		try {
			await invoke(status.paused ? "resume_recording" : "pause_recording");
		} catch (e) {
			console.error("pause/resume", e);
		}
	}, [status.paused]);

	const close = () => getCurrentWindow().close();

	const sourceOptions: DropdownOption[] = [
		...(targets?.monitors.map((_, i) => ({
			value: `screen:${i}`,
			label:
				(targets?.monitors.length ?? 0) > 1
					? `Entire screen ${i + 1}`
					: "Entire screen",
		})) ?? []),
		...(targets?.windows.slice(0, 40).map((w) => ({
			value: `window:${w.id}`,
			label: w.title ? `${w.app_name} — ${w.title}` : w.app_name,
		})) ?? []),
	];

	return (
		<div
			style={{
				position: "fixed",
				inset: 0,
				display: "flex",
				flexDirection: "column",
				justifyContent: "flex-end",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: "var(--gap)",
					height: "100%",
					padding: "0 8px",
					background: "var(--surface)",
					borderRadius: "var(--radius-m)",
					boxShadow: "var(--shadow-pop)",
					userSelect: "none",
				}}
			>
				{!status.recording ? (
					<>
						<Dropdown
							light
							value={source}
							onChange={setSource}
							options={sourceOptions}
							openUp
							onOpenChange={onMenuOpen}
						/>
						<button
							type="button"
							title={mic ? "Microphone on" : "Microphone off"}
							style={toolBtn(mic)}
							onClick={() => setMic((v) => !v)}
						>
							{mic ? <Mic size={17} /> : <MicOff size={17} />}
						</button>
						<button
							type="button"
							title={camera ? "Camera on" : "Camera off"}
							style={toolBtn(camera)}
							onClick={toggleCamera}
						>
							{camera ? <Video size={17} /> : <VideoOff size={17} />}
						</button>
						<button
							type="button"
							title="Start recording"
							onClick={start}
							style={{
								height: "var(--ctrl)",
								padding: "0 12px",
								border: "none",
								borderRadius: "var(--radius-s)",
								cursor: "pointer",
								background: "#ff3b30",
								color: "#fff",
								fontSize: 13,
								fontWeight: 600,
								display: "flex",
								alignItems: "center",
								gap: 6,
							}}
						>
							<Circle size={11} fill="currentColor" />
							Record
						</button>
						<button
							type="button"
							title="Close"
							style={toolBtn(false)}
							onClick={close}
						>
							<X size={16} />
						</button>
					</>
				) : (
					<>
						<div
							style={{
								display: "flex",
								flex: 1,
								alignItems: "center",
								gap: 8,
								padding: "0 6px",
								color: "var(--label)",
								fontSize: 13,
							}}
						>
							<span
								style={{
									width: 9,
									height: 9,
									borderRadius: "50%",
									background: "#ff3b30",
								}}
							/>
							<span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
								{mmss}
							</span>
							{status.paused && (
								<span style={{ color: "var(--label-2)" }}>Paused</span>
							)}
						</div>
						<button
							type="button"
							title={status.paused ? "Resume" : "Pause"}
							onClick={togglePause}
							style={toolBtn(false)}
						>
							{status.paused ? <Play size={17} /> : <Pause size={17} />}
						</button>
						<button
							type="button"
							title="Stop"
							onClick={stop}
							style={{
								height: "var(--ctrl)",
								padding: "0 12px",
								border: "none",
								borderRadius: "var(--radius-s)",
								cursor: "pointer",
								background: "var(--accent)",
								color: "#fff",
								fontSize: 13,
								fontWeight: 600,
								display: "flex",
								alignItems: "center",
								gap: 6,
							}}
						>
							<Square size={12} fill="currentColor" />
							Stop
						</button>
					</>
				)}
			</div>
		</div>
	);
}
