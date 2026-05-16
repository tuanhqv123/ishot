import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
	ArrowRight,
	Check,
	Circle,
	Download,
	Grid3X3,
	Languages,
	Minus,
	Pencil,
	ScanText,
	ImageDown,
	ChevronDown,
	Square,
	Type,
	Undo2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

// Detect which monitor this window belongs to based on label
function getWindowMonitorIndex(): number {
	const label = getCurrentWindow().label;
	const match = label.match(/^overlay_(\d+)$/);
	return match ? parseInt(match[1]) : 0;
}

interface Region {
	x: number;
	y: number;
	width: number;
	height: number;
}
interface TextBlock {
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
	confidence: number;
}
interface MonitorInfo {
	x: number;
	y: number;
	width: number;
	height: number;
	scale_factor: number;
}

interface Annotation {
	id: number;
	type: "rect" | "oval" | "arrow" | "line" | "draw" | "blur" | "textbox";
	x: number;
	y: number;
	w?: number;
	h?: number;
	ex?: number;
	ey?: number;
	path?: { x: number; y: number }[];
	blurStrength?: number;
	blurMode?: "rect" | "draw";
	color?: string;
	text?: string;
	fontSize?: number;
	strokeWidth?: number;
	bold?: boolean;
	underline?: boolean;
}

interface DisplayCapture {
	data: string;
	width: number;
	height: number;
	monitor: MonitorInfo;
}

type Stage = "idle" | "selecting" | "editing";
type Tool =
	| "rect"
	| "oval"
	| "arrow"
	| "line"
	| "draw"
	| "blur"
	| "text"
	| "textbox"
	| null;

let annotationId = 0;

