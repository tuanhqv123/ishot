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
	Scroll,
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
	const [showScreenshot, setShowScreenshot] = useState(true);

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
		setLockedByOther(false);
		setScrollCapturing(false);
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

	const handleTranslate = useCallback(async () => {
		if (displayCaptures.length === 0 || !selection || translateLoading) return;
		setTranslateLoading(true);
		setShowTranslate(true);
		setTranslatedText("");
		try {
			// OCR the selection first
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
				return;
			}
			// Translate — auto-detect to English (or Vietnamese if source is English)
			const targetLang = /^[a-zA-Z\s.,!?'"()-]+$/.test(sourceText)
				? "vi"
				: "en";
			const result = await invoke<{
				translated: string;
				source_lang: string;
				target_lang: string;
			}>("translate_text", { text: sourceText, targetLang });
			setTranslatedText(result.translated);
		} catch (e) {
			setTranslatedText("Translation failed: " + e);
		} finally {
			setTranslateLoading(false);
		}
	}, [displayCaptures, selection, translateLoading, findDisplay]);

	const handleToolChange = useCallback(
		(newTool: Tool) => {
			setTool(newTool);
			setSelectedAnnotation(null);
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
			setDisplayCaptures([]);
			setStage("idle");
		});
		return () => { unlistenClear.then((fn) => fn()); };
	}, []);

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

	// Click Start button → hide overlay, show border window, show scroll panel, begin capture
	const handleScrollBegin = useCallback(async () => {
		if (!selection) return;
		try {
			await invoke("hide_overlay");
			await invoke("show_scroll_border", {
				x: selection.x,
				y: selection.y,
				width: selection.width,
				height: selection.height,
			});
			await invoke("show_scroll_panel");
			await invoke("start_scroll_capture");
		} catch (e) {
			console.error("[scroll] start failed:", e);
			setScrollCapturing(false);
		}
	}, [selection]);

	// Cancel scroll (before or during capture)
	const handleScrollCancel = useCallback(async () => {
		try {
			await invoke("cancel_scroll_capture");
			await invoke("hide_scroll_panel");
			await invoke("hide_scroll_border");
		} catch (e) {
			console.error("[scroll] cancel failed:", e);
		}
		setScrollCapturing(false);
		resetState();
	}, [resetState]);

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

	// Scroll capture auto-stop from backend (5s no scroll)
	useEffect(() => {
		const unlisten = listen("scroll-capture-result", async (event) => {
			const payload = event.payload as {
				data: number[];
				width: number;
				height: number;
			};
			if (payload.data) {
				await invoke("copy_to_clipboard", { imageBytes: payload.data });
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
					handleScrollCancel();
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

			{/* Dark overlay with clip - hide during scroll mode so user can see screen */}
			{selection && selection.width > 0 && !scrollCapturing && (
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

					{/* Scroll capture: Start/Cancel bar (replaces normal toolbar) */}
					{scrollCapturing && scrollFrames === 0 && (
						<div
							style={{
								position: "absolute",
								left: Math.max(4, selection.x + selection.width / 2 - 100),
								top: selection.y + selection.height + 8,
								background: "rgba(30,30,30,0.85)",
								borderRadius: 8,
								padding: "5px 6px",
								display: "flex",
								gap: 4,
								boxShadow: "0 2px 12px rgba(0,0,0,0.35)",
								zIndex: 100,
							}}
						>
							<button
								onClick={handleScrollBegin}
								style={{
									height: 28,
									padding: "0 14px",
									border: "none",
									borderRadius: 6,
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
							<button
								onClick={handleScrollCancel}
								style={{
									height: 28,
									padding: "0 12px",
									border: "none",
									borderRadius: 6,
									background: "rgba(255,255,255,0.95)",
									color: "#333",
									fontSize: 12,
									fontWeight: 600,
									cursor: "pointer",
									fontFamily: "inherit",
								}}
							>
								Cancel
							</button>
						</div>
					)}

					{/* Normal Toolbars — flip above if no space below */}
					{!scrollCapturing &&
						(() => {
							const FONT_SIZES = [
								10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48,
							];
							const hasRow2 =
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
										<ToolBtn onClick={handleStartScroll} title="Scroll capture">
											<Scroll size={18} />
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
									{/* Row 2: Options bar — separate floating bar below */}
									{hasRow2 && (
										<div
											style={{
												...barStyle,
												top: row2Top,
												padding: "4px 6px",
												height: 36,
											}}
										>
											{/* Stroke width for shape tools */}
											{isShapeTool && (
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
					{/* Translate result */}
					{showTranslate && !translateLoading && translatedText && (
						<div
							style={{
								position: "absolute",
								left: Math.max(10, selection.x),
								top: Math.max(10, selection.y + 30),
								width: Math.min(Math.max(selection.width, 280), 420),
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
								}}
							>
								<div
									style={{
										fontSize: 13,
										lineHeight: 1.6,
										color: "#222",
										whiteSpace: "pre-wrap",
										wordBreak: "break-word",
										userSelect: "text",
										cursor: "text",
									}}
								>
									{translatedText}
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
					)}

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

export default App;
