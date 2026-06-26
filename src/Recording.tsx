import { useCallback, useEffect, useState } from "react";
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

// `screen:<idx>` or `window:<id>` — encodes both the source kind and which one.
type SourceValue = string;

export default function Recording() {
	const [targets, setTargets] = useState<CaptureTargets | null>(null);
	const [source, setSource] = useState<SourceValue>("screen:0");
	const [mic, setMic] = useState(false);
	const [camera, setCamera] = useState(false);
	const [status, setStatus] = useState<RecordingStatus>({
		recording: false,
		paused: false,
	});

	useEffect(() => {
		invoke<CaptureTargets>("list_capture_targets")
			.then(setTargets)
			.catch((e) => console.error("list_capture_targets", e));
		const un = listen<RecordingStatus>("recording-state", (e) =>
			setStatus(e.payload),
		);
		return () => {
			un.then((f) => f());
		};
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
				},
			});
		} catch (e) {
			console.error("start_recording", e);
		}
	}, [source, mic, camera]);

	const stop = useCallback(async () => {
		try {
			await invoke<string | null>("stop_recording");
			// TODO(preview): when the capture engine returns a path, open the
			// preview+timeline window instead of just closing.
		} catch (e) {
			console.error("stop_recording", e);
		}
	}, []);

	const togglePause = useCallback(async () => {
		try {
			await invoke(status.paused ? "resume_recording" : "pause_recording");
		} catch (e) {
			console.error("pause/resume", e);
		}
	}, [status.paused]);

	const close = () => getCurrentWindow().close();

	const pill =
		"flex items-center justify-center rounded-full transition-colors";
	const toggleCls = (on: boolean) =>
		`${pill} h-9 w-9 ${on ? "bg-white/90 text-black" : "bg-white/10 text-white/85 hover:bg-white/20"}`;

	return (
		<div className="flex h-screen w-screen items-center gap-2.5 rounded-2xl bg-[rgba(28,28,30,0.92)] px-3 text-white shadow-[0_10px_36px_rgba(0,0,0,0.45)] backdrop-blur-2xl select-none">
			{!status.recording ? (
				<>
					<select
						value={source}
						onChange={(e) => setSource(e.target.value)}
						className="h-9 flex-1 min-w-0 rounded-lg border border-white/15 bg-white/8 px-2 text-[13px] text-white outline-none"
					>
						{targets?.monitors.map((_, i) => (
							<option key={`screen:${i}`} value={`screen:${i}`}>
								{targets.monitors.length > 1
									? `Entire screen ${i + 1}`
									: "Entire screen"}
							</option>
						))}
						{targets?.windows.slice(0, 40).map((w) => (
							<option key={`window:${w.id}`} value={`window:${w.id}`}>
								{w.app_name}
								{w.title ? ` — ${w.title}` : ""}
							</option>
						))}
					</select>

					<button
						type="button"
						title={mic ? "Microphone on" : "Microphone off"}
						className={toggleCls(mic)}
						onClick={() => setMic((v) => !v)}
					>
						{mic ? <Mic size={17} /> : <MicOff size={17} />}
					</button>
					<button
						type="button"
						title={camera ? "Camera on" : "Camera off"}
						className={toggleCls(camera)}
						onClick={() => setCamera((v) => !v)}
					>
						{camera ? <Video size={17} /> : <VideoOff size={17} />}
					</button>

					<button
						type="button"
						title="Start recording"
						onClick={start}
						className={`${pill} h-9 gap-1.5 bg-[#ff453a] px-3.5 text-[13px] font-semibold text-white hover:bg-[#ff5c52]`}
					>
						<Circle size={11} fill="currentColor" />
						Record
					</button>
					<button
						type="button"
						title="Close"
						onClick={close}
						className={`${pill} h-9 w-9 bg-white/10 text-white/70 hover:bg-white/20`}
					>
						<X size={16} />
					</button>
				</>
			) : (
				<>
					<div className="flex flex-1 items-center gap-2 px-1 text-[13px]">
						<span
							className={`h-2.5 w-2.5 rounded-full bg-[#ff453a] ${status.paused ? "" : "animate-pulse"}`}
						/>
						{status.paused ? "Paused" : "Recording…"}
					</div>
					<button
						type="button"
						title={status.paused ? "Resume" : "Pause"}
						onClick={togglePause}
						className={`${pill} h-9 w-9 bg-white/10 text-white hover:bg-white/20`}
					>
						{status.paused ? <Play size={17} /> : <Pause size={17} />}
					</button>
					<button
						type="button"
						title="Stop"
						onClick={stop}
						className={`${pill} h-9 gap-1.5 bg-white px-3.5 text-[13px] font-semibold text-black hover:bg-white/90`}
					>
						<Square size={12} fill="currentColor" />
						Stop
					</button>
				</>
			)}
		</div>
	);
}