function App() {
	const [stage, setStage] = useState<Stage>("idle");
	const [displayCaptures, setDisplayCaptures] = useState<DisplayCapture[]>([]);
	const [imgDims, setImgDims] = useState({ w: 0, h: 0 });
	const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
	const [selection, setSelection] = useState<Region | null>(null);
	const [isDragging, setIsDragging] = useState(false);
	const dragStartRef = useRef<{ x: number; y: number } | null>(null);

	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [tool, setTool] = useState<Tool>(null);
	const [isDrawing, setIsDrawing] = useState(false);
	const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(
		null,
	);
	const [annotations, setAnnotations] = useState<Annotation[]>([]);
	const [currentPath, setCurrentPath] = useState<{ x: number; y: number }[]>(
		[],
	);
	const [selectedAnnotation, setSelectedAnnotation] = useState<number | null>(
		null,
	);
	const [blurStrength, setBlurStrength] = useState(10);
	const [tempBlur, setTempBlur] = useState<Region | null>(null);
	const [fontSize, setFontSize] = useState(
		() => Number(localStorage.getItem("ishot-fontsize")) || 16,
	);
	const [fontBold, setFontBold] = useState(false);
	const [fontUnderline, setFontUnderline] = useState(false);
	const [strokeWidth, setStrokeWidth] = useState(2);
	const [editingTextId, setEditingTextId] = useState<number | null>(null);
	const [shiftHeld, setShiftHeld] = useState(false);
	const [lockedByOther, setLockedByOther] = useState(false);
	const [scrollCapturing, setScrollCapturing] = useState(false);
	const [scrollFrames, setScrollFrames] = useState(0);
	// Auto-scroll speed in pixels-per-second. Presets: Slow=300, Medium=600, Fast=1200.
	// Higher = faster total capture but more risk of mid-animation captures.
	const [scrollSpeedPps, setScrollSpeedPps] = useState<number>(
		() => Number(localStorage.getItem("ishot-scroll-speed")) || 600,
	);
	const [showScreenshot] = useState(true);

	// Color picker
	const COLORS = [
		"#ff0000",
		"#ff9500",
		"#ffcc00",
		"#34c759",
		"#007aff",
		"#af52de",
		"#000000",
		"#ffffff",
	];
	const [strokeColor, setStrokeColor] = useState(
		() => localStorage.getItem("ishot-color") || "#ff0000",
	);

	// OCR
	const [textBlocks, setTextBlocks] = useState<TextBlock[]>([]);
	const [ocrLoading, setOcrLoading] = useState(false);
	const [selectedText, setSelectedText] = useState("");
	const [selectedBlockIndices, setSelectedBlockIndices] = useState<Set<number>>(
		new Set(),
	);
	const [isSelectingText, setIsSelectingText] = useState(false);
	const textSelectionStart = useRef<{ x: number; y: number } | null>(null);
	const textSelectionRect = useRef<Region | null>(null);

	const resetState = useCallback(() => {
		setDisplayCaptures([]);
		setSelection(null);
		setStage("idle");
		setIsDragging(false);
		setAnnotations([]);
		setTextBlocks([]);
		setSelectedText("");
		setSelectedBlockIndices(new Set());
		setOcrLoading(false);
		setSelectedAnnotation(null);
		setTool(null);
		setTempBlur(null);
		setTranslatedText("");
		setTranslateLoading(false);
		setShowTranslate(false);
		setTranslateSource("");
		setLockedByOther(false);
		setScrollCapturing(false);
		setScrollFrames(0);
		dragStartRef.current = null;
	}, []);

	const cancelCapture = useCallback(async () => {
		resetState();
		// Notify all overlay windows to reset state, then hide
		try {
			await emit("cancel-capture");
		} catch (e) {
			console.error(e);
		}
		try {
			await invoke("hide_overlay");
		} catch (e) {
			console.error(e);
		}
	}, []);

	// Simple box blur implementation
	const applyBoxBlur = (imageData: ImageData, radius: number) => {
		const data = imageData.data;
		const w = imageData.width,
			h = imageData.height;
		const copy = new Uint8ClampedArray(data);
		const passes = 3; // Multiple passes for smoother blur

		for (let pass = 0; pass < passes; pass++) {
			// Horizontal pass
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					let r = 0,
						g = 0,
						b = 0,
						a = 0,
						count = 0;
					for (let dx = -radius; dx <= radius; dx++) {
						const nx = Math.min(w - 1, Math.max(0, x + dx));
						const idx = (y * w + nx) * 4;
						r += copy[idx];
						g += copy[idx + 1];
						b += copy[idx + 2];
						a += copy[idx + 3];
						count++;
					}
					const idx = (y * w + x) * 4;
					data[idx] = r / count;
					data[idx + 1] = g / count;
					data[idx + 2] = b / count;
					data[idx + 3] = a / count;
				}
			}
			copy.set(data);
			// Vertical pass
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					let r = 0,
						g = 0,
						b = 0,
						a = 0,
						count = 0;
					for (let dy = -radius; dy <= radius; dy++) {
						const ny = Math.min(h - 1, Math.max(0, y + dy));
						const idx = (ny * w + x) * 4;
						r += copy[idx];
						g += copy[idx + 1];
						b += copy[idx + 2];
						a += copy[idx + 3];
						count++;
					}
					const idx = (y * w + x) * 4;
					data[idx] = r / count;
					data[idx + 1] = g / count;
					data[idx + 2] = b / count;
					data[idx + 3] = a / count;
				}
			}
			copy.set(data);
		}
	};

	// Get this window's display capture
	const findDisplay = useCallback((): DisplayCapture | null => {
		return displayCaptures[getWindowMonitorIndex()] || null;
	}, [displayCaptures]);

	const renderFinalImage = useCallback(async (): Promise<Uint8Array | null> => {
		if (displayCaptures.length === 0 || !selection) return null;
		const dc = findDisplay();
		if (!dc) return null;

		const canvas = document.createElement("canvas");
		const img = new Image();
		img.src = `data:image/png;base64,${dc.data}`;
		await new Promise((r) => (img.onload = r));

		const scale = dc.monitor.scale_factor;
		// Selection coords are window-relative, map directly to display image
		const sx = selection.x * scale;
		const sy = selection.y * scale;
		const sw = Math.round(selection.width * scale);
		const sh = Math.round(selection.height * scale);
		canvas.width = sw;
		canvas.height = sh;
		const ctx = canvas.getContext("2d")!;
		ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

		// Apply blur using box blur algorithm
		for (const ann of annotations) {
			if (ann.type === "blur" && ann.w && ann.h) {
				const strength = Math.round(((ann.blurStrength || 10) * scale) / 2);
				const bx = Math.round(Math.min(ann.x, ann.x + ann.w) * scale);
				const by = Math.round(Math.min(ann.y, ann.y + ann.h) * scale);
				const bw = Math.round(Math.abs(ann.w) * scale);
				const bh = Math.round(Math.abs(ann.h) * scale);

				if (bw > 0 && bh > 0) {
					const imageData = ctx.getImageData(bx, by, bw, bh);
					applyBoxBlur(imageData, strength);
					ctx.putImageData(imageData, bx, by);
				}
			}
		}

		if (canvasRef.current)
			ctx.drawImage(
				canvasRef.current,
				0,
				0,
				selection.width,
				selection.height,
				0,
				0,
				sw,
				sh,
			);

		// Draw textbox annotations
		for (const ann of annotations) {
			if (ann.type === "textbox" && ann.text && ann.w && ann.h) {
				const fs = (ann.fontSize || 16) * scale;
				ctx.fillStyle = ann.color || "#ff0000";
				ctx.font = `${ann.bold ? "bold " : ""}${fs}px sans-serif`;
				ctx.textBaseline = "top";
				const lines = ann.text.split("\n");
				const lineH = fs * 1.3;
				for (let li = 0; li < lines.length; li++) {
					const tx = ann.x * scale,
						ty = (ann.y + 2) * scale + li * lineH;
					ctx.fillText(lines[li], tx, ty, ann.w * scale);
					if (ann.underline) {
						const metrics = ctx.measureText(lines[li]);
						ctx.fillRect(
							tx,
							ty + fs * 1.1,
							Math.min(metrics.width, ann.w * scale),
							Math.max(1, fs / 12),
						);
					}
				}
			}
		}

		const base64 = canvas.toDataURL("image/png").split(",")[1];
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}, [displayCaptures, selection, annotations, findDisplay]);

	const handleDone = useCallback(async () => {
		const bytes = await renderFinalImage();
		if (bytes) {
			await invoke("copy_to_clipboard", { imageBytes: Array.from(bytes) });
			await cancelCapture();
		}
	}, [renderFinalImage, cancelCapture]);

	const handleSave = useCallback(async () => {
		const bytes = await renderFinalImage();
		if (bytes) {
			try {
				await invoke("save_to_file", { imageBytes: Array.from(bytes) });
				await cancelCapture();
			} catch (e) {
				console.error(e);
			}
		}
	}, [renderFinalImage, cancelCapture]);

	const handleUndo = useCallback(() => {
		setAnnotations((prev) => prev.slice(0, -1));
		setSelectedAnnotation(null);
		setEditingTextId(null);
	}, []);

	const deleteSelectedAnnotation = useCallback(() => {
		if (selectedAnnotation !== null) {
			setAnnotations((prev) => prev.filter((a) => a.id !== selectedAnnotation));
			setSelectedAnnotation(null);
		}
	}, [selectedAnnotation]);

	const performOcr = useCallback(async () => {
		if (displayCaptures.length === 0 || !selection || ocrLoading) return;
		setOcrLoading(true);
		try {
			const dc = findDisplay();
			if (!dc) return;

			const canvas = document.createElement("canvas");
			const img = new Image();
			img.src = `data:image/png;base64,${dc.data}`;
			await new Promise((r) => (img.onload = r));
			const scale = dc.monitor.scale_factor;
			const sx = selection.x * scale;
			const sy = selection.y * scale;
			canvas.width = Math.round(selection.width * scale);
			canvas.height = Math.round(selection.height * scale);
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(
				img,
				sx,
				sy,
				canvas.width,
				canvas.height,
				0,
				0,
				canvas.width,
				canvas.height,
			);
			const base64 = canvas.toDataURL("image/png").split(",")[1];
			const binary = atob(base64);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			const result = await invoke<{ blocks: TextBlock[] }>("perform_ocr", {
				pngData: Array.from(bytes),
			});
			setTextBlocks(
				result.blocks.map((b) => ({
					...b,
					x: b.x / scale,
					y: b.y / scale,
					width: b.width / scale,
					height: b.height / scale,
				})),
			);
		} catch (e) {
			console.error(e);
		} finally {
			setOcrLoading(false);
		}
	}, [displayCaptures, selection, ocrLoading, findDisplay]);

	const [translatedText, setTranslatedText] = useState("");
	const [translateLoading, setTranslateLoading] = useState(false);
	const [showTranslate, setShowTranslate] = useState(false);
	// OCR'd source text from the most recent translate request. Persisted so
	// that switching the target-language dropdown re-runs translation without
	// re-running OCR (slow + lossy).
	const [translateSource, setTranslateSource] = useState("");
	const [translateTarget, setTranslateTarget] = useState<string>(
		() => localStorage.getItem("ishot-translate-target") || "vi",
	);

	// Pure translate call (no OCR). Used by handleTranslate AND by the
	// language-dropdown change handler in the result dialog.
	const runTranslation = useCallback(
		async (sourceText: string, target: string) => {
			setTranslateLoading(true);
			setTranslatedText("");
			try {
				const result = await invoke<{
					translated: string;
					source_lang: string;
					target_lang: string;
				}>("translate_text", { text: sourceText, targetLang: target });
				setTranslatedText(result.translated);
			} catch (e) {
				setTranslatedText("Translation failed: " + e);
			} finally {
				setTranslateLoading(false);
			}
		},
		[],
	);

	const handleTranslate = useCallback(async () => {
		if (displayCaptures.length === 0 || !selection || translateLoading) return;
		setTranslateLoading(true);
		setShowTranslate(true);
		setTranslatedText("");
		try {
			// OCR the selection first.
			const dc = findDisplay();
			if (!dc) return;
			const canvas = document.createElement("canvas");
			const img = new Image();
			img.src = `data:image/png;base64,${dc.data}`;
			await new Promise((r) => (img.onload = r));
			const s = dc.monitor.scale_factor;
			canvas.width = Math.round(selection.width * s);
			canvas.height = Math.round(selection.height * s);
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(
				img,
				selection.x * s,
				selection.y * s,
				canvas.width,
				canvas.height,
				0,
				0,
				canvas.width,
				canvas.height,
			);
			const base64 = canvas.toDataURL("image/png").split(",")[1];
			const binary = atob(base64);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			const ocrResult = await invoke<{
				blocks: { text: string }[];
				full_text: string;
			}>("perform_ocr", { pngData: Array.from(bytes) });
			const sourceText =
				ocrResult.full_text || ocrResult.blocks.map((b) => b.text).join(" ");
			if (!sourceText.trim()) {
				setTranslatedText("(No text detected)");
				setTranslateLoading(false);
				return;
			}
			setTranslateSource(sourceText);
			// Pick initial target language: if source looks ASCII (likely English) →
			// translate to current preference (default vi); else → en.
			const initialTarget = /^[a-zA-Z\s.,!?'"()-]+$/.test(sourceText)
				? translateTarget
				: "en";
			setTranslateTarget(initialTarget);
			await runTranslation(sourceText, initialTarget);
		} catch (e) {
			setTranslatedText("Translation failed: " + e);
			setTranslateLoading(false);
		}
	}, [
		displayCaptures,
		selection,
		translateLoading,
		findDisplay,
		runTranslation,
		translateTarget,
	]);

	const handleToolChange = useCallback(
		(newTool: Tool) => {
			setTool(newTool);
			setSelectedAnnotation(null);
			// Picking ANY annotation tool exits scroll-ready mode. Without this,
			// the scroll-shot icon stays highlighted even after switching to e.g.
			// Rect — two tools appearing selected at the same time.
			setScrollCapturing(false);
			setScrollFrames(0);
			if (newTool === "text" && textBlocks.length === 0 && !ocrLoading)
				performOcr();
			if (newTool !== "text") {
				setSelectedText("");
				setSelectedBlockIndices(new Set());
			}
		},
		[textBlocks.length, ocrLoading, performOcr],
	);

	useEffect(() => {
		const unlistenClear = listen("screenshot-clear", () => {
			// Full reset — never leak state from a previous capture session into
			// the next one. The scroll-capture state in particular is critical:
			// stale scrollCapturing/scrollFrames hides the toolbar AND the dim overlay.
			setDisplayCaptures([]);
			setStage("idle");
			setSelection(null);
			setAnnotations([]);
			setTextBlocks([]);
			setSelectedText("");
			setSelectedBlockIndices(new Set());
			setTool(null);
			setSelectedAnnotation(null);
			setTempBlur(null);
			setScrollCapturing(false);
			setScrollFrames(0);
			setLockedByOther(false);
		});
		return () => { unlistenClear.then((fn) => fn()); };
	}, []);

	// Scroll panel emits this when its Done/Cancel cleanup runs. Same reset path —
	// it's what guarantees the overlay window is in a clean state for the NEXT
	// capture, even if no shortcut is pressed in between.
	useEffect(() => {
		const unlistenDone = listen("scroll-capture-done", () => {
			resetState();
		});
		return () => { unlistenDone.then((fn) => fn()); };
	}, [resetState]);

	useEffect(() => {
		const unlisten = listen<{
			displays: DisplayCapture[];
			monitors: MonitorInfo[];
		}>("screenshot-ready", (event) => {
			const { displays, monitors: mons } = event.payload;
			setDisplayCaptures(displays);
			setMonitors(mons || []);
			if (displays.length > 0) {
				setImgDims({ w: displays[0].width, h: displays[0].height });
			}
			setStage("selecting");
			setSelection(null);
			setAnnotations([]);
			setTextBlocks([]);
			setSelectedText("");
			setSelectedBlockIndices(new Set());
			setTool(null);
			setSelectedAnnotation(null);
			setTempBlur(null);
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// Click Scroll icon on toolbar → enter scroll-ready mode (show Start/Cancel)
	const handleStartScroll = useCallback(async () => {
		if (!selection) return;
		const dc = findDisplay();
		if (!dc) return;
		const monitorIdx = getWindowMonitorIndex();
		const screenX = selection.x + monitors[monitorIdx].x;
		const screenY = selection.y + monitors[monitorIdx].y;
		const screenW = selection.width;
		const screenH = selection.height;
		setScrollCapturing(true);
		setScrollFrames(0);
		setTool(null);
		try {
			await invoke("prepare_scroll_capture", {
				x: screenX,
				y: screenY,
				width: screenW,
				height: screenH,
			});
		} catch (e) {
			console.error("[scroll] prepare failed:", e);
			setScrollCapturing(false);
		}
	}, [selection, findDisplay, monitors]);

	// Click Start button → hide overlay, show border + panel, kick off AUTO-SCROLL.
	//
	// Auto-scroll path means: Rust dispatches CGScrollEvents to the window under
	// the cursor and pastes captured frames at KNOWN offsets (no NCC needed).
	// We must position the cursor over the capture region so scroll events land
	// in the right window — that's the `cursor_anchor_*` payload.
	const handleScrollBegin = useCallback(async () => {
		if (!selection) return;
		try {
			const monitorIdx = getWindowMonitorIndex();
			const mon = monitors[monitorIdx];
			const monX = mon?.x ?? 0;
			const monY = mon?.y ?? 0;
			// SCREEN-space (logical-screen) coords. Two windows need to know
			// about these: the scroll-border (so it draws on the right monitor)
			// and the cursor warp (so scroll events land in the right app).
			//
			// Previously we passed selection.x/y (LOCAL to the overlay window)
			// to show_scroll_border, which then treated those as screen coords
			// — fine on the primary monitor (offset 0,0), broken on monitor 2
			// (the border ended up on monitor 1 at the wrong place).
			const screenX = monX + selection.x;
			const screenY = monY + selection.y;
			const anchorX = screenX + selection.width / 2;
			const anchorY = screenY + selection.height / 2;

			await invoke("hide_overlay");
			await invoke("show_scroll_border", {
				x: screenX,
				y: screenY,
				width: selection.width,
				height: selection.height,
			});
			await invoke("show_scroll_panel", {
				anchorMonitorX: monX,
				anchorMonitorY: monY,
			});
			await invoke("start_auto_scroll_capture", {
				cursorAnchorX: anchorX,
				cursorAnchorY: anchorY,
				speedPps: scrollSpeedPps,
				maxHeight: 20000,
			});
		} catch (e) {
			console.error("[scroll] auto-start failed:", e);
			setScrollCapturing(false);
		}
	}, [selection, monitors, scrollSpeedPps]);

	// Cancel scroll (before or during capture)
	const handleScrollCancel = useCallback(async () => {
		// Teardown order matters:
		//   1. Stop the auto-scroll capture thread (if running).
		//   2. Hide the per-session panel/border windows.
		//   3. Hand off to cancelCapture() — this is what Esc does after
		//      shortcut. It emits cancel-capture (so other overlay windows
		//      reset), resets React state, AND hides the main overlay. Without
		//      step 3 the user was left with the dimmed selection overlay still
		//      visible — same bug they reported as "Cancel doesn't exit like Esc".
		try { await invoke("cancel_scroll_capture"); } catch (e) { console.error(e); }
		try { await invoke("hide_scroll_panel"); } catch (e) { console.error(e); }
		try { await invoke("hide_scroll_border"); } catch (e) { console.error(e); }
		setScrollCapturing(false);
		await cancelCapture();
	}, [cancelCapture]);

	// Finalize an in-progress scroll capture: stitch whatever's been collected
	// so far, copy the result to the clipboard, and tear down the windows.
	//
	// This is what Esc does mid-scroll — the user's mental model is "I've seen
	// enough, give me the image now" rather than "throw it away". The discard
	// path (handleScrollCancel) stays bound to the Cancel button and to Esc
	// while the panel is still in its pre-Start ready state.
	const handleScrollFinalize = useCallback(async () => {
		try {
			const result = await invoke<{ width: number; height: number } | null>(
				"finalize_scroll_to_clipboard",
			);
			if (result) {
				new Notification("iShot", {
					body: `Scroll capture saved (${result.width}x${result.height})`,
				});
			}
		} catch (e) {
			console.error("[scroll] finalize failed:", e);
		}
		try { await invoke("hide_scroll_panel"); } catch (e) { console.error(e); }
		try { await invoke("hide_scroll_border"); } catch (e) { console.error(e); }
		setScrollCapturing(false);
		await cancelCapture();
	}, [cancelCapture]);

	// Listen for cancel from any overlay window
	useEffect(() => {
		const unlisten = listen("cancel-capture", () => {
			resetState();
			setLockedByOther(false);
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, [resetState]);

	// Auto-stop / auto-finalize event from backend.
	//
	// NOTE: with the auto-scroll path, Rust copies the RGBA directly to the
	// clipboard before emitting this event — `payload.data` will be empty.
	// Don't re-copy here (empty array is JS-truthy, would cause "0 bytes"
	// noise in logs). Only show notification + clean up windows.
	useEffect(() => {
		const unlisten = listen("scroll-capture-result", async (event) => {
			const payload = event.payload as {
				data: number[];
				width: number;
				height: number;
			};
			// Only re-copy from JS if Rust didn't already handle it (legacy
			// manual-scroll path). Length check is what distinguishes — auto
			// path sends `data: []`, legacy sends a full PNG byte array.
			if (payload.data && payload.data.length > 0) {
				await invoke("copy_to_clipboard", { imageBytes: payload.data });
			}
			if (payload.width && payload.height) {
				new Notification("iShot", {
					body: `Scroll capture saved (${payload.width}x${payload.height})`,
				});
			}
			setScrollCapturing(false);
			await invoke("hide_scroll_panel").catch(() => {});
			await invoke("hide_scroll_border").catch(() => {});
			resetState();
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, [resetState]);

	// Scroll capture error
	useEffect(() => {
		const unlisten = listen("scroll-capture-error", async (event) => {
			console.error("[scroll] capture error:", event.payload);
			setScrollCapturing(false);
			resetState();
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, [resetState]);

	// Scroll capture progress (thumbnail + frame count)
	useEffect(() => {
		const unlisten = listen("scroll-capture-progress", (event) => {
			const p = event.payload as {
				frame_count: number;
				current_height: number;
				thumbnail?: string;
			};
			setScrollFrames(p.frame_count);
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// When another window enters editing, lock this window
	useEffect(() => {
		const unlisten = listen<{ label: string }>("selection-locked", (event) => {
			if (event.payload.label !== getCurrentWindow().label) {
				setLockedByOther(true);
			}
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	useEffect(() => {
		const handleKeyDown = async (e: KeyboardEvent) => {
			if (e.key === "Shift") setShiftHeld(true);
			if (editingTextId !== null) return; // Don't intercept when typing in textbox
			if ((e.metaKey || e.ctrlKey) && e.key === "z") {
				e.preventDefault();
				handleUndo();
				return;
			}
			if (e.key === "Escape") {
				if (scrollCapturing) {
					// scrollFrames > 0 means the user has already pressed Start and the
					// capture loop has stitched at least one step — Esc here means
					// "save what we have" (finalize → clipboard), not throw it away.
					// Before Start (panel still in its ready state, frame count 0),
					// Esc keeps its previous meaning of cancel.
					if (scrollFrames > 0) {
						handleScrollFinalize();
					} else {
						handleScrollCancel();
					}
					return;
				}
				cancelCapture();
			} else if ((e.metaKey || e.ctrlKey) && e.key === "c" && selectedText) {
				e.preventDefault();
				await invoke("copy_text_to_clipboard", { text: selectedText });
				cancelCapture();
			} else if (
				(e.key === "Backspace" || e.key === "Delete") &&
				selectedAnnotation !== null
			) {
				e.preventDefault();
				deleteSelectedAnnotation();
			}
		};
		const handleKeyUp = (e: KeyboardEvent) => {
			if (e.key === "Shift") setShiftHeld(false);
		};
		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("keyup", handleKeyUp);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("keyup", handleKeyUp);
		};
	}, [
		cancelCapture,
		selectedText,
		selectedAnnotation,
		deleteSelectedAnnotation,
		editingTextId,
		handleUndo,
		scrollCapturing,
		scrollFrames,
		handleScrollCancel,
		handleScrollFinalize,
	]);

	useEffect(() => {
		if (stage === "editing" && selection && canvasRef.current) {
			canvasRef.current.width = selection.width;
			canvasRef.current.height = selection.height;
		}
	}, [stage, selection]);

	const redrawAnnotations = useCallback(() => {
		const canvas = canvasRef.current;
		if (!canvas || !selection) return;
		const ctx = canvas.getContext("2d")!;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";

		for (const ann of annotations) {
			if (ann.type === "blur" || ann.type === "textbox") continue; // textbox rendered as HTML overlay
			const isSelected = ann.id === selectedAnnotation;
			ctx.strokeStyle = isSelected ? "#007aff" : ann.color || "#ff0000";
			ctx.lineWidth = isSelected
				? (ann.strokeWidth || 2) + 1
				: ann.strokeWidth || 2;

			if (ann.type === "rect" && ann.w !== undefined) {
				ctx.strokeRect(ann.x, ann.y, ann.w, ann.h!);
			} else if (ann.type === "oval" && ann.w !== undefined) {
				ctx.beginPath();
				ctx.ellipse(
					ann.x + ann.w / 2,
					ann.y + ann.h! / 2,
					Math.abs(ann.w / 2),
					Math.abs(ann.h! / 2),
					0,
					0,
					Math.PI * 2,
				);
				ctx.stroke();
			} else if (ann.type === "arrow" && ann.ex !== undefined) {
				const headLen = 12,
					angle = Math.atan2(ann.ey! - ann.y, ann.ex - ann.x);
				ctx.beginPath();
				ctx.moveTo(ann.x, ann.y);
				ctx.lineTo(ann.ex, ann.ey!);
				ctx.stroke();
				ctx.beginPath();
				ctx.moveTo(ann.ex, ann.ey!);
				ctx.lineTo(
					ann.ex - headLen * Math.cos(angle - Math.PI / 6),
					ann.ey! - headLen * Math.sin(angle - Math.PI / 6),
				);
				ctx.moveTo(ann.ex, ann.ey!);
				ctx.lineTo(
					ann.ex - headLen * Math.cos(angle + Math.PI / 6),
					ann.ey! - headLen * Math.sin(angle + Math.PI / 6),
				);
				ctx.stroke();
			} else if (ann.type === "line" && ann.ex !== undefined) {
				ctx.beginPath();
				ctx.moveTo(ann.x, ann.y);
				ctx.lineTo(ann.ex, ann.ey!);
				ctx.stroke();
			} else if (ann.type === "draw" && ann.path && ann.path.length > 1) {
				ctx.beginPath();
				ctx.moveTo(ann.path[0].x, ann.path[0].y);
				for (let i = 1; i < ann.path.length; i++)
					ctx.lineTo(ann.path[i].x, ann.path[i].y);
				ctx.stroke();
			}
		}
	}, [annotations, selection, selectedAnnotation]);

	useEffect(() => {
		if (stage === "editing") redrawAnnotations();
	}, [annotations, stage, redrawAnnotations, selectedAnnotation]);

	const handleMouseDown = (e: React.MouseEvent) => {
		if (stage === "selecting") {
			e.preventDefault();
			setIsDragging(true);
			dragStartRef.current = { x: e.clientX, y: e.clientY };
			setSelection(null);
		}
	};

	const handleMouseMove = (e: React.MouseEvent) => {
		if (stage === "selecting" && isDragging && dragStartRef.current) {
			e.preventDefault();
			const start = dragStartRef.current;
			setSelection({
				x: Math.min(start.x, e.clientX),
				y: Math.min(start.y, e.clientY),
				width: Math.abs(e.clientX - start.x),
				height: Math.abs(e.clientY - start.y),
			});
		}
	};

	const handleMouseUp = () => {
		if (stage === "selecting" && isDragging) {
			setIsDragging(false);
			dragStartRef.current = null;
			if (selection && selection.width > 10 && selection.height > 10) {
				setStage("editing");
				setTool(null);
				emit("selection-locked", { label: getCurrentWindow().label });
			} else setSelection(null);
		}
	};

	const isPointInAnnotation = (
		ann: Annotation,
		x: number,
		y: number,
	): boolean => {
		const tol = 12;
		if (ann.type === "blur" && ann.w !== undefined) {
			const minX = Math.min(ann.x, ann.x + ann.w),
				maxX = Math.max(ann.x, ann.x + ann.w);
			const minY = Math.min(ann.y, ann.y + ann.h!),
				maxY = Math.max(ann.y, ann.y + ann.h!);
			return x >= minX && x <= maxX && y >= minY && y <= maxY;
		}
		if (ann.type === "rect" && ann.w !== undefined) {
			const minX = Math.min(ann.x, ann.x + ann.w),
				maxX = Math.max(ann.x, ann.x + ann.w);
			const minY = Math.min(ann.y, ann.y + ann.h!),
				maxY = Math.max(ann.y, ann.y + ann.h!);
			return (
				((Math.abs(x - minX) < tol || Math.abs(x - maxX) < tol) &&
					y >= minY - tol &&
					y <= maxY + tol) ||
				((Math.abs(y - minY) < tol || Math.abs(y - maxY) < tol) &&
					x >= minX - tol &&
					x <= maxX + tol)
			);
		}
		if (ann.type === "oval" && ann.w !== undefined) {
			const cx = ann.x + ann.w / 2,
				cy = ann.y + ann.h! / 2;
			const rx = Math.abs(ann.w / 2),
				ry = Math.abs(ann.h! / 2);
			if (rx < 5 || ry < 5) return false;
			const dist = Math.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2);
			return Math.abs(dist - 1) < 0.4;
		}
		if ((ann.type === "arrow" || ann.type === "line") && ann.ex !== undefined) {
			const A = x - ann.x,
				B = y - ann.y,
				C = ann.ex - ann.x,
				D = ann.ey! - ann.y;
			const lenSq = C * C + D * D;
			if (lenSq === 0) return Math.sqrt(A * A + B * B) < tol;
			const t = Math.max(0, Math.min(1, (A * C + B * D) / lenSq));
			const px = ann.x + t * C,
				py = ann.y + t * D;
			return Math.sqrt((x - px) ** 2 + (y - py) ** 2) < tol;
		}
		if (ann.type === "draw" && ann.path) {
			for (const p of ann.path)
				if (Math.sqrt((p.x - x) ** 2 + (p.y - y) ** 2) < tol) return true;
		}
		return false;
	};

	const rectsIntersect = (r1: Region, r2: Region): boolean => {
		return !(
			r2.x > r1.x + r1.width ||
			r2.x + r2.width < r1.x ||
			r2.y > r1.y + r1.height ||
			r2.y + r2.height < r1.y
		);
	};

	// Text selection
	const handleTextMouseDown = (e: React.MouseEvent) => {
		if (tool !== "text" || !selection) return;
		e.preventDefault();
		e.stopPropagation();
		const rect = e.currentTarget.getBoundingClientRect();
		setIsSelectingText(true);
		textSelectionStart.current = {
			x: e.clientX - rect.left,
			y: e.clientY - rect.top,
		};
		textSelectionRect.current = {
			x: e.clientX - rect.left,
			y: e.clientY - rect.top,
			width: 0,
			height: 0,
		};
		setSelectedBlockIndices(new Set());
		setSelectedText("");
	};

	const handleTextMouseMove = (e: React.MouseEvent) => {
		if (!isSelectingText || !textSelectionStart.current || !selection) return;
		e.preventDefault();
		const rect = e.currentTarget.getBoundingClientRect();
		const x = e.clientX - rect.left,
			y = e.clientY - rect.top;
		const start = textSelectionStart.current;
		const selRect: Region = {
			x: Math.min(start.x, x),
			y: Math.min(start.y, y),
			width: Math.abs(x - start.x),
			height: Math.abs(y - start.y),
		};
		textSelectionRect.current = selRect;
		const selectedIndices = new Set<number>();
		textBlocks.forEach((block, idx) => {
			if (
				rectsIntersect(selRect, {
					x: block.x,
					y: block.y,
					width: block.width,
					height: block.height,
				})
			)
				selectedIndices.add(idx);
		});
		setSelectedBlockIndices(selectedIndices);
		const selectedBlocks = textBlocks
			.map((b, i) => ({ ...b, idx: i }))
			.filter((b) => selectedIndices.has(b.idx))
			.sort((a, b) => (Math.abs(a.y - b.y) < 10 ? a.x - b.x : a.y - b.y));
		const lines: string[][] = [];
		let currentLine: string[] = [];
		let lastY = -1000;
		for (const block of selectedBlocks) {
			if (lastY === -1000 || Math.abs(block.y - lastY) < 10)
				currentLine.push(block.text);
			else {
				if (currentLine.length > 0) lines.push(currentLine);
				currentLine = [block.text];
			}
			lastY = block.y;
		}
		if (currentLine.length > 0) lines.push(currentLine);
		setSelectedText(lines.map((l) => l.join(" ")).join("\n"));
	};

	const handleTextMouseUp = () => {
		setIsSelectingText(false);
		textSelectionStart.current = null;
		textSelectionRect.current = null;
	};

	// Canvas handlers
	const handleCanvasMouseDown = (e: React.MouseEvent) => {
		if (stage !== "editing" || !selection) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const x = e.clientX - rect.left,
			y = e.clientY - rect.top;

		// If no tool selected, try to select annotation
		if (!tool) {
			for (let i = annotations.length - 1; i >= 0; i--) {
				if (isPointInAnnotation(annotations[i], x, y)) {
					setSelectedAnnotation(annotations[i].id);
					return;
				}
			}
			setSelectedAnnotation(null);
			return;
		}

		setSelectedAnnotation(null);
		setIsDrawing(true);
		setDrawStart({ x, y });

		if (tool === "draw") setCurrentPath([{ x, y }]);
		else if (tool === "blur" || tool === "textbox")
			setTempBlur({ x, y, width: 0, height: 0 });
	};

	// Constrain point with Shift: snap to 45° angles for line/arrow, square for rect, circle for oval
	const constrainPoint = useCallback(
		(
			sx: number,
			sy: number,
			ex: number,
			ey: number,
			toolType: string,
		): { x: number; y: number } => {
			if (!shiftHeld) return { x: ex, y: ey };
			const dx = ex - sx,
				dy = ey - sy;
			if (
				toolType === "rect" ||
				toolType === "oval" ||
				toolType === "blur" ||
				toolType === "textbox"
			) {
				const size = Math.max(Math.abs(dx), Math.abs(dy));
				return {
					x: sx + size * Math.sign(dx || 1),
					y: sy + size * Math.sign(dy || 1),
				};
			}
			if (toolType === "line" || toolType === "arrow") {
				const angle = Math.atan2(dy, dx);
				const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
				const dist = Math.sqrt(dx * dx + dy * dy);
				return {
					x: sx + dist * Math.cos(snapped),
					y: sy + dist * Math.sin(snapped),
				};
			}
			return { x: ex, y: ey };
		},
		[shiftHeld],
	);

	const handleCanvasMouseMove = (e: React.MouseEvent) => {
		if (!isDrawing || !drawStart || !tool) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const rawX = e.clientX - rect.left,
			rawY = e.clientY - rect.top;
		const { x, y } = constrainPoint(drawStart.x, drawStart.y, rawX, rawY, tool);

		if (tool === "blur" || tool === "textbox") {
			setTempBlur({
				x: Math.min(drawStart.x, x),
				y: Math.min(drawStart.y, y),
				width: Math.abs(x - drawStart.x),
				height: Math.abs(y - drawStart.y),
			});
			return;
		}

		if (tool === "draw")
			setCurrentPath((prev) => [...prev, { x: rawX, y: rawY }]);

		redrawAnnotations();
		const ctx = canvasRef.current!.getContext("2d")!;
		ctx.strokeStyle = strokeColor;
		ctx.lineWidth = strokeWidth;
		ctx.lineCap = "round";

		if (tool === "rect")
			ctx.strokeRect(
				drawStart.x,
				drawStart.y,
				x - drawStart.x,
				y - drawStart.y,
			);
		else if (tool === "oval") {
			ctx.beginPath();
			ctx.ellipse(
				(drawStart.x + x) / 2,
				(drawStart.y + y) / 2,
				Math.abs(x - drawStart.x) / 2,
				Math.abs(y - drawStart.y) / 2,
				0,
				0,
				Math.PI * 2,
			);
			ctx.stroke();
		} else if (tool === "arrow") {
			const headLen = 12,
				angle = Math.atan2(y - drawStart.y, x - drawStart.x);
			ctx.beginPath();
			ctx.moveTo(drawStart.x, drawStart.y);
			ctx.lineTo(x, y);
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(x, y);
			ctx.lineTo(
				x - headLen * Math.cos(angle - Math.PI / 6),
				y - headLen * Math.sin(angle - Math.PI / 6),
			);
			ctx.moveTo(x, y);
			ctx.lineTo(
				x - headLen * Math.cos(angle + Math.PI / 6),
				y - headLen * Math.sin(angle + Math.PI / 6),
			);
			ctx.stroke();
		} else if (tool === "line") {
			ctx.beginPath();
			ctx.moveTo(drawStart.x, drawStart.y);
			ctx.lineTo(x, y);
			ctx.stroke();
		} else if (tool === "draw" && currentPath.length > 0) {
			ctx.beginPath();
			ctx.moveTo(currentPath[0].x, currentPath[0].y);
			for (const p of currentPath) ctx.lineTo(p.x, p.y);
			ctx.lineTo(rawX, rawY);
			ctx.stroke();
		}
	};

	const handleCanvasMouseUp = (e: React.MouseEvent) => {
		if (!isDrawing || !drawStart || !tool) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const rawX = e.clientX - rect.left,
			rawY = e.clientY - rect.top;
		const { x, y } = constrainPoint(drawStart.x, drawStart.y, rawX, rawY, tool);
		const id = ++annotationId;

		if (tool === "rect")
			setAnnotations((prev) => [
				...prev,
				{
					id,
					type: "rect",
					x: drawStart.x,
					y: drawStart.y,
					w: x - drawStart.x,
					h: y - drawStart.y,
					color: strokeColor,
					strokeWidth,
				},
			]);
		else if (tool === "oval")
			setAnnotations((prev) => [
				...prev,
				{
					id,
					type: "oval",
					x: drawStart.x,
					y: drawStart.y,
					w: x - drawStart.x,
					h: y - drawStart.y,
					color: strokeColor,
					strokeWidth,
				},
			]);
		else if (tool === "arrow")
			setAnnotations((prev) => [
				...prev,
				{
					id,
					type: "arrow",
					x: drawStart.x,
					y: drawStart.y,
					ex: x,
					ey: y,
					color: strokeColor,
					strokeWidth,
				},
			]);
		else if (tool === "line")
			setAnnotations((prev) => [
				...prev,
				{
					id,
					type: "line",
					x: drawStart.x,
					y: drawStart.y,
					ex: x,
					ey: y,
					color: strokeColor,
					strokeWidth,
				},
			]);
		else if (tool === "draw")
			setAnnotations((prev) => [
				...prev,
				{
					id,
					type: "draw",
					x: 0,
					y: 0,
					path: [...currentPath, { x: rawX, y: rawY }],
					color: strokeColor,
					strokeWidth,
				},
			]);
		else if (
			tool === "blur" &&
			tempBlur &&
			tempBlur.width > 5 &&
			tempBlur.height > 5
		) {
			setAnnotations((prev) => [
				...prev,
				{
					id,
					type: "blur",
					x: tempBlur.x,
					y: tempBlur.y,
					w: tempBlur.width,
					h: tempBlur.height,
					blurStrength,
				},
			]);
		} else if (
			tool === "textbox" &&
			tempBlur &&
			tempBlur.width > 20 &&
			tempBlur.height > 15
		) {
			setAnnotations((prev) => [
				...prev,
				{
					id,
					type: "textbox",
					x: tempBlur.x,
					y: tempBlur.y,
					w: tempBlur.width,
					h: tempBlur.height,
					color: strokeColor,
					text: "",
					fontSize,
					bold: fontBold,
					underline: fontUnderline,
				},
			]);
			setEditingTextId(id);
		}

		if (tool !== "textbox") setTool(null);
		setIsDrawing(false);
		setDrawStart(null);
		setCurrentPath([]);
		setTempBlur(null);
	};

	const selectedBlurAnn =
		selectedAnnotation !== null
			? annotations.find(
					(a) => a.id === selectedAnnotation && a.type === "blur",
				)
			: null;

	const updateBlurStrength = (strength: number) => {
		setBlurStrength(strength);
		if (selectedAnnotation !== null) {
			setAnnotations((prev) =>
				prev.map((a) =>
					a.id === selectedAnnotation ? { ...a, blurStrength: strength } : a,
				),
			);
		}
	};

	if (stage === "idle")
		return (
			<div
				style={{ width: "100vw", height: "100vh", background: "transparent" }}
			/>
		);

	const myMonitorIndex = getWindowMonitorIndex();

	// Locked by another window — just show screenshot + dim, no interaction
	if (lockedByOther) {
		const dc = displayCaptures[myMonitorIndex];
		return (
			<div
				style={{
					position: "fixed",
					top: 0,
					left: 0,
					width: "100vw",
					height: "100vh",
				}}
			>
				{dc && (
					<img
						src={`data:image/png;base64,${dc.data}`}
						alt=""
						style={{
							position: "absolute",
							top: 0,
							left: 0,
							width: "100%",
							height: "100%",
							objectFit: "fill",
							pointerEvents: "none",
						}}
					/>
				)}
				<div
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						width: "100%",
						height: "100%",
						background: "rgba(0,0,0,0.5)",
						pointerEvents: "none",
					}}
				/>
			</div>
		);
	}
	const scale =
		monitors[myMonitorIndex]?.scale_factor ||
		(imgDims.w > 0 ? imgDims.w / window.innerWidth : 2);

	const getHintText = () => {
		if (selectedAnnotation !== null) return "Press ⌫ to delete";
		if (tool === "text" && !ocrLoading) {
			if (selectedText) return "⌘C to copy";
			if (textBlocks.length > 0) return "Drag to select text, then ⌘C to copy";
		}
		return null;
	};

	return (
		<div
			style={{
				position: "fixed",
				top: 0,
				left: 0,
				width: "100vw",
				height: "100vh",
				cursor:
					stage === "selecting" ? "crosshair" : tool ? "crosshair" : "default",
				userSelect: "none",
				overflow: "hidden",
			}}
			onMouseDown={handleMouseDown}
			onMouseMove={handleMouseMove}
			onMouseUp={handleMouseUp}
		>
			{/* Render this monitor's screenshot filling the viewport */}
			{showScreenshot && displayCaptures[myMonitorIndex] && (
				<img
					src={`data:image/png;base64,${displayCaptures[myMonitorIndex].data}`}
					alt=""
					style={{
						position: "absolute",
						left: 0,
						top: 0,
						width: "100%",
						height: "100%",
						objectFit: "fill",
						pointerEvents: "none",
					}}
				/>
			)}

			{stage === "selecting" && !selection && (
				<div
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						width: "100vw",
						height: "100vh",
						background: "rgba(0,0,0,0.3)",
						pointerEvents: "none",
					}}
				/>
			)}

			{/* Dark overlay with clip — also shown in scroll-ready state so the user sees
			    exactly what's about to be captured. Once active scroll begins, the overlay
			    window is hidden by Rust (replaced by the scroll-border dim window). */}
			{selection && selection.width > 0 && (
				<div
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						width: "100vw",
						height: "100vh",
						background: "rgba(0,0,0,0.5)",
						pointerEvents: "none",
						clipPath: `polygon(0% 0%, 0% 100%, ${selection.x}px 100%, ${selection.x}px ${selection.y}px, ${selection.x + selection.width}px ${selection.y}px, ${selection.x + selection.width}px ${selection.y + selection.height}px, ${selection.x}px ${selection.y + selection.height}px, ${selection.x}px 100%, 100% 100%, 100% 0%)`,
					}}
				/>
			)}

			{/* Selection border - always show during scroll */}
			{selection && selection.width > 0 && (
				<>
					<div
						style={{
							position: "absolute",
							left: selection.x,
							top: selection.y,
							width: selection.width,
							height: selection.height,
							border: "1px solid #fff",
							boxShadow: "0 0 0 1px rgba(0,0,0,0.3)",
							pointerEvents: "none",
						}}
					/>
					<div
						style={{
							position: "absolute",
							left: selection.x,
							top: selection.y - 20,
							background: "rgba(0,0,0,0.7)",
							color: "#fff",
							padding: "1px 5px",
							borderRadius: 2,
							fontSize: 11,
							pointerEvents: "none",
						}}
					>
						{Math.round(selection.width * scale)} ×{" "}
						{Math.round(selection.height * scale)}
					</div>
				</>
			)}

			{stage === "editing" && selection && (
				<>
					{/* Blur regions */}
					{annotations
						.filter((a) => a.type === "blur")
						.map((ann) => (
							<div
								key={ann.id}
								onClick={() => setSelectedAnnotation(ann.id)}
								style={{
									position: "absolute",
									left: selection.x + Math.min(ann.x, ann.x + (ann.w || 0)),
									top: selection.y + Math.min(ann.y, ann.y + (ann.h || 0)),
									width: Math.abs(ann.w || 0),
									height: Math.abs(ann.h || 0),
									backdropFilter: `blur(${ann.blurStrength || 10}px)`,
									WebkitBackdropFilter: `blur(${ann.blurStrength || 10}px)`,
									border:
										ann.id === selectedAnnotation
											? "2px solid #007aff"
											: "none",
									cursor: "pointer",
									zIndex: 4,
								}}
							/>
						))}

					{/* Textbox annotations */}
					{annotations
						.filter((a) => a.type === "textbox")
						.map((ann) => (
							<div
								key={ann.id}
								onClick={() => {
									setSelectedAnnotation(ann.id);
									setEditingTextId(ann.id);
								}}
								style={{
									position: "absolute",
									left: selection.x + ann.x,
									top: selection.y + ann.y,
									width: ann.w,
									height: ann.h,
									zIndex: 10,
									border:
										ann.id === selectedAnnotation
											? "2px solid #007aff"
											: "2px solid rgba(0,122,255,0.7)",
								}}
							>
								<textarea
									value={ann.text || ""}
									placeholder="Type here..."
									ref={(el) => {
										if (el && ann.id === editingTextId) el.focus();
									}}
									onChange={(e) =>
										setAnnotations((prev) =>
											prev.map((a) =>
												a.id === ann.id ? { ...a, text: e.target.value } : a,
											),
										)
									}
									onFocus={() => setEditingTextId(ann.id)}
									onBlur={() => {
										setEditingTextId(null);
										// Remove empty textbox on blur
										if (!ann.text?.trim())
											setAnnotations((prev) =>
												prev.filter((a) => a.id !== ann.id),
											);
									}}
									style={{
										width: "100%",
										height: "100%",
										background: "transparent",
										border: "none",
										outline: "none",
										color: ann.color || "#ff0000",
										fontSize: ann.fontSize || 16,
										fontFamily: "sans-serif",
										fontWeight: ann.bold ? "bold" : "normal",
										textDecoration: ann.underline ? "underline" : "none",
										resize: "none",
										padding: 2,
										lineHeight: 1.3,
										caretColor: ann.color || "#ff0000",
									}}
								/>
							</div>
						))}

					{/* Temp blur/textbox while drawing */}
					{tempBlur && tempBlur.width > 0 && tool === "blur" && (
						<div
							style={{
								position: "absolute",
								left: selection.x + tempBlur.x,
								top: selection.y + tempBlur.y,
								width: tempBlur.width,
								height: tempBlur.height,
								backdropFilter: `blur(${blurStrength}px)`,
								WebkitBackdropFilter: `blur(${blurStrength}px)`,
								border: "1px dashed #007aff",
								pointerEvents: "none",
								zIndex: 4,
							}}
						/>
					)}
					{tempBlur && tempBlur.width > 0 && tool === "textbox" && (
						<div
							style={{
								position: "absolute",
								left: selection.x + tempBlur.x,
								top: selection.y + tempBlur.y,
								width: tempBlur.width,
								height: tempBlur.height,
								border: "2px solid rgba(0,122,255,0.7)",
								pointerEvents: "none",
								zIndex: 4,
							}}
						/>
					)}

					{/* Text selection layer */}
					{tool === "text" && (
						<div
							style={{
								position: "absolute",
								left: selection.x,
								top: selection.y,
								width: selection.width,
								height: selection.height,
								cursor: "text",
								zIndex: 15,
							}}
							onMouseDown={handleTextMouseDown}
							onMouseMove={handleTextMouseMove}
							onMouseUp={handleTextMouseUp}
						>
							{textBlocks.map((block, idx) => (
								<div
									key={idx}
									style={{
										position: "absolute",
										left: block.x,
										top: block.y,
										width: block.width,
										height: block.height,
										background: selectedBlockIndices.has(idx)
											? "rgba(0, 122, 255, 0.4)"
											: "rgba(255, 255, 0, 0.15)",
										border: selectedBlockIndices.has(idx)
											? "1px solid rgba(0, 122, 255, 0.8)"
											: "1px dashed rgba(0, 122, 255, 0.3)",
										borderRadius: 2,
										pointerEvents: "none",
									}}
								/>
							))}
							{isSelectingText &&
								textSelectionRect.current &&
								textSelectionRect.current.width > 0 && (
									<div
										style={{
											position: "absolute",
											left: textSelectionRect.current.x,
											top: textSelectionRect.current.y,
											width: textSelectionRect.current.width,
											height: textSelectionRect.current.height,
											border: "1px dashed #007aff",
											background: "rgba(0, 122, 255, 0.1)",
											pointerEvents: "none",
										}}
									/>
								)}
						</div>
					)}

					{/* Annotation canvas */}
					<canvas
						ref={canvasRef}
						style={{
							position: "absolute",
							left: selection.x,
							top: selection.y,
							width: selection.width,
							height: selection.height,
							pointerEvents: tool !== "text" ? "auto" : "none",
							cursor: tool ? "crosshair" : "default",
							zIndex: 10,
						}}
						onMouseDown={handleCanvasMouseDown}
						onMouseMove={handleCanvasMouseMove}
						onMouseUp={handleCanvasMouseUp}
					/>


					{/* Toolbars — flip above if no space below.
					    Row 1 always shows tool buttons.
					    Row 2 shows tool-specific options (color/size/etc.) OR the
					    scroll-shot speed selector + Start/Cancel when the user
					    has clicked the scroll-capture icon.
					    Critically: the main toolbar stays visible in scroll-shot
					    "ready" state so the user doesn't lose context — the speed
					    selector simply takes the place of the regular options row. */}
					{(() => {
							const FONT_SIZES = [
								10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48,
							];
							const inScrollReady = scrollCapturing && scrollFrames === 0;
							const hasRow2 =
								inScrollReady ||
								tool === "rect" ||
								tool === "oval" ||
								tool === "arrow" ||
								tool === "line" ||
								tool === "draw" ||
								tool === "textbox" ||
								tool === "blur" ||
								!!selectedBlurAnn;
							const row1H = 42,
								row2H = 36,
								gap = 4;
							const totalH = row1H + (hasRow2 ? row2H + gap : 0);
							const spaceBelow =
								window.innerHeight - (selection.y + selection.height);
							const showAbove = spaceBelow < totalH + 16;
							const baseTop = showAbove
								? selection.y - totalH - 8
								: selection.y + selection.height + 8;
							const row1Top = Math.max(4, baseTop);
							const row2Top = row1Top + row1H + gap;
							const toolbarLeft = Math.max(
								4,
								Math.min(
									selection.x + selection.width / 2 - 210,
									window.innerWidth - 460,
								),
							);
							const isDrawTool =
								tool === "rect" ||
								tool === "oval" ||
								tool === "arrow" ||
								tool === "line" ||
								tool === "draw" ||
								tool === "textbox";
							const isShapeTool =
								tool === "rect" ||
								tool === "oval" ||
								tool === "arrow" ||
								tool === "line" ||
								tool === "draw";
							const barStyle = {
								position: "absolute" as const,
								left: toolbarLeft,
								background: "rgba(255,255,255,0.95)",
								borderRadius: 8,
								padding: "5px 6px",
								display: "flex",
								gap: 3,
								alignItems: "center" as const,
								boxShadow: "0 2px 12px rgba(0,0,0,0.25)",
								zIndex: 100,
							};
							return (
								<>
									{/* Row 1: Tools + actions */}
									<div style={{ ...barStyle, top: row1Top }}>
										<ToolBtn
											active={tool === "rect"}
											onClick={() => handleToolChange("rect")}
											title="Rectangle"
										>
											<Square size={18} />
										</ToolBtn>
										<ToolBtn
											active={tool === "oval"}
											onClick={() => handleToolChange("oval")}
											title="Oval"
										>
											<Circle size={18} />
										</ToolBtn>
										<ToolBtn
											active={tool === "arrow"}
											onClick={() => handleToolChange("arrow")}
											title="Arrow"
										>
											<ArrowRight size={18} />
										</ToolBtn>
										<ToolBtn
											active={tool === "line"}
											onClick={() => handleToolChange("line")}
											title="Line"
										>
											<Minus size={18} />
										</ToolBtn>
										<ToolBtn
											active={tool === "draw"}
											onClick={() => handleToolChange("draw")}
											title="Draw"
										>
											<Pencil size={18} />
										</ToolBtn>
										<ToolBtn
											active={tool === "textbox"}
											onClick={() => handleToolChange("textbox")}
											title="Text"
										>
											<Type size={18} />
										</ToolBtn>
										<ToolBtn
											active={tool === "blur"}
											onClick={() => handleToolChange("blur")}
											title="Blur"
										>
											<Grid3X3 size={18} />
										</ToolBtn>
										<ToolBtn
											active={tool === "text"}
											onClick={() => handleToolChange("text")}
											title="OCR"
										>
											{ocrLoading ? (
												<span style={{ fontSize: 11 }}>...</span>
											) : (
												<ScanText size={18} />
											)}
										</ToolBtn>
										<ToolBtn
											active={inScrollReady}
											onClick={handleStartScroll}
											title="Scroll capture"
										>
											<ImageDown size={18} />
										</ToolBtn>
										<ToolBtn
											onClick={handleTranslate}
											title="Translate selection"
										>
											{translateLoading ? (
												<span style={{ fontSize: 11 }}>...</span>
											) : (
												<Languages size={18} />
											)}
										</ToolBtn>
										<div
											style={{
												width: 1,
												height: 20,
												background: "#ddd",
												margin: "0 1px",
											}}
										/>
										<ToolBtn onClick={handleUndo} title="Undo (⌘Z)">
											<Undo2 size={18} />
										</ToolBtn>
										<ToolBtn onClick={handleSave} title="Save">
											<Download size={18} />
										</ToolBtn>
										<ToolBtn
											onClick={cancelCapture}
											style={{ color: "#e00" }}
											title="Cancel"
										>
											<X size={18} />
										</ToolBtn>
										<ToolBtn
											onClick={handleDone}
											style={{ color: "#007aff" }}
											title="Copy to clipboard"
										>
											<Check size={18} />
										</ToolBtn>
									</div>
									{/* Row 2: Options bar — separate floating bar below.
									    Scroll-shot uses TALLER card with two internal rows
									    (speed on top, Cancel/Start on bottom right) — all inside
									    one white card like the translate dialog's content panel. */}
									{hasRow2 && (
										<div
											style={{
												...barStyle,
												top: row2Top,
												padding: inScrollReady ? "8px 10px" : "4px 6px",
												height: inScrollReady ? undefined : 36,
												flexDirection: inScrollReady
													? ("column" as const)
													: ("row" as const),
												alignItems: inScrollReady
													? ("stretch" as const)
													: ("center" as const),
												gap: inScrollReady ? 8 : 3,
											}}
										>
											{/* Scroll-shot speed: HORIZONTAL track with 3 vertical
											    tick-mark stops. Row 2 holds ONLY the speed control —
											    Cancel/Start float as separate buttons in the
											    transparent area BELOW the toolbar (see further down). */}
											{inScrollReady && (() => {
												const SPEEDS: Array<{ label: string; pps: number }> = [
													{ label: "Slow", pps: 300 },
													{ label: "Medium", pps: 600 },
													{ label: "Fast", pps: 1200 },
												];
												const activeIdx = Math.max(
													0,
													SPEEDS.findIndex((s) => s.pps === scrollSpeedPps),
												);
												const pick = (pps: number) => {
													setScrollSpeedPps(pps);
													localStorage.setItem("ishot-scroll-speed", String(pps));
												};
												const TRACK_W = 130;
												return (
													<>
														{/* Inner row 1: speed track */}
														<div
															style={{
																display: "flex",
																alignItems: "center",
																gap: 3,
															}}
														>
															<span
																style={{
																	fontSize: 11,
																	fontWeight: 600,
																	color: "rgba(0,0,0,0.55)",
																	padding: "0 6px 0 2px",
																}}
															>
																Speed
															</span>
															<div
																style={{
																	position: "relative",
																	width: TRACK_W,
																	height: 26,
																	display: "flex",
																	alignItems: "center",
																	padding: "0 6px",
																}}
															>
																{/* Horizontal track */}
																<div
																	style={{
																		position: "absolute",
																		top: "50%",
																		left: 6,
																		right: 6,
																		height: 2,
																		background: "rgba(0,0,0,0.16)",
																		borderRadius: 1,
																		transform: "translateY(-50%)",
																	}}
																/>
																{activeIdx > 0 && (
																	<div
																		style={{
																			position: "absolute",
																			top: "50%",
																			left: 6,
																			width: `calc(${(activeIdx / (SPEEDS.length - 1)) * 100}% - 12px)`,
																			height: 2,
																			background: "#007aff",
																			borderRadius: 1,
																			transform: "translateY(-50%)",
																		}}
																	/>
																)}
																<div
																	style={{
																		position: "relative",
																		display: "flex",
																		justifyContent: "space-between",
																		alignItems: "center",
																		width: "100%",
																		zIndex: 1,
																	}}
																>
																	{SPEEDS.map((s, i) => {
																		const active = i <= activeIdx;
																		const isCurrent = i === activeIdx;
																		return (
																			<div
																				key={s.pps}
																				onClick={() => pick(s.pps)}
																				title={s.label}
																				style={{
																					width: 3,
																					height: isCurrent ? 16 : 10,
																					borderRadius: 1.5,
																					background: active
																						? "#007aff"
																						: "rgba(0,0,0,0.32)",
																					cursor: "pointer",
																					boxShadow: isCurrent
																						? "0 1px 3px rgba(0,122,255,0.5)"
																						: "none",
																					transition: "all 120ms ease",
																				}}
																			/>
																		);
																	})}
																</div>
															</div>
														</div>
														{/* Inner row 2: Cancel + Start, right-aligned
														    inside the same white card. */}
														<div
															style={{
																display: "flex",
																justifyContent: "flex-end",
																gap: 6,
															}}
														>
															<button
																onClick={handleScrollCancel}
																style={{
																	height: 26,
																	padding: "0 14px",
																	border: "none",
																	borderRadius: 5,
																	background: "rgba(0,0,0,0.06)",
																	color: "rgba(0,0,0,0.78)",
																	fontSize: 12,
																	fontWeight: 600,
																	cursor: "pointer",
																	fontFamily: "inherit",
																}}
															>
																Cancel
															</button>
															<button
																onClick={handleScrollBegin}
																style={{
																	height: 26,
																	padding: "0 16px",
																	border: "none",
																	borderRadius: 5,
																	background: "#007aff",
																	color: "#fff",
																	fontSize: 12,
																	fontWeight: 600,
																	cursor: "pointer",
																	fontFamily: "inherit",
																}}
															>
																Start
															</button>
														</div>
													</>
												);
											})()}
											{/* Stroke width for shape tools */}
											{!inScrollReady && isShapeTool && (
												<>
													<DropPicker
														value={strokeWidth}
														options={[1, 2, 3, 4, 6]}
														onChange={setStrokeWidth}
														renderOption={(v) => (
															<div
																style={{
																	display: "flex",
																	alignItems: "center",
																	gap: 6,
																}}
															>
																<div
																	style={{
																		width: 18,
																		height: v,
																		background: "currentColor",
																		borderRadius: v / 2,
																	}}
																/>
															</div>
														)}
													/>
													<div
														style={{
															width: 1,
															height: 18,
															background: "#ddd",
															margin: "0 2px",
														}}
													/>
												</>
											)}
											{/* Font size + bold/underline for textbox */}
											{tool === "textbox" && (
												<>
													<DropPicker
														value={fontSize}
														options={FONT_SIZES}
														onChange={(v) => {
															setFontSize(v);
															localStorage.setItem("ishot-fontsize", String(v));
														}}
													/>
													<button
														onClick={() => setFontBold(!fontBold)}
														title="Bold"
														style={{
															width: 26,
															height: 26,
															border: "none",
															borderRadius: 4,
															cursor: "pointer",
															background: fontBold ? "#007aff" : "transparent",
															color: fontBold ? "#fff" : "#333",
															fontWeight: "bold",
															fontSize: 13,
															display: "flex",
															alignItems: "center",
															justifyContent: "center",
														}}
													>
														B
													</button>
													<button
														onClick={() => setFontUnderline(!fontUnderline)}
														title="Underline"
														style={{
															width: 26,
															height: 26,
															border: "none",
															borderRadius: 4,
															cursor: "pointer",
															background: fontUnderline
																? "#007aff"
																: "transparent",
															color: fontUnderline ? "#fff" : "#333",
															textDecoration: "underline",
															fontSize: 13,
															display: "flex",
															alignItems: "center",
															justifyContent: "center",
														}}
													>
														U
													</button>
													<div
														style={{
															width: 1,
															height: 18,
															background: "#ddd",
															margin: "0 2px",
														}}
													/>
												</>
											)}
											{/* Blur strength */}
											{(tool === "blur" || selectedBlurAnn) && (
												<input
													type="range"
													min="3"
													max="20"
													value={selectedBlurAnn?.blurStrength || blurStrength}
													onChange={(e) =>
														updateBlurStrength(Number(e.target.value))
													}
													style={{ width: 60, cursor: "pointer" }}
												/>
											)}
											{/* Color picker — square swatches */}
											{isDrawTool &&
												COLORS.map((color) => (
													<button
														key={color}
														onClick={() => {
															setStrokeColor(color);
															localStorage.setItem("ishot-color", color);
														}}
														style={{
															width: 22,
															height: 22,
															borderRadius: 3,
															background: color,
															flexShrink: 0,
															border:
																color === strokeColor
																	? "2px solid #007aff"
																	: "1px solid rgba(0,0,0,0.12)",
															cursor: "pointer",
															padding: 0,
														}}
													/>
												))}
										</div>
									)}

								</>
							);
						})()}

					{/* Hint — positioned below both toolbar bars */}
					{getHintText() &&
						(() => {
							const hintHasRow2 =
								tool === "rect" ||
								tool === "oval" ||
								tool === "arrow" ||
								tool === "line" ||
								tool === "draw" ||
								tool === "textbox" ||
								tool === "blur" ||
								!!selectedBlurAnn;
							const hintOffset = 50 + (hintHasRow2 ? 44 : 0);
							const spaceBelow =
								window.innerHeight - (selection.y + selection.height);
							const hintTop =
								spaceBelow < hintOffset + 50
									? selection.y - 40
									: selection.y + selection.height + hintOffset;
							return (
								<div
									style={{
										position: "absolute",
										left: selection.x,
										top: hintTop,
										maxWidth: selection.width,
										background: "rgba(0,0,0,0.85)",
										color: "#fff",
										padding: "6px 10px",
										borderRadius: 4,
										fontSize: 12,
										zIndex: 99,
									}}
								>
									{selectedText ? (
										<>
											<div style={{ marginBottom: 4, opacity: 0.7 }}>
												{getHintText()}
											</div>
											<div
												style={{
													whiteSpace: "pre-wrap",
													wordBreak: "break-word",
													maxHeight: 200,
													overflow: "auto",
												}}
											>
												{selectedText.slice(0, 500)}
												{selectedText.length > 500 ? "..." : ""}
											</div>
										</>
									) : (
										<div style={{ opacity: 0.9 }}>{getHintText()}</div>
									)}
								</div>
							);
						})()}

					{ocrLoading && tool === "text" && (
						<div
							style={{
								position: "absolute",
								left: selection.x + selection.width / 2 - 15,
								top: selection.y + selection.height / 2 - 15,
								width: 30,
								height: 30,
								border: "3px solid rgba(255,255,255,0.3)",
								borderTop: "3px solid #fff",
								borderRadius: "50%",
								animation: "spin 0.8s linear infinite",
								zIndex: 20,
							}}
						/>
					)}
					{/* Translate spinner — same style as OCR spinner */}
					{translateLoading && (
						<div
							style={{
								position: "absolute",
								left: selection.x + selection.width / 2 - 15,
								top: selection.y + selection.height / 2 - 15,
								width: 30,
								height: 30,
								border: "3px solid rgba(255,255,255,0.3)",
								borderTop: "3px solid #fff",
								borderRadius: "50%",
								animation: "spin 0.8s linear infinite",
								zIndex: 20,
							}}
						/>
					)}
					{/* Translate result — positioned to the RIGHT of the selection
					    (or LEFT if no room on the right). Never inside, so it
					    doesn't obscure the source text. */}
					{showTranslate &&
						// Show whenever we have a result OR we're re-translating a
						// previously OCR'd source via the dropdown. Initial OCR phase
						// (no source yet, loading) still hides the dialog — the
						// spinner over the selection covers that case.
						(translatedText || (translateLoading && translateSource)) && (() => {
						const TR_W = Math.min(Math.max(selection.width, 280), 420);
						const TR_GAP = 12;
						const rightX = selection.x + selection.width + TR_GAP;
						const leftX = selection.x - TR_W - TR_GAP;
						const trLeft = rightX + TR_W <= window.innerWidth - 10
							? rightX
							: leftX >= 10
								? leftX
								: Math.max(10, selection.x); // last-resort fallback
						const trTop = Math.max(10, selection.y);
						return (
						<div
							style={{
								position: "absolute",
								left: trLeft,
								top: trTop,
								width: TR_W,
								display: "flex",
								flexDirection: "column",
								gap: 4,
								zIndex: 200,
							}}
						>
							<div
								style={{
									background: "rgba(255,255,255,0.97)",
									borderRadius: 8,
									padding: 12,
									boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
									display: "flex",
									flexDirection: "column",
									gap: 10,
								}}
							>
								{/* Target-language dropdown — re-translates the same OCR'd
								    source text when changed (no re-OCR). Uses the custom
								    LangPicker to match the rest of the app's controls. */}
								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: 8,
										fontSize: 11,
										color: "rgba(0,0,0,0.55)",
										fontWeight: 600,
									}}
								>
									<span>Translate to</span>
									<LangPicker
										value={translateTarget}
										disabled={translateLoading && !translateSource}
										onChange={(t) => {
											setTranslateTarget(t);
											localStorage.setItem("ishot-translate-target", t);
											if (translateSource) {
												runTranslation(translateSource, t);
											}
										}}
										options={[
											{ value: "en", label: "English" },
											{ value: "vi", label: "Tiếng Việt" },
											{ value: "zh", label: "中文 (简体)" },
											{ value: "zh-TW", label: "中文 (繁體)" },
											{ value: "ja", label: "日本語" },
											{ value: "ko", label: "한국어" },
											{ value: "es", label: "Español" },
											{ value: "fr", label: "Français" },
											{ value: "de", label: "Deutsch" },
											{ value: "ru", label: "Русский" },
											{ value: "th", label: "ไทย" },
											{ value: "id", label: "Bahasa Indonesia" },
											{ value: "pt", label: "Português" },
											{ value: "ar", label: "العربية" },
										]}
									/>
								</div>
								<div
									style={{
										fontSize: 13,
										lineHeight: 1.6,
										color: "#222",
										whiteSpace: "pre-wrap",
										wordBreak: "break-word",
										userSelect: "text",
										cursor: "text",
										minHeight: 20,
									}}
								>
									{translateLoading && translateSource ? (
										<span style={{ color: "rgba(0,0,0,0.4)" }}>
											Translating…
										</span>
									) : (
										translatedText
									)}
								</div>
							</div>
							<div
								style={{ display: "flex", justifyContent: "flex-end", gap: 3 }}
							>
								<button
									onClick={() => {
										setShowTranslate(false);
										cancelCapture();
									}}
									style={{
										height: 28,
										padding: "0 12px",
										border: "none",
										borderRadius: 6,
										background: "rgba(255,255,255,0.95)",
										color: "#333",
										fontSize: 12,
										cursor: "pointer",
										fontFamily: "inherit",
										boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
									}}
								>
									Close
								</button>
								<button
									onClick={async () => {
										await invoke("copy_text_to_clipboard", {
											text: translatedText,
										});
										setShowTranslate(false);
										cancelCapture();
									}}
									style={{
										height: 28,
										padding: "0 14px",
										border: "none",
										borderRadius: 6,
										background: "#007aff",
										color: "#fff",
										fontSize: 12,
										cursor: "pointer",
										fontFamily: "inherit",
										boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
									}}
								>
									Copy
								</button>
							</div>
						</div>
						);
					})()}

					<style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
				</>
			)}
		</div>
	);
}

function ToolBtn({ children, active, onClick, style, title }: any) {
	return (
		<button
			onClick={onClick}
			title={title}
			style={{
				width: 32,
				height: 32,
				border: "none",
				borderRadius: 5,
				background: active ? "#007aff" : "transparent",
				color: active ? "#fff" : "#333",
				cursor: "pointer",
				fontSize: 14,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				...style,
			}}
		>
			{children}
		</button>
	);
}

function DropPicker({
	value,
	options,
	onChange,
	renderOption,
}: {
	value: number;
	options: number[];
	onChange: (v: number) => void;
	renderOption?: (v: number) => React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const close = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node))
				setOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open]);
	return (
		<div ref={ref} style={{ position: "relative" }}>
			<button
				onClick={() => setOpen(!open)}
				style={{
					height: 28,
					minWidth: 40,
					borderRadius: 5,
					border: "none",
					fontSize: 12,
					padding: "0 8px",
					cursor: "pointer",
					background: open ? "#007aff" : "rgba(0,0,0,0.06)",
					color: open ? "#fff" : "#333",
					display: "flex",
					alignItems: "center",
					gap: 4,
					fontFamily: "inherit",
				}}
			>
				{renderOption ? renderOption(value) : `${value}px`}
			</button>
			{open && (
				<div
					style={{
						position: "absolute",
						top: "100%",
						left: 0,
						marginTop: 4,
						background: "rgba(255,255,255,0.97)",
						borderRadius: 6,
						padding: 3,
						boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
						zIndex: 200,
						display: "flex",
						flexDirection: "column",
						gap: 1,
						minWidth: ref.current?.offsetWidth || 40,
					}}
				>
					{options.map((v) => (
						<button
							key={v}
							onClick={() => {
								onChange(v);
								setOpen(false);
							}}
							style={{
								height: 26,
								border: "none",
								borderRadius: 4,
								fontSize: 12,
								padding: "0 8px",
								background: v === value ? "#007aff" : "transparent",
								color: v === value ? "#fff" : "#333",
								cursor: "pointer",
								fontFamily: "inherit",
								display: "flex",
								alignItems: "center",
								whiteSpace: "nowrap",
							}}
						>
							{renderOption ? renderOption(v) : `${v}px`}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/**
 * Compact custom dropdown for string values. Matches the visual style of
 * `DropPicker` (button + popover menu, blue active state, click-outside to
 * close) but accepts arbitrary string-labelled options. Used by the translate
 * dialog's target-language selector.
 *
 * Layout note: when `align="right"` the popover anchors to the right edge of
 * the trigger button instead of the default left edge, useful when the
 * trigger sits at the right side of its container.
 */
function LangPicker({
	value,
	options,
	onChange,
	disabled,
	align = "left",
}: {
	value: string;
	options: { value: string; label: string }[];
	onChange: (v: string) => void;
	disabled?: boolean;
	align?: "left" | "right";
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const close = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [open]);
	const currentLabel =
		options.find((o) => o.value === value)?.label ?? value;
	return (
		<div ref={ref} style={{ position: "relative", display: "inline-block" }}>
			<button
				onClick={() => !disabled && setOpen(!open)}
				disabled={disabled}
				style={{
					height: 24,
					minWidth: 110,
					borderRadius: 5,
					border: "none",
					fontSize: 12,
					padding: "0 8px",
					cursor: disabled ? "default" : "pointer",
					background: open ? "#007aff" : "rgba(0,0,0,0.06)",
					color: open ? "#fff" : "#1c1c1e",
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 6,
					fontFamily: "inherit",
					fontWeight: 600,
					opacity: disabled ? 0.5 : 1,
				}}
			>
				<span>{currentLabel}</span>
				<ChevronDown size={12} />
			</button>
			{open && (
				<div
					style={{
						position: "absolute",
						top: "100%",
						[align]: 0,
						marginTop: 4,
						background: "rgba(255,255,255,0.98)",
						borderRadius: 6,
						padding: 3,
						boxShadow: "0 6px 24px rgba(0,0,0,0.22)",
						zIndex: 300,
						display: "flex",
						flexDirection: "column",
						gap: 1,
						minWidth: 140,
						maxHeight: 280,
						overflowY: "auto",
					}}
				>
					{options.map((opt) => (
						<button
							key={opt.value}
							onClick={() => {
								onChange(opt.value);
								setOpen(false);
							}}
							style={{
								height: 26,
								border: "none",
								borderRadius: 4,
								fontSize: 12,
								padding: "0 10px",
								background: opt.value === value ? "#007aff" : "transparent",
								color: opt.value === value ? "#fff" : "#1c1c1e",
								cursor: "pointer",
								fontFamily: "inherit",
								display: "flex",
								alignItems: "center",
								whiteSpace: "nowrap",
								textAlign: "left",
								justifyContent: "flex-start",
								fontWeight: opt.value === value ? 600 : 500,
							}}
						>
							{opt.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

export default App;
