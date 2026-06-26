import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
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

const BAR_W = 540;
const BAR_H = 68;
// Extra height the window grows by (upward) while the source menu is open, so
// the dropdown isn't clipped by the tiny bar window.
const MENU_EXTRA = 264;

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

	// Grow the window upward while the menu is open (and restore on close) so the
	// dropdown has room to render outside the 68px bar.
	const onMenuOpen = useCallback(async (open: boolean) => {
		const win = getCurrentWindow();
		try {
			const scale = await win.scaleFactor();
			const pos = await win.outerPosition();
			const extra = Math.round(MENU_EXTRA * scale);
			if (open) {
				await win.setPosition(new PhysicalPosition(pos.x, pos.y - extra));
				await win.setSize(
					new PhysicalSize(
						Math.round(BAR_W * scale),
						Math.round((BAR_H + MENU_EXTRA) * scale),
					),
				);
			} else {
				await win.setSize(
					new PhysicalSize(
						Math.round(BAR_W * scale),
						Math.round(BAR_H * scale),
					),
				);
				await win.setPosition(new PhysicalPosition(pos.x, pos.y + extra));
			}
		} catch (e) {
			console.error("resize record bar", e);
		}
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
			// TODO(preview): open the preview+timeline window with the returned path.
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

	const pill =
		"flex items-center justify-center rounded-full transition-colors";
	const toggleCls = (on: boolean) =>
		`${pill} h-9 w-9 ${on ? "bg-white/90 text-black" : "bg-white/10 text-white/85 hover:bg-white/20"}`;

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
			<div className="flex h-[68px] w-full items-center gap-2.5 rounded-2xl bg-[rgba(28,28,30,0.95)] px-3 text-white shadow-[0_10px_36px_rgba(0,0,0,0.45)] backdrop-blur-2xl select-none">
				{!status.recording ? (
					<>
						<Dropdown
							value={source}
							onChange={setSource}
							options={sourceOptions}
							openUp
							onOpenChange={onMenuOpen}
						/>
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
		</div>
	);
}
