import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
	ArrowRight,
	ArrowUp,
	Check,
	Circle,
	Download,
	Droplet,
	GripVertical,
	Languages,
	Minus,
	Palette,
	PenLine,
	Pencil,
	ScanText,
	ImageDown,
	ChevronDown,
	Sparkles,
	Square,
	Type,
	Undo2,
	X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rough from "roughjs";
import { getStroke } from "perfect-freehand";

interface AiChatMsg {
	role: "system" | "user" | "assistant";
	content: string;
	error?: boolean;
}
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
	sloppiness?: Sloppiness;
	seed?: number;
	bold?: boolean;
	underline?: boolean;
	/// Rich-text content (mixed bold/underline runs) of a textbox — the
	/// contentEditable's innerHTML. `text` keeps the plain innerText for
	/// empty-checks and as a legacy-export fallback.
	html?: string;
}

// Excalidraw-style "Sloppiness": how hand-drawn / rough the stroke looks.
// 0 = smooth (architect), 1 = artist, 2 = cartoonist. Maps to rough.js
// roughness + bowing.
type Sloppiness = 0 | 1 | 2;
function roughFor(s: Sloppiness | undefined): { roughness: number; bowing: number } {
	switch (s) {
		case 2:
			return { roughness: 2.6, bowing: 2 };
		case 1:
			return { roughness: 1.3, bowing: 1.2 };
		default:
			return { roughness: 0.4, bowing: 0.6 };
	}
}

// A geometric shape to paint, in logical canvas coordinates.
type ShapeSpec =
	| { kind: "rect"; x: number; y: number; w: number; h: number }
	| { kind: "oval"; cx: number; cy: number; w: number; h: number }
	| { kind: "line"; x1: number; y1: number; x2: number; y2: number }
	| {
			kind: "arrow";
			x1: number;
			y1: number;
			x2: number;
			y2: number;
			headLen: number;
			spread: number;
	  };

// Single place that renders rect / oval / line / arrow, shared by the committed
// redraw and the live drag-preview so they always match.
//
// Sloppiness 0 ("Smooth", the default) draws with NATIVE canvas paths — the
// standard, fully anti-aliased renderer — so straight/diagonal edges are crisp
// instead of the grainy doubled edge rough.js leaves. Levels 1-2 keep rough.js
// for the intentional hand-drawn Excalidraw look.
function paintShape(
	ctx: CanvasRenderingContext2D,
	rc: ReturnType<typeof rough.canvas>,
	s: Sloppiness,
	spec: ShapeSpec,
	style: { color: string; lw: number; seed: number },
) {
	const { color, lw, seed } = style;
	const arrowHead = (
		emit: (fromX: number, fromY: number, toX: number, toY: number) => void,
		a: Extract<ShapeSpec, { kind: "arrow" }>,
	) => {
		const angle = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
		emit(a.x1, a.y1, a.x2, a.y2);
		emit(
			a.x2,
			a.y2,
			a.x2 - a.headLen * Math.cos(angle - a.spread),
			a.y2 - a.headLen * Math.sin(angle - a.spread),
		);
		emit(
			a.x2,
			a.y2,
			a.x2 - a.headLen * Math.cos(angle + a.spread),
			a.y2 - a.headLen * Math.sin(angle + a.spread),
		);
	};

	if (s === 0) {
		ctx.save();
		ctx.strokeStyle = color;
		ctx.lineWidth = lw;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		ctx.beginPath();
		if (spec.kind === "rect") ctx.rect(spec.x, spec.y, spec.w, spec.h);
		else if (spec.kind === "oval")
			ctx.ellipse(
				spec.cx,
				spec.cy,
				Math.abs(spec.w) / 2,
				Math.abs(spec.h) / 2,
				0,
				0,
				Math.PI * 2,
			);
		else if (spec.kind === "line") {
			ctx.moveTo(spec.x1, spec.y1);
			ctx.lineTo(spec.x2, spec.y2);
		} else if (spec.kind === "arrow")
			arrowHead((fx, fy, tx, ty) => {
				ctx.moveTo(fx, fy);
				ctx.lineTo(tx, ty);
			}, spec);
		ctx.stroke();
		ctx.restore();
		return;
	}

	const ro = roughFor(s);
	const opts = {
		stroke: color,
		strokeWidth: lw,
		roughness: ro.roughness,
		bowing: ro.bowing,
		seed,
	};
	if (spec.kind === "rect") rc.rectangle(spec.x, spec.y, spec.w, spec.h, opts);
	else if (spec.kind === "oval")
		rc.ellipse(spec.cx, spec.cy, spec.w, spec.h, opts);
	else if (spec.kind === "line")
		rc.line(spec.x1, spec.y1, spec.x2, spec.y2, opts);
	else if (spec.kind === "arrow")
		arrowHead((fx, fy, tx, ty) => rc.line(fx, fy, tx, ty, opts), spec);
}

// Render a freehand stroke as a smooth, naturally-tapered filled path using
// perfect-freehand (the same lib Excalidraw uses) — replaces the old raw
// lineTo polyline that looked jagged/streaky.
function drawFreehand(
	ctx: CanvasRenderingContext2D,
	pts: { x: number; y: number }[],
	color: string,
	width: number,
) {
	if (pts.length === 0) return;
	const outline = getStroke(
		pts.map((p) => [p.x, p.y]),
		{
			size: Math.max(4, width * 2),
			thinning: 0.55,
			smoothing: 0.6,
			streamline: 0.5,
		},
	);
	if (outline.length < 2) return;
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.moveTo(outline[0][0], outline[0][1]);
	for (let i = 1; i < outline.length; i++)
		ctx.lineTo(outline[i][0], outline[i][1]);
	ctx.closePath();
	ctx.fill();
}

// Translate an annotation by (dx, dy) — used for click-drag move. Each shape
// type carries its geometry differently.
function moveAnnotation(a: Annotation, dx: number, dy: number): Annotation {
	if (a.type === "draw" && a.path)
		return { ...a, path: a.path.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
	if (a.ex !== undefined)
		return { ...a, x: a.x + dx, y: a.y + dy, ex: a.ex + dx, ey: (a.ey ?? 0) + dy };
	return { ...a, x: a.x + dx, y: a.y + dy };
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
// Fixed rough.js seed for the live drag preview so the shape doesn't
// re-jitter on every mousemove (only the committed annotation gets a unique
// seed derived from its id).
const PREVIEW_SEED = 42;

function App() {
	const [stage, setStage] = useState<Stage>("idle");
	const [displayCaptures, setDisplayCaptures] = useState<DisplayCapture[]>([]);
	const [imgDims, setImgDims] = useState({ w: 0, h: 0 });
	const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
	const [selection, setSelection] = useState<Region | null>(null);
	const [isDragging, setIsDragging] = useState(false);
	const dragStartRef = useRef<{ x: number; y: number } | null>(null);

	// Window-detect mode (Cmd+Shift+4 → Space style): hover snaps the selection
	// to whatever window is under the cursor. Active by default when the
	// overlay first appears; the moment the user mousedown+drags more than
	// a few pixels we flip into manual "region" mode for the rest of this
	// session. `hoveredWindow` is the live hit-test result we draw.
	type WindowInfo = {
		id: number;
		x: number;
		y: number;
		w: number;
		h: number;
		app_name: string;
		title: string;
		layer: number;
		alpha: number;
		pid: number;
	};
	const [selectMode, setSelectMode] = useState<"auto" | "region">("auto");
	const [snappedWindows, setSnappedWindows] = useState<WindowInfo[]>([]);
	const [hoveredWindow, setHoveredWindow] = useState<WindowInfo | null>(null);
	// Hint pill fades out after 3 s — present only at the start of each
	// selecting session as a hint, not a permanent UI element.
	const [hintVisible, setHintVisible] = useState(false);

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
	// Active click-drag move of an annotation: original snapshot + grab point.
	const annDragRef = useRef<{
		startX: number;
		startY: number;
		orig: Annotation;
	} | null>(null);
	const [blurStrength, setBlurStrength] = useState(10);
	const [tempBlur, setTempBlur] = useState<Region | null>(null);
	const [fontSize, setFontSize] = useState(
		() => Number(localStorage.getItem("ishot-fontsize")) || 16,
	);
	const [fontBold, setFontBold] = useState(false);
	const [fontUnderline, setFontUnderline] = useState(false);
	const [strokeWidth, setStrokeWidth] = useState(
		() => Number(localStorage.getItem("ishot-stroke-w")) || 4,
	);
	const [sloppiness, setSloppiness] = useState<Sloppiness>(
		() => (Number(localStorage.getItem("ishot-sloppiness")) as Sloppiness) || 0,
	);
	// Last shape picked in the options row — the row-1 "shapes" button
	// re-activates this one so clicking it always drops you into a usable tool.
	const [lastShape, setLastShape] = useState<Tool>("rect");
	const [editingTextId, setEditingTextId] = useState<number | null>(null);

	// While editing a textbox, the B/U indicators track the CARET: as it moves
	// through bold/underlined runs the buttons light up to show what typing
	// here would produce — editor behavior, not per-box state. Font size stays
	// per-box, synced on selection.
	useEffect(() => {
		if (editingTextId === null) return;
		const sync = () => {
			setFontBold(document.queryCommandState("bold"));
			setFontUnderline(document.queryCommandState("underline"));
		};
		sync();
		document.addEventListener("selectionchange", sync);
		return () => document.removeEventListener("selectionchange", sync);
	}, [editingTextId]);
	useEffect(() => {
		const target = editingTextId ?? selectedAnnotation;
		if (target === null) return;
		const ann = annotations.find(
			(a) => a.id === target && a.type === "textbox",
		);
		if (ann?.fontSize) setFontSize(ann.fontSize);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editingTextId, selectedAnnotation]);

	// Toggle bold/underline at the caret of the textbox being edited.
	//
	// With a real selection, execCommand handles the toggle fine. With a
	// COLLAPSED caret inside a styled run, WebKit can't reliably end the run —
	// typing keeps the old style until the box loses focus ("phải click ra
	// ngoài mới tắt được"). So for collapsed carets we do the editor-grade DOM
	// surgery ourselves: insert a zero-width marker, then split the styling
	// elements around it (off) or wrap it (on), and park the caret inside.
	const toggleInlineStyle = useCallback(
		(kind: "bold" | "underline") => {
			const root = document.activeElement as HTMLElement | null;
			if (!root || !root.isContentEditable) return;
			const sel = window.getSelection();
			if (!sel || sel.rangeCount === 0) return;

			const syncIndicators = () => {
				setFontBold(document.queryCommandState("bold"));
				setFontUnderline(document.queryCommandState("underline"));
			};

			if (!sel.isCollapsed) {
				document.execCommand(kind);
				syncIndicators();
				return;
			}

			const wasOn = document.queryCommandState(kind);
			document.execCommand(
				"insertHTML",
				false,
				'<span data-ts="1">\u200B</span>',
			);
			const marker = root.querySelector('[data-ts="1"]') as HTMLElement | null;
			if (!marker) return;

			const matches = (el: HTMLElement) => {
				const tag = el.tagName;
				if (kind === "bold")
					return (
						tag === "B" ||
						tag === "STRONG" ||
						/^(bold|[5-9]00)$/.test(el.style.fontWeight || "")
					);
				return (
					tag === "U" ||
					/underline/.test(
						el.style.textDecorationLine || el.style.textDecoration || "",
					)
				);
			};
			// Lift `node` one level: out of its parent, splitting the parent's
			// trailing children into a clone so document order is preserved.
			const splitOut = (node: Node) => {
				const p = node.parentElement;
				if (!p || !p.parentNode) return;
				const right = p.cloneNode(false) as HTMLElement;
				while (node.nextSibling) right.appendChild(node.nextSibling);
				p.parentNode.insertBefore(node, p.nextSibling);
				if (right.hasChildNodes())
					p.parentNode.insertBefore(right, node.nextSibling);
				if (!p.hasChildNodes()) p.remove();
			};

			if (wasOn) {
				// OFF: keep splitting until no styled element remains above the marker.
				for (let guard = 0; guard < 20; guard++) {
					let found: HTMLElement | null = null;
					for (
						let a: HTMLElement | null = marker.parentElement;
						a && a !== root;
						a = a.parentElement
					) {
						if (matches(a)) {
							found = a;
							break;
						}
					}
					if (!found) break;
					while (found.contains(marker)) splitOut(marker);
				}
			} else {
				// ON: wrap the marker so typing continues inside the new style.
				const wrap = document.createElement(kind === "bold" ? "b" : "u");
				marker.parentNode?.insertBefore(wrap, marker);
				wrap.appendChild(marker);
			}

			// Caret right after the zero-width space, inside the marker.
			const tn = marker.firstChild;
			if (tn) {
				const r = document.createRange();
				r.setStart(tn, 1);
				r.collapse(true);
				sel.removeAllRanges();
				sel.addRange(r);
			}
			marker.removeAttribute("data-ts");

			// The DOM changed without an input event — persist it ourselves.
			const html = root.innerHTML;
			const text = root.innerText.replace(/\u200B/g, "");
			const target = editingTextId;
			if (target !== null)
				setAnnotations((prev) =>
					prev.map((a) => (a.id === target ? { ...a, html, text } : a)),
				);
			syncIndicators();
		},
		[editingTextId],
	);
	const [shiftHeld, setShiftHeld] = useState(false);
	const [lockedByOther, setLockedByOther] = useState(false);
	const [scrollCapturing, setScrollCapturing] = useState(false);
	const [scrollFrames, setScrollFrames] = useState(0);
	// Measured toolbar widths — used to clamp the toolbar inside the viewport
	// when the selection sits near a screen edge. Starts with a sensible
	// estimate so the first paint isn't wildly off; useLayoutEffect updates
	// to the real width as soon as the row mounts / changes contents.
	const toolbarRow1Ref = useRef<HTMLDivElement | null>(null);
	const toolbarRow2Ref = useRef<HTMLDivElement | null>(null);
	const [toolbarRow1W, setToolbarRow1W] = useState(440);
	const [toolbarRow2W, setToolbarRow2W] = useState(440);
	// User-dragged displacement for floating surfaces, relative to their
	// computed anchor. Needed on notched MacBooks: a full-screen selection
	// centers the toolbar/chat under the camera housing where it can't be
	// reached. A grip handle lets the user drag the surface anywhere.
	const [toolbarOffset, setToolbarOffset] = useState({ x: 0, y: 0 });
	const [aiOffset, setAiOffset] = useState({ x: 0, y: 0 });
	// Returns a mousedown handler that drags a {x,y} offset by following the
	// cursor. Shared by the toolbar grip and the chat header.
	const makeDragStart = useCallback(
		(
			offset: { x: number; y: number },
			setOffset: (o: { x: number; y: number }) => void,
		) =>
			(e: React.MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
				const startX = e.clientX;
				const startY = e.clientY;
				const baseX = offset.x;
				const baseY = offset.y;
				const move = (ev: MouseEvent) =>
					setOffset({
						x: baseX + ev.clientX - startX,
						y: baseY + ev.clientY - startY,
					});
				const up = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			},
		[],
	);
	const onToolbarDragStart = makeDragStart(toolbarOffset, setToolbarOffset);
	const onAiDragStart = makeDragStart(aiOffset, setAiOffset);
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
		setToolbarOffset({ x: 0, y: 0 });
		setAiOffset({ x: 0, y: 0 });
		// AI chat — tear down listeners if a stream is active.
		if (aiAbortRef.current) {
			aiAbortRef.current();
			aiAbortRef.current = null;
		}
		setShowAi(false);
		setAiMessages([]);
		setAiInput("");
		setAiSeedText("");
		setAiStreaming(false);
		setAiLoading(false);
		dragStartRef.current = null;
	}, []);

	const cancelCapture = useCallback(async () => {
		resetState();
		// Pop the crosshair cursor we pushed when the overlay appeared
		// (Rust side `push_overlay_cursor`). Safe to call when nothing is
		// pushed — it no-ops.
		invoke("release_overlay_cursor").catch(() => {});
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
				canvasRef.current.width, // full dpr-scaled backing store, not logical
				canvasRef.current.height,
				0,
				0,
				sw,
				sh,
			);

		// Draw textbox annotations.
		// Rich boxes (mixed bold/underline runs) are rasterized via an SVG
		// foreignObject snapshot of the SAME html + css the editor showed —
		// pixel-faithful WYSIWYG, including wrapping. The inner div is scaled
		// up so text rasterizes at the export resolution, not screen px.
		const drawRichTextbox = (ann: Annotation) =>
			new Promise<void>((resolve) => {
				// contentEditable HTML (e.g. bare <br>) isn't valid XML — round-trip
				// it through XMLSerializer so foreignObject's XML parser accepts it.
				const tmp = document.createElement("div");
				tmp.innerHTML = ann.html || "";
				const xhtml = new XMLSerializer()
					.serializeToString(tmp)
					.replace(/^<div[^>]*>/, "")
					.replace(/<\/div>$/, "");
				const w = Math.ceil(ann.w! * scale);
				const h = Math.ceil(ann.h! * scale);
				const style =
					`transform:scale(${scale});transform-origin:0 0;` +
					`width:${ann.w}px;height:${ann.h}px;padding:2px;box-sizing:border-box;` +
					`color:${ann.color || "#ff0000"};` +
					`font:${ann.fontSize || 16}px Helvetica, Arial, sans-serif;` +
					`line-height:1.3;white-space:pre-wrap;word-break:break-word;overflow:hidden;`;
				const svg =
					`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
					`<foreignObject width="100%" height="100%">` +
					`<div xmlns="http://www.w3.org/1999/xhtml" style="${style}">${xhtml}</div>` +
					`</foreignObject></svg>`;
				const img = new Image();
				img.onload = () => {
					ctx.drawImage(img, ann.x * scale, ann.y * scale);
					resolve();
				};
				img.onerror = () => resolve();
				img.src =
					"data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
			});

		for (const ann of annotations) {
			if (ann.type !== "textbox" || !ann.text?.trim() || !ann.w || !ann.h)
				continue;
			if (ann.html) {
				await drawRichTextbox(ann);
				continue;
			}
			// Legacy plain-text path (boxes created before rich text existed).
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
			// Surface the failure — previously this died silently in the console
			// and the user just saw the spinner stop with nothing happening.
			new Notification("iShot — OCR failed", { body: String(e) });
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

	// AI chat — all state lives only while the dialog is open. Closing the
	// dialog wipes everything; we never persist conversation history.
	const [showAi, setShowAi] = useState(false);
	const [aiLoading, setAiLoading] = useState(false);
	const [aiSeedText, setAiSeedText] = useState("");
	const [aiMessages, setAiMessages] = useState<AiChatMsg[]>([]);
	const [aiInput, setAiInput] = useState("");
	const [aiStreaming, setAiStreaming] = useState(false);
	const aiAbortRef = useRef<(() => void) | null>(null);
	const aiScrollRef = useRef<HTMLDivElement>(null);

	// --- Mode exclusivity helpers ---------------------------------------
	// AI chat, Translate, Scroll capture and the annotation tools are
	// mutually exclusive modes. Every entry point calls the close helpers
	// of the OTHER modes first, so two modes can never be active at once
	// (previously: Translate + AI dialogs could stack, scroll-ready could
	// coexist with an in-flight OCR, etc.).
	const closeAiPanel = useCallback(() => {
		if (aiAbortRef.current) {
			aiAbortRef.current();
			aiAbortRef.current = null;
		}
		setShowAi(false);
		setAiMessages([]);
		setAiInput("");
		setAiSeedText("");
		setAiStreaming(false);
		setAiLoading(false);
		setAiOffset({ x: 0, y: 0 });
	}, []);

	const closeTranslatePanel = useCallback(() => {
		setShowTranslate(false);
		setTranslatedText("");
		setTranslateSource("");
		setTranslateLoading(false);
	}, []);

	const exitScrollReady = useCallback(() => {
		setScrollCapturing(false);
		setScrollFrames(0);
		invoke("cancel_scroll_capture").catch(() => {});
	}, []);

	const handleAi = useCallback(async () => {
		if (displayCaptures.length === 0 || !selection || aiLoading) return;
		if (showAi) {
			// Toggle: clicking the AI button while the dialog is open closes it.
			closeAiPanel();
			return;
		}
		// No API key yet → don't open an empty chat that immediately errors.
		// Nudge the user with a notification and send them to Settings.
		const hasKey = await invoke<boolean>("has_api_key").catch(() => false);
		if (!hasKey) {
			new Notification("AI needs a key", {
				body: "Drop your API key in Settings and we're good to go.",
			});
			// Tear down the capture overlay first — otherwise it stays up
			// covering the screen and the user has to hit Esc to even see the
			// notification / Settings panel.
			await cancelCapture();
			await invoke("open_settings").catch(() => {});
			return;
		}
		closeTranslatePanel();
		exitScrollReady();
		setTool(null);
		setSelectedText("");
		setSelectedBlockIndices(new Set());
		setAiLoading(true);
		setShowAi(true);
		setAiMessages([]);
		try {
			const dc = findDisplay();
			if (!dc) {
				setAiLoading(false);
				return;
			}
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
			setAiSeedText(sourceText);
		} catch (e) {
			console.error("[ai] OCR seed failed", e);
			setAiSeedText("");
		} finally {
			setAiLoading(false);
		}
	}, [
		displayCaptures,
		selection,
		aiLoading,
		showAi,
		findDisplay,
		closeAiPanel,
		closeTranslatePanel,
		exitScrollReady,
		cancelCapture,
	]);

	const sendAiPrompt = useCallback(async () => {
		const prompt = aiInput.trim();
		if (!prompt || aiStreaming) return;
		setAiInput("");

		// Build the full message list. The first user turn carries the OCR
		// context inline; subsequent turns are plain follow-ups.
		const isFirstUserTurn = !aiMessages.some((m) => m.role === "user");
		const userContent = isFirstUserTurn
			? `Context from the screenshot:\n\n${aiSeedText}\n\n---\n\nQ: ${prompt}`
			: prompt;

		const baseMessages: AiChatMsg[] =
			aiMessages.length === 0
				? [
						{
							role: "system",
							content:
								"You are a helpful assistant. The user is sharing OCR-extracted text from a screenshot. Answer their question concisely. Render code blocks and lists in Markdown when useful.",
						},
					]
				: aiMessages;

		const userMsg: AiChatMsg = { role: "user", content: userContent };
		const displayUser: AiChatMsg = { role: "user", content: prompt };
		const assistantPlaceholder: AiChatMsg = { role: "assistant", content: "" };

		const sendMessages = [...baseMessages, userMsg];
		// What we render — we show the user's typed prompt, not the verbose
		// context-stuffed copy. The full version is what goes to the API.
		setAiMessages([...baseMessages, displayUser, assistantPlaceholder]);

		const requestId =
			typeof crypto !== "undefined" && "randomUUID" in crypto
				? crypto.randomUUID()
				: `${Date.now()}-${Math.random()}`;

		setAiStreaming(true);

		// Listen for token / done / error events keyed by requestId. We hold
		// the unlisten handles in a ref so closing the dialog mid-stream
		// tears them down deterministically.
		let unlistenToken: (() => void) | null = null;
		let unlistenDone: (() => void) | null = null;
		let unlistenError: (() => void) | null = null;
		const teardown = () => {
			unlistenToken?.();
			unlistenDone?.();
			unlistenError?.();
			unlistenToken = unlistenDone = unlistenError = null;
			aiAbortRef.current = null;
		};
		aiAbortRef.current = teardown;

		unlistenToken = await listen<{ text: string }>(
			`ai-token:${requestId}`,
			(ev) => {
				const text = ev.payload.text;
				setAiMessages((prev) => {
					if (prev.length === 0) return prev;
					const next = prev.slice();
					const last = next[next.length - 1];
					if (last.role !== "assistant") return prev;
					next[next.length - 1] = { ...last, content: last.content + text };
					return next;
				});
			},
		);
		unlistenDone = await listen(`ai-done:${requestId}`, () => {
			setAiStreaming(false);
			teardown();
		});
		unlistenError = await listen<{ message: string }>(
			`ai-error:${requestId}`,
			(ev) => {
				const msg = ev.payload.message || "Unknown error";
				setAiMessages((prev) => {
					if (prev.length === 0) return prev;
					const next = prev.slice();
					const last = next[next.length - 1];
					if (last.role !== "assistant") return prev;
					next[next.length - 1] = {
						...last,
						content: last.content
							? last.content + `\n\n_Error: ${msg}_`
							: `Error: ${msg}`,
						error: true,
					};
					return next;
				});
				setAiStreaming(false);
				teardown();
			},
		);

		try {
			// API payload — strip the local-only `error` flag so the backend
			// only sees role + content (matches ChatMessage on the Rust side).
			const apiMessages = sendMessages.map((m) => ({
				role: m.role,
				content: m.content,
			}));
			await invoke("ai_chat_stream", {
				requestId,
				messages: apiMessages,
			});
		} catch (e) {
			console.error("[ai] invoke failed", e);
			setAiMessages((prev) => {
				if (prev.length === 0) return prev;
				const next = prev.slice();
				next[next.length - 1] = {
					role: "assistant",
					content: `Error: ${e}`,
					error: true,
				};
				return next;
			});
			setAiStreaming(false);
			teardown();
		}
	}, [aiInput, aiMessages, aiSeedText, aiStreaming]);

	// Auto-scroll chat to bottom as new content arrives.
	useEffect(() => {
		if (aiScrollRef.current) {
			aiScrollRef.current.scrollTop = aiScrollRef.current.scrollHeight;
		}
	}, [aiMessages]);

	// Measure toolbar rows whenever the toolbar might change shape (tool
	// selection, scroll state, blur selection). Runs synchronously before paint
	// so the clamp uses fresh measurements and the toolbar never visibly jumps.
	useLayoutEffect(() => {
		if (toolbarRow1Ref.current) {
			const w = toolbarRow1Ref.current.offsetWidth;
			if (w > 0 && Math.abs(w - toolbarRow1W) > 1) setToolbarRow1W(w);
		}
		if (toolbarRow2Ref.current) {
			const w = toolbarRow2Ref.current.offsetWidth;
			if (w > 0 && Math.abs(w - toolbarRow2W) > 1) setToolbarRow2W(w);
		}
	});

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
		closeAiPanel();
		exitScrollReady();
		setTool(null);
		setSelectedText("");
		setSelectedBlockIndices(new Set());
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
		closeAiPanel,
		exitScrollReady,
	]);

	const handleToolChange = useCallback(
		(newTool: Tool) => {
			// Annotation tools are exclusive with the dialog/scroll modes.
			closeAiPanel();
			closeTranslatePanel();
			exitScrollReady();
			setTool(newTool);
			setSelectedAnnotation(null);
			if (newTool === "text" && textBlocks.length === 0 && !ocrLoading)
				performOcr();
			if (newTool !== "text") {
				setSelectedText("");
				setSelectedBlockIndices(new Set());
			}
		},
		[
			textBlocks.length,
			ocrLoading,
			performOcr,
			closeAiPanel,
			closeTranslatePanel,
			exitScrollReady,
		],
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
			setToolbarOffset({ x: 0, y: 0 });
			// Reset window-detect: every new capture session starts in auto mode.
			// Snapshot the OS windows now so hover hit-testing is instant.
			setSelectMode("auto");
			setHoveredWindow(null);
			setHintVisible(true);
			window.setTimeout(() => setHintVisible(false), 3000);
			invoke<WindowInfo[]>("snapshot_windows")
				.then(setSnappedWindows)
				.catch((e) => console.error("[window-detect] snapshot failed:", e));
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// Click Scroll icon on toolbar → start MANUAL scroll capture immediately.
	//
	// The user scrolls the page themselves; Rust passively captures frames,
	// detects the scroll offset via NCC and stitches. No synthetic scroll
	// events, no speed presets, no Accessibility permission needed. The
	// session ends on Esc (scroll panel) or after ~12 s without scrolling.
	const handleStartScroll = useCallback(async () => {
		if (!selection || scrollCapturing) return;
		const dc = findDisplay();
		if (!dc) return;
		closeAiPanel();
		closeTranslatePanel();
		setSelectedText("");
		setSelectedBlockIndices(new Set());
		const monitorIdx = getWindowMonitorIndex();
		const mon = monitors[monitorIdx];
		const monX = mon?.x ?? 0;
		const monY = mon?.y ?? 0;
		// SCREEN-space (logical-screen) coords — the scroll-border window and
		// the capture rect both need these, NOT the overlay-local selection.
		const screenX = monX + selection.x;
		const screenY = monY + selection.y;
		setScrollCapturing(true);
		setScrollFrames(0);
		setTool(null);
		try {
			await invoke("prepare_scroll_capture", {
				x: screenX,
				y: screenY,
				width: selection.width,
				height: selection.height,
			});
			// Hide the overlay BEFORE the first frame is captured so neither
			// the dim layer nor the selection border bakes into the output.
			await invoke("hide_overlay");
			await invoke("show_scroll_border", {
				x: screenX,
				y: screenY,
				width: selection.width,
				height: selection.height,
			});
			// Pass the SELECTION rect (screen-space) so the panel lands on the
			// same monitor as the border — found by the selection's center,
			// identical to show_scroll_border. Passing the monitor origin alone
			// was unreliable and put the panel on the wrong display.
			await invoke("show_scroll_panel", {
				x: screenX,
				y: screenY,
				width: selection.width,
				height: selection.height,
			});
			await invoke("start_scroll_capture");
		} catch (e) {
			console.error("[scroll] start failed:", e);
			try { await invoke("hide_scroll_panel"); } catch {}
			try { await invoke("hide_scroll_border"); } catch {}
			setScrollCapturing(false);
			await cancelCapture();
		}
	}, [
		selection,
		scrollCapturing,
		findDisplay,
		monitors,
		closeAiPanel,
		closeTranslatePanel,
		cancelCapture,
	]);

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
			// Rust shows the saved-confirmation HUD pill itself.
			await invoke("finalize_scroll_to_clipboard");
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
			// path). Length check is what distinguishes — the capture thread
			// sends `data: []` after copying to the clipboard itself.
			if (payload.data && payload.data.length > 0) {
				await invoke("copy_to_clipboard", { imageBytes: payload.data });
			}
			// No notification here — the scroll panel already shows one for
			// this event; doubling up produced two banners per capture.
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
				// Dialog-first: Esc closes an open AI/Translate panel and keeps
				// the capture session alive; a second Esc then cancels as usual.
				if (showAi) {
					closeAiPanel();
					return;
				}
				if (showTranslate) {
					closeTranslatePanel();
					return;
				}
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
		showAi,
		showTranslate,
		closeAiPanel,
		closeTranslatePanel,
	]);

	useEffect(() => {
		if (stage === "editing" && selection && canvasRef.current) {
			// Backing store at physical resolution (Retina = 2x logical) so strokes
			// render crisp instead of upscaled/aliased. CSS size stays logical, so
			// it still displays at the right on-screen size. redrawAnnotations()
			// applies the matching ctx scale so all drawing stays in logical units.
			const dpr = window.devicePixelRatio || 1;
			canvasRef.current.width = Math.round(selection.width * dpr);
			canvasRef.current.height = Math.round(selection.height * dpr);
		}
	}, [stage, selection]);

	const redrawAnnotations = useCallback(() => {
		const canvas = canvasRef.current;
		if (!canvas || !selection) return;
		const ctx = canvas.getContext("2d")!;
		// Canvas backing store is dpr-scaled (see the sizing effect). Reset to
		// device space to clear the whole buffer, then scale so every draw call
		// below works in logical pixels. The live drag-preview (which calls this
		// then keeps drawing on the same ctx) inherits this transform.
		const dpr = window.devicePixelRatio || 1;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
		const rc = rough.canvas(canvas);

		for (const ann of annotations) {
			if (ann.type === "blur" || ann.type === "textbox") continue; // textbox rendered as HTML overlay
			const isSelected = ann.id === selectedAnnotation;
			const color = isSelected ? "#007aff" : ann.color || "#ff0000";
			const lw = isSelected ? (ann.strokeWidth || 2) + 1 : ann.strokeWidth || 2;
			// Stable `seed` (per-annotation) keeps the hand-drawn jitter identical
			// across every redraw instead of re-randomizing.
			const s = ann.sloppiness ?? 0;
			const style = { color, lw, seed: ann.seed || ann.id || 1 };

			if (ann.type === "rect" && ann.w !== undefined) {
				// Normalize so negative w/h (drawn right-to-left) render cleanly.
				paintShape(ctx, rc, s, {
					kind: "rect",
					x: Math.min(ann.x, ann.x + ann.w),
					y: Math.min(ann.y, ann.y + ann.h!),
					w: Math.abs(ann.w),
					h: Math.abs(ann.h!),
				}, style);
			} else if (ann.type === "oval" && ann.w !== undefined) {
				paintShape(ctx, rc, s, {
					kind: "oval",
					cx: ann.x + ann.w / 2,
					cy: ann.y + ann.h! / 2,
					w: Math.abs(ann.w),
					h: Math.abs(ann.h!),
				}, style);
			} else if (ann.type === "arrow" && ann.ex !== undefined) {
				paintShape(ctx, rc, s, {
					kind: "arrow",
					x1: ann.x,
					y1: ann.y,
					x2: ann.ex,
					y2: ann.ey!,
					headLen: Math.max(18, lw * 5.5),
					spread: Math.PI / 7,
				}, style);
			} else if (ann.type === "line" && ann.ex !== undefined) {
				paintShape(ctx, rc, s, {
					kind: "line",
					x1: ann.x,
					y1: ann.y,
					x2: ann.ex,
					y2: ann.ey!,
				}, style);
			} else if (ann.type === "draw" && ann.path && ann.path.length > 0) {
				// Smooth, naturally-tapered freehand via perfect-freehand.
				drawFreehand(ctx, ann.path, color, ann.strokeWidth || 4);
			}
		}
	}, [annotations, selection, selectedAnnotation]);

	useEffect(() => {
		if (stage === "editing") redrawAnnotations();
	}, [annotations, stage, redrawAnnotations, selectedAnnotation]);

	// Mouse handlers — selection has TWO modes:
	//   - "auto": hover-detect, snaps to whatever OS window is under cursor.
	//             Click without drag = capture that window.
	//   - "region": classic drag-to-select rectangle.
	// We start in auto; the moment the user mousedown+drags more than 4 px we
	// flip to region for the rest of this session.
	const DRAG_THRESHOLD = 4;

	const monLocal = () => {
		const idx = getWindowMonitorIndex();
		return monitors[idx] || { x: 0, y: 0, width: 0, height: 0, scale_factor: 1 };
	};

	const handleMouseDown = (e: React.MouseEvent) => {
		if (stage === "selecting") {
			e.preventDefault();
			dragStartRef.current = { x: e.clientX, y: e.clientY };
			// Don't commit isDragging or clear the hover highlight yet — we
			// might still be in auto mode and this could be a click.
		}
	};

	// Commit the hovered window as the final selection — converts the
	// screen-space rect back to overlay-local coords, clamps to monitor
	// bounds, and advances to the editing stage so the toolbar appears.
	const commitHoveredWindow = useCallback((w: WindowInfo) => {
		const idx = getWindowMonitorIndex();
		const mon = monitors[idx];
		if (!mon) return;
		const x = Math.max(0, w.x - mon.x);
		const y = Math.max(0, w.y - mon.y);
		const ww = Math.min(w.x + w.w - mon.x, mon.width) - x;
		const hh = Math.min(w.y + w.h - mon.y, mon.height) - y;
		if (ww <= 10 || hh <= 10) return;
		setSelection({ x, y, width: ww, height: hh });
		setHoveredWindow(null);
		setStage("editing");
		setTool(null);
		// Keep iShot active here — the editing toolbar needs to be clickable
		// without a stale "click-to-focus-app-first" round trip. Deactivation
		// happens later in cancelCapture (the only path that hides the overlay).
		emit("selection-locked", { label: getCurrentWindow().label });
	}, [monitors]);

	const handleMouseMove = (e: React.MouseEvent) => {
		if (stage !== "selecting") return;
		e.preventDefault();
		const start = dragStartRef.current;

		// Region mode (or just promoted to it): track the drag rect.
		if (isDragging && start) {
			setSelection({
				x: Math.min(start.x, e.clientX),
				y: Math.min(start.y, e.clientY),
				width: Math.abs(e.clientX - start.x),
				height: Math.abs(e.clientY - start.y),
			});
			return;
		}

		// Mouse held down but not yet dragging — promote on threshold.
		if (start) {
			const dx = e.clientX - start.x;
			const dy = e.clientY - start.y;
			if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
				setSelectMode("region");
				setHoveredWindow(null);
				setIsDragging(true);
				setSelection({
					x: Math.min(start.x, e.clientX),
					y: Math.min(start.y, e.clientY),
					width: Math.abs(e.clientX - start.x),
					height: Math.abs(e.clientY - start.y),
				});
			}
			return;
		}

		// Auto-detect: convert cursor to screen coords and hit-test the cached
		// window list. Hover only previews — the user has to click (or
		// click-drag) to commit, matching native macOS Cmd+Shift+4+Space.
		if (selectMode === "auto") {
			const mon = monLocal();
			const sx = mon.x + e.clientX;
			const sy = mon.y + e.clientY;
			const hit = snappedWindows.find((w) => {
				if (!(sx >= w.x && sx < w.x + w.w && sy >= w.y && sy < w.y + w.h))
					return false;
				// Skip maximized/background surfaces that fill the whole monitor —
				// those resolve to the full-screen target below anyway.
				const coversScreen = w.w >= mon.width * 0.97 && w.h >= mon.height * 0.97;
				return !coversScreen;
			});
			// Over a real window → highlight it. Over empty desktop / a full-screen
			// background → highlight the WHOLE monitor so a click captures the
			// entire screen.
			setHoveredWindow(
				hit ?? {
					id: -1,
					x: mon.x,
					y: mon.y,
					w: mon.width,
					h: mon.height,
					app_name: "Screen",
					title: "",
					layer: 0,
					alpha: 1,
					pid: 0,
				},
			);
		}
	};

	const handleMouseUp = (_e: React.MouseEvent) => {
		if (stage !== "selecting") return;

		// Region mode: finalize the drag rect (existing flow).
		if (isDragging) {
			setIsDragging(false);
			dragStartRef.current = null;
			if (selection && selection.width > 10 && selection.height > 10) {
				setStage("editing");
				setTool(null);
				// Same as auto-commit above: stay active so the toolbar
				// responds to the first click.
				emit("selection-locked", { label: getCurrentWindow().label });
			} else setSelection(null);
			return;
		}

		// Auto mode, click without drag:
		//   - over a window → commit that window as the selection
		//   - over empty space → cancel the overlay (Esc-equivalent)
		dragStartRef.current = null;
		if (selectMode === "auto") {
			if (hoveredWindow) {
				commitHoveredWindow(hoveredWindow);
			} else {
				cancelCapture();
			}
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

		// Clicking directly on an existing annotation selects it AND begins a
		// click-hold drag to move it — even while a drawing tool is active. This
		// keeps the tool selected for continuous drawing (below) while allowing
		// "click to select / drag to move".
		for (let i = annotations.length - 1; i >= 0; i--) {
			if (isPointInAnnotation(annotations[i], x, y)) {
				setSelectedAnnotation(annotations[i].id);
				annDragRef.current = { startX: x, startY: y, orig: annotations[i] };
				return;
			}
		}

		// No tool → plain selection mode; empty click just clears selection.
		if (!tool) {
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
		// Dragging an existing annotation to move it.
		if (annDragRef.current) {
			const d = annDragRef.current;
			const r = e.currentTarget.getBoundingClientRect();
			const dx = e.clientX - r.left - d.startX;
			const dy = e.clientY - r.top - d.startY;
			setAnnotations((prev) =>
				prev.map((a) => (a.id === d.orig.id ? moveAnnotation(d.orig, dx, dy) : a)),
			);
			return;
		}
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
		// Live preview shares paintShape() with the committed render. A FIXED seed
		// keeps the hand-drawn jitter stable while the user drags the shape out.
		const rc = rough.canvas(canvasRef.current!);
		const style = { color: strokeColor, lw: strokeWidth, seed: PREVIEW_SEED };

		if (tool === "rect")
			paintShape(ctx, rc, sloppiness, {
				kind: "rect",
				x: Math.min(drawStart.x, x),
				y: Math.min(drawStart.y, y),
				w: Math.abs(x - drawStart.x),
				h: Math.abs(y - drawStart.y),
			}, style);
		else if (tool === "oval") {
			paintShape(ctx, rc, sloppiness, {
				kind: "oval",
				cx: (drawStart.x + x) / 2,
				cy: (drawStart.y + y) / 2,
				w: Math.abs(x - drawStart.x),
				h: Math.abs(y - drawStart.y),
			}, style);
		} else if (tool === "arrow") {
			paintShape(ctx, rc, sloppiness, {
				kind: "arrow",
				x1: drawStart.x,
				y1: drawStart.y,
				x2: x,
				y2: y,
				headLen: Math.max(18, strokeWidth * 5.5),
				spread: Math.PI / 7,
			}, style);
		} else if (tool === "line") {
			paintShape(ctx, rc, sloppiness, {
				kind: "line",
				x1: drawStart.x,
				y1: drawStart.y,
				x2: x,
				y2: y,
			}, style);
		} else if (tool === "draw" && currentPath.length > 0) {
			drawFreehand(ctx, [...currentPath, { x: rawX, y: rawY }], strokeColor, strokeWidth);
		}
	};

	const handleCanvasMouseUp = (e: React.MouseEvent) => {
		// Finish an annotation-move drag.
		if (annDragRef.current) {
			annDragRef.current = null;
			return;
		}
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
					sloppiness,
					seed: id,
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
					sloppiness,
					seed: id,
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
					sloppiness,
					seed: id,
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
					sloppiness,
					seed: id,
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
					sloppiness,
					seed: id,
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
					html: "",
					fontSize,
				},
			]);
			setEditingTextId(id);
		}

		// Keep the tool active after a stroke so the user can keep drawing
		// (Excalidraw "locked tool" behavior). They switch tools via the
		// toolbar, or click an existing shape to select it.
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
				<>
					{/* Dim everything except the window under cursor (auto mode).
					    The dim layer uses the same clip-path trick as the region
					    overlay below: a punched-out rect over the hovered window. */}
					{selectMode === "auto" && hoveredWindow && (() => {
						const mon = monLocal();
						const x = Math.max(0, hoveredWindow.x - mon.x);
						const y = Math.max(0, hoveredWindow.y - mon.y);
						const w =
							Math.min(hoveredWindow.x + hoveredWindow.w - mon.x, mon.width) - x;
						const h =
							Math.min(hoveredWindow.y + hoveredWindow.h - mon.y, mon.height) - y;
						if (w <= 0 || h <= 0) return null;
						return (
							<>
								<div
									style={{
										position: "absolute",
										inset: 0,
										background: "rgba(0,0,0,0.5)",
										pointerEvents: "none",
										clipPath: `polygon(0% 0%, 0% 100%, ${x}px 100%, ${x}px ${y}px, ${x + w}px ${y}px, ${x + w}px ${y + h}px, ${x}px ${y + h}px, ${x}px 100%, 100% 100%, 100% 0%)`,
									}}
								/>
								<div
									style={{
										position: "absolute",
										left: x,
										top: y,
										width: w,
										height: h,
										border: "2px solid #ffffff",
										boxShadow: "0 0 0 1px rgba(0,0,0,0.45), 0 4px 16px rgba(0,0,0,0.35)",
										boxSizing: "border-box",
										pointerEvents: "none",
									}}
								/>
							</>
						);
					})()}

					{/* Solid dim when nothing hovered (auto mode initial state, or
					    region mode waiting for drag). */}
					{!(selectMode === "auto" && hoveredWindow) && (
						<div
							style={{
								position: "absolute",
								inset: 0,
								background: "rgba(0,0,0,0.3)",
								pointerEvents: "none",
							}}
						/>
					)}

					{/* Hint pill, bottom-center. Visible for 3 s on every new
					    selecting session, then fades out — educational without
					    cluttering the screen permanently. */}
					<div
						style={{
							position: "absolute",
							bottom: 24,
							left: "50%",
							transform: "translateX(-50%)",
							padding: "8px 14px",
							fontSize: 12,
							color: "rgba(255,255,255,0.92)",
							background: "rgba(0,0,0,0.55)",
							backdropFilter: "blur(8px)",
							borderRadius: 8,
							pointerEvents: "none",
							letterSpacing: 0.2,
							opacity: hintVisible ? 1 : 0,
							transition: "opacity 400ms ease",
						}}
					>
						Click window to capture · Drag to select region · Esc to cancel
					</div>
				</>
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

					{/* Textbox annotations.
					    zIndex 11: the drawing canvas comes LATER in the DOM at zIndex 10,
					    so anything ≤10 here is unclickable — that's why clicking a
					    committed textbox did nothing.
					    Interactions: drag the box to move it; release without moving to
					    start editing (caret in the textarea); × button or ⌫ deletes. */}
					{annotations
						.filter((a) => a.type === "textbox")
						.map((ann) => (
							<div
								key={ann.id}
								onMouseDown={(e) => {
									// While editing this box, leave the mouse to the textarea
									// (caret placement, text selection).
									if (editingTextId === ann.id) return;
									e.preventDefault();
									e.stopPropagation();
									setSelectedAnnotation(ann.id);
									const startX = e.clientX,
										startY = e.clientY,
										origX = ann.x,
										origY = ann.y;
									let moved = false;
									const onMove = (me: MouseEvent) => {
										const dx = me.clientX - startX,
											dy = me.clientY - startY;
										if (!moved && Math.hypot(dx, dy) < 4) return;
										moved = true;
										setAnnotations((prev) =>
											prev.map((a) =>
												a.id === ann.id
													? { ...a, x: origX + dx, y: origY + dy }
													: a,
											),
										);
									};
									const onUp = () => {
										window.removeEventListener("mousemove", onMove);
										window.removeEventListener("mouseup", onUp);
										// A plain click (no drag) = continue typing here.
										if (!moved) setEditingTextId(ann.id);
									};
									window.addEventListener("mousemove", onMove);
									window.addEventListener("mouseup", onUp);
								}}
								style={{
									position: "absolute",
									left: selection.x + ann.x,
									top: selection.y + ann.y,
									width: ann.w,
									height: ann.h,
									zIndex: 11,
									cursor: editingTextId === ann.id ? "text" : "move",
									borderRadius: 4,
									// Committed text reads as part of the image — the frame
									// only appears while the box is selected/being edited.
									// Hairline system-blue, not a heavy 2px stroke.
									// (transparent, not none, so nothing shifts by 1px.)
									border:
										ann.id === selectedAnnotation ||
										editingTextId === ann.id
											? "1px solid rgba(0, 122, 255, 0.8)"
											: "1px solid transparent",
									boxShadow:
										ann.id === selectedAnnotation ||
										editingTextId === ann.id
											? "0 0 0 3px rgba(0, 122, 255, 0.12)"
											: "none",
								}}
							>
								{ann.id === selectedAnnotation && (
									<button
										onMouseDown={(e) => {
											e.preventDefault();
											e.stopPropagation();
										}}
										onClick={(e) => {
											e.stopPropagation();
											setAnnotations((prev) =>
												prev.filter((a) => a.id !== ann.id),
											);
											setSelectedAnnotation(null);
											setEditingTextId(null);
										}}
										title="Delete"
										style={{
											position: "absolute",
											top: -7,
											right: -7,
											width: 16,
											height: 16,
											borderRadius: "50%",
											border: "0.5px solid rgba(255, 255, 255, 0.25)",
											background: "rgba(28, 28, 30, 0.8)",
											backdropFilter: "blur(8px)",
											WebkitBackdropFilter: "blur(8px)",
											color: "rgba(255, 255, 255, 0.9)",
											fontSize: 8,
											fontWeight: 600,
											lineHeight: "15px",
											textAlign: "center",
											padding: 0,
											cursor: "pointer",
											zIndex: 12,
										}}
									>
										✕
									</button>
								)}
								{/* Rich-text editor: contentEditable so bold/underline apply
								    per-RUN at the caret (toggle B mid-typing affects only what
								    comes next), not to the whole box. UNCONTROLLED on purpose:
								    React must never write innerHTML on re-render or the caret
								    would jump — content is seeded once via the ref. */}
								<div
									contentEditable
									suppressContentEditableWarning
									data-ph="Type here..."
									ref={(el) => {
										if (!el) return;
										if (!el.innerHTML && ann.html) el.innerHTML = ann.html;
										if (ann.id === editingTextId && document.activeElement !== el) {
											el.focus();
											// Caret at the end so "continue typing" continues.
											const r = document.createRange();
											r.selectNodeContents(el);
											r.collapse(false);
											const sel = window.getSelection();
											sel?.removeAllRanges();
											sel?.addRange(r);
										}
									}}
									onInput={(e) => {
										const el = e.currentTarget;
										const html = el.innerHTML;
										const text = el.innerText;
										setAnnotations((prev) =>
											prev.map((a) =>
												a.id === ann.id ? { ...a, html, text } : a,
											),
										);
									}}
									onFocus={() => setEditingTextId(ann.id)}
									onBlur={(e) => {
										setEditingTextId(null);
										// Remove empty textbox on blur
										if (!e.currentTarget.innerText.trim())
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
										fontFamily: "Helvetica, Arial, sans-serif",
										padding: 2,
										lineHeight: 1.3,
										caretColor: ann.color || "#ff0000",
										whiteSpace: "pre-wrap",
										wordBreak: "break-word",
										overflow: "hidden",
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
					    Row 2 shows tool-specific options (shape/stroke/color etc.).
					    Hidden entirely while the AI chat dialog is open — the
					    dialog IS the active surface; Esc brings the toolbar back. */}
					{!showAi && (() => {
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
							// row1: 32px buttons + 2×6px padding = 44. row2: 28px controls
							// + 2×6px padding = 40. Keep in sync with --ctrl/--pad tokens.
							const row1H = 44,
								row2H = 40,
								gap = 4;
							const totalH = row1H + (hasRow2 ? row2H + gap : 0);
							const spaceBelow =
								window.innerHeight - (selection.y + selection.height);
							const showAbove = spaceBelow < totalH + 16;
							const baseTop = showAbove
								? selection.y - totalH - 8
								: selection.y + selection.height + 8;
							const row1Top = Math.min(
								Math.max(4, Math.max(4, baseTop) + toolbarOffset.y),
								window.innerHeight - row1H - 4,
							);
							const row2Top = row1Top + row1H + gap;
							// Clamp using the WIDER of the two rows so neither one clips
							// off-screen even when row 2 is wider than row 1 (e.g. scroll
							// settings + Cancel/Start fills row 2 more than the tools fill
							// row 1). Measurements come from a useLayoutEffect on the row
							// refs — accurate even after the toolbar's contents change.
							const widestRow = hasRow2
								? Math.max(toolbarRow1W, toolbarRow2W)
								: toolbarRow1W;
							const halfW = widestRow / 2;
							const toolbarLeft = Math.max(
								4,
								Math.min(
									selection.x + selection.width / 2 - halfW + toolbarOffset.x,
									window.innerWidth - widestRow - 4,
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
								background: "var(--surface)",
								borderRadius: "var(--radius-m)",
								padding: "var(--pad)",
								display: "flex",
								gap: "var(--gap)",
								alignItems: "center" as const,
								boxShadow: "var(--shadow-pop)",
								zIndex: 100,
							};
							return (
								<>
									{/* Row 1: Tools + actions */}
									<div ref={toolbarRow1Ref} style={{ ...barStyle, top: row1Top }}>
										{/* Drag handle — lets the user move the toolbar when the
										    default position is unreachable (e.g. a full-screen
										    selection centers it under the MacBook notch). */}
										<div
											onMouseDown={onToolbarDragStart}
											title="Move toolbar"
											style={{
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
												width: 16,
												height: 32,
												cursor: "grab",
												color: "rgba(0,0,0,0.3)",
												flexShrink: 0,
											}}
										>
											<GripVertical size={14} />
										</div>
										{/* "Shapes" entry button — opens the options row below where
										    the individual shapes (square/circle/arrow/line/draw) live. */}
										<ToolBtn
											active={isShapeTool}
											onClick={() => handleToolChange(lastShape)}
											title="Shapes"
										>
											<PenLine size={18} />
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
											<Droplet size={18} />
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
											active={scrollCapturing}
											onClick={handleStartScroll}
											title="Scroll capture — scroll the page yourself, Esc to finish"
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
										<ToolBtn
											active={showAi}
											onClick={handleAi}
											title="AI Chat"
										>
											{aiLoading ? (
												<span style={{ fontSize: 11 }}>...</span>
											) : (
												<Sparkles size={18} />
											)}
										</ToolBtn>
										<div
											style={{
												width: 1,
												height: 20,
												background: "var(--separator)",
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
											style={{ color: "var(--red)" }}
											title="Cancel"
										>
											<X size={18} />
										</ToolBtn>
										<ToolBtn
											onClick={handleDone}
											style={{ color: "var(--accent)" }}
											title="Copy to clipboard"
										>
											<Check size={18} />
										</ToolBtn>
									</div>
									{/* Row 2: Options bar — separate floating bar below. */}
									{hasRow2 && (
										<div
											ref={toolbarRow2Ref}
											style={{
												...barStyle,
												top: row2Top,
											}}
										>
											{/* Spacer matching row 1's drag grip (16px) so the options
											    line up under the tool buttons instead of shifting left. */}
											<div style={{ width: 16, flexShrink: 0 }} />
											{/* Shape row: the shapes themselves as individual buttons,
											    then stroke weight → sloppiness → color. */}
											{isShapeTool && (
												<>
													{(
														[
															["rect", <Square size={18} />, "Square"],
															["oval", <Circle size={18} />, "Circle"],
															["arrow", <ArrowRight size={18} />, "Arrow"],
															["line", <Minus size={18} />, "Line"],
															["draw", <Pencil size={18} />, "Draw"],
														] as [Tool, React.ReactNode, string][]
													).map(([t, icon, title]) => (
														<ToolBtn
															key={t}
															active={tool === t}
															onClick={() => {
																setLastShape(t);
																handleToolChange(t);
															}}
															title={title}
														>
															{icon}
														</ToolBtn>
													))}
													<div
														style={{
															width: 1,
															height: 18,
															background: "var(--separator)",
															margin: "0 2px",
														}}
													/>
													<DropPicker
														compact
														value={strokeWidth}
														options={[2, 4, 6, 8]}
														onChange={(v) => {
															setStrokeWidth(v);
															localStorage.setItem("ishot-stroke-w", String(v));
														}}
														renderOption={(v) => (
															<div
																style={{
																	width: 16,
																	height: v,
																	background: "currentColor",
																	borderRadius: v / 2,
																}}
															/>
														)}
													/>
													<SloppinessPicker
														value={sloppiness}
														onChange={(s) => {
															setSloppiness(s);
															localStorage.setItem("ishot-sloppiness", String(s));
														}}
													/>
													<div
														style={{
															width: 1,
															height: 18,
															background: "var(--separator)",
															margin: "0 2px",
														}}
													/>
												</>
											)}
											{/* Font size (per box) + bold/underline (per RUN).
											    B/U run document.execCommand at the caret of the
											    contentEditable, exactly like a text editor: existing
											    runs keep their style, what you type next uses the
											    new one. onMouseDown preventDefault keeps focus (and
											    the caret/selection) inside the box while clicking. */}
											{tool === "textbox" && (
												<>
													<DropPicker
														value={fontSize}
														options={FONT_SIZES}
														onChange={(v) => {
															setFontSize(v);
															localStorage.setItem("ishot-fontsize", String(v));
															const target = editingTextId ?? selectedAnnotation;
															if (target !== null)
																setAnnotations((prev) =>
																	prev.map((a) =>
																		a.id === target && a.type === "textbox"
																			? { ...a, fontSize: v }
																			: a,
																	),
																);
														}}
													/>
													<button
														onMouseDown={(e) => e.preventDefault()}
														onClick={() => {
															if (editingTextId !== null)
																toggleInlineStyle("bold");
															else setFontBold(!fontBold);
														}}
														title="Bold"
														style={{
															width: 28,
															height: 28,
															padding: 0,
															border: "none",
															borderRadius: "var(--radius-s)",
															cursor: "pointer",
															background: fontBold ? "var(--accent)" : "transparent",
															color: fontBold ? "#fff" : "var(--label)",
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
														onMouseDown={(e) => e.preventDefault()}
														onClick={() => {
															if (editingTextId !== null)
																toggleInlineStyle("underline");
															else setFontUnderline(!fontUnderline);
														}}
														title="Underline"
														style={{
															width: 28,
															height: 28,
															padding: 0,
															border: "none",
															borderRadius: "var(--radius-s)",
															cursor: "pointer",
															background: fontUnderline
																? "var(--accent)"
																: "transparent",
															color: fontUnderline ? "#fff" : "var(--label)",
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
															background: "var(--separator)",
															margin: "0 2px",
														}}
													/>
												</>
											)}
											{/* Blur strength — custom styled slider (the native range
											    looked out of place). Label + thin track + accent fill. */}
											{(tool === "blur" || selectedBlurAnn) && (
												<div
													style={{
														display: "flex",
														alignItems: "center",
														gap: 7,
														padding: "0 4px",
													}}
												>
													<span
														style={{
															fontSize: 11,
															fontWeight: 600,
															color: "var(--label-2)",
														}}
													>
														Blur
													</span>
													<input
														className="ishot-range"
														type="range"
														min="3"
														max="20"
														value={selectedBlurAnn?.blurStrength || blurStrength}
														onChange={(e) =>
															updateBlurStrength(Number(e.target.value))
														}
														style={{ width: 84 }}
													/>
												</div>
											)}
											{/* Color picker — dropdown with swatch grid */}
											{isDrawTool && (
												<ColorPicker
													value={strokeColor}
													options={COLORS}
													onChange={(color) => {
														setStrokeColor(color);
														localStorage.setItem("ishot-color", color);
													}}
												/>
											)}
										</div>
									)}

								</>
							);
						})()}

					{/* Hint — positioned below both toolbar bars */}
					{getHintText() &&
						(() => {
							// The hint rides WITH the toolbar: same row math, same center,
							// same drag offset, same above/below flip — otherwise it sits
							// at the selection's left edge while the toolbar is centered.
							const hintHasRow2 =
								tool === "rect" ||
								tool === "oval" ||
								tool === "arrow" ||
								tool === "line" ||
								tool === "draw" ||
								tool === "textbox" ||
								tool === "blur" ||
								!!selectedBlurAnn;
							const row1H = 44,
								row2H = 40,
								gap = 4;
							const totalH = row1H + (hintHasRow2 ? row2H + gap : 0);
							const spaceBelow =
								window.innerHeight - (selection.y + selection.height);
							const showAbove = spaceBelow < totalH + 16;
							const baseTop = showAbove
								? selection.y - totalH - 8
								: selection.y + selection.height + 8;
							const row1Top = Math.min(
								Math.max(4, Math.max(4, baseTop) + toolbarOffset.y),
								window.innerHeight - row1H - 4,
							);
							const widestRow = hintHasRow2
								? Math.max(toolbarRow1W, toolbarRow2W)
								: toolbarRow1W;
							const toolbarLeft = Math.max(
								4,
								Math.min(
									selection.x + selection.width / 2 - widestRow / 2 + toolbarOffset.x,
									window.innerWidth - widestRow - 4,
								),
							);
							// Below the full toolbar stack (or above row 1 when flipped).
							// Rows stack LEFT-ALIGNED at toolbarLeft (see barStyle) — the
							// hint joins the same stack, same left edge.
							const hintTop = showAbove
								? row1Top - 38
								: row1Top + totalH + 10;
							return (
								<div
									style={{
										position: "absolute",
										left: toolbarLeft,
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
								style={{ display: "flex", justifyContent: "flex-end", gap: "var(--gap)" }}
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
										borderRadius: "var(--radius-s)",
										background: "var(--surface)",
										color: "var(--label)",
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
										borderRadius: "var(--radius-s)",
										background: "var(--accent)",
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

					{/* AI Chat dialog — positioned to the RIGHT of the selection
					    (or LEFT if no room), mirroring the Translate dialog's
					    placement logic. Lives entirely in the overlay window;
					    closing it discards every message. */}
					{showAi && (() => {
						const AI_W = Math.min(Math.max(selection.width, 360), 480);
						const AI_GAP = 12;
						const rightX = selection.x + selection.width + AI_GAP;
						const leftX = selection.x - AI_W - AI_GAP;
						const aiLeft =
							rightX + AI_W <= window.innerWidth - 10
								? rightX
								: leftX >= 10
									? leftX
									: Math.max(10, selection.x);
						const aiTop = Math.max(10, selection.y);
						// Cap the card to a sane height so a long conversation scrolls
						// inside it instead of sprawling down the whole screen. Never
						// exceed the space available below the anchor, but also never
						// taller than ~460px regardless of how big the display is.
						const aiMaxH = Math.min(
							460,
							Math.max(240, window.innerHeight - aiTop - 20),
						);
						const visibleMsgs = aiMessages.filter((m) => m.role !== "system");
						// Apply the user's drag offset, clamped so the card can't be
						// dragged fully off-screen.
						const aiPosLeft = Math.max(
							8,
							Math.min(aiLeft + aiOffset.x, window.innerWidth - AI_W - 8),
						);
						const aiPosTop = Math.max(
							8,
							Math.min(aiTop + aiOffset.y, window.innerHeight - 120),
						);
						return (
							<div
								style={{
									position: "absolute",
									left: aiPosLeft,
									top: aiPosTop,
									width: AI_W,
									maxHeight: aiMaxH,
									display: "flex",
									flexDirection: "column",
									zIndex: 200,
								}}
								onMouseDown={(e) => e.stopPropagation()}
								onClick={(e) => e.stopPropagation()}
							>
								<div
									style={{
										// Light frosted card — matches the toolbar visible in
										// the same context. (Settings is a separate window, so
										// it stays dark; these two share a surface.)
										background: "var(--surface)",
										backdropFilter: "blur(20px) saturate(180%)",
										WebkitBackdropFilter: "blur(20px) saturate(180%)",
										border: "1px solid var(--separator)",
										borderRadius: "var(--radius-l)",
										boxShadow: "var(--shadow)",
										display: "flex",
										flexDirection: "column",
										overflow: "hidden",
										maxHeight: aiMaxH - 4,
									}}
								>
									{/* Header — invisible drag strip (move like the toolbar)
									    with just a close button. No divider, title or icon. */}
									<div
										onMouseDown={onAiDragStart}
										style={{
											display: "flex",
											justifyContent: "flex-end",
											alignItems: "center",
											padding: "4px 4px 0 4px",
											cursor: "grab",
											userSelect: "none",
										}}
									>
										<button
											onMouseDown={(e) => e.stopPropagation()}
											onClick={closeAiPanel}
											title="Close"
											style={{
												width: 24,
												height: 24,
												padding: 0,
												border: "none",
												borderRadius: 6,
												background: "transparent",
												color: "var(--label-2)",
												cursor: "pointer",
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
											}}
										>
											<X size={15} />
										</button>
									</div>
									<div
										ref={aiScrollRef}
										style={{
											// flex:1 + minHeight:0 is what lets this region SCROLL
											// inside the height-capped card instead of pushing the
											// card taller as messages accumulate.
											flex: 1,
											minHeight: 0,
											overflowY: "auto",
											padding: "10px 10px",
											display: "flex",
											flexDirection: "column",
											gap: 8,
										}}
									>
										{visibleMsgs.length === 0 && (
											<div
												style={{
													fontSize: 12,
													color: "var(--label-2)",
													textAlign: "center",
													padding: "16px 8px",
												}}
											>
												Ask anything about the captured text.
											</div>
										)}
										{visibleMsgs.map((m, i) => {
											// Thinking state (assistant, no content yet) renders as
											// bare shimmer text — NO bubble box around it.
											const isThinking = m.role === "assistant" && !m.content;
											if (isThinking) {
												return (
													<div
														key={i}
														style={{
															alignSelf: "flex-start",
															padding: "2px 4px",
														}}
													>
														<ThinkingLabel />
													</div>
												);
											}
											return (
												<div
													key={i}
													style={{
														alignSelf:
															m.role === "user" ? "flex-end" : "flex-start",
														maxWidth: "88%",
														background:
															m.role === "user"
																? "var(--accent)"
																: m.error
																	? "rgba(255,59,48,0.12)"
																	: "var(--fill)",
														color:
															m.role === "user"
																? "#fff"
																: m.error
																	? "#c0271c"
																	: "var(--label)",
														padding: "6px 10px",
														borderRadius: 12,
														fontSize: 13,
														lineHeight: 1.5,
														wordBreak: "break-word",
														userSelect: "text",
													}}
													className={
														m.role === "assistant" ? "ai-md ai-msg" : "ai-msg"
													}
												>
													{m.role === "assistant" ? (
														<ReactMarkdown remarkPlugins={[remarkGfm]}>
															{m.content}
														</ReactMarkdown>
													) : (
														m.content
													)}
												</div>
											);
										})}
									</div>

									<div
										style={{
											padding: 8,
											flexShrink: 0,
										}}
									>
										{/* Messages-style capsule: rounded field, send button inside. */}
										<div className="ai-input-wrap">
												<textarea
													className="ai-input"
													value={aiInput}
													onChange={(e) => setAiInput(e.target.value)}
													onKeyDown={(e) => {
														if (e.key === "Enter" && !e.shiftKey) {
															e.preventDefault();
															sendAiPrompt();
														}
													}}
													rows={1}
													placeholder="Ask about this…"
													disabled={aiLoading}
													style={{
														flex: 1,
														resize: "none",
														border: "none",
														padding: "5px 0",
														fontSize: 13,
														fontFamily: "inherit",
														lineHeight: 1.4,
														maxHeight: 110,
														outline: "none",
														background: "transparent",
														color: "var(--label)",
													}}
												/>
												{/* One circular accent button, two states
												    (Messages-style): arrow-up = send, square =
												    stop. Same shape, same color. */}
												<button
													className="ai-send"
													title={aiStreaming ? "Stop" : "Send"}
													onClick={() => {
														if (aiStreaming) {
															aiAbortRef.current?.();
															setAiStreaming(false);
														} else {
															sendAiPrompt();
														}
													}}
													disabled={
														!aiStreaming && (aiLoading || !aiInput.trim())
													}
												>
													{aiStreaming ? (
														<Square size={9} fill="currentColor" />
													) : (
														<ArrowUp size={14} strokeWidth={2.5} />
													)}
												</button>
											</div>
										</div>
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

// Whimsical "thinking" verbs in the spirit of Claude Code's spinner — shown
// (one at a time, cycling) in place of a boring "Thinking…" while we wait for
// the first streamed token. No bubble around them; just the shimmer text.
const THINKING_WORDS = [
	"Thinking",
	"Pondering",
	"Germinating",
	"Cogitating",
	"Ruminating",
	"Noodling",
	"Percolating",
	"Conjuring",
	"Marinating",
	"Finagling",
	"Puzzling",
	"Musing",
	"Scheming",
	"Churning",
	"Brewing",
	"Simmering",
];
function ThinkingLabel() {
	const [idx, setIdx] = useState(() =>
		Math.floor(Math.random() * THINKING_WORDS.length),
	);
	useEffect(() => {
		// Every 5s pick a RANDOM next word (never repeating the current one), so
		// the order varies each time instead of marching through the list.
		const t = window.setInterval(() => {
			setIdx((prev) => {
				if (THINKING_WORDS.length < 2) return prev;
				let next = prev;
				while (next === prev)
					next = Math.floor(Math.random() * THINKING_WORDS.length);
				return next;
			});
		}, 5000);
		return () => window.clearInterval(t);
	}, []);
	// key remounts the span each cycle so the fade-in (ishot-msg-in) replays.
	return (
		<span key={idx} className="ai-thinking">
			{THINKING_WORDS[idx]}…
		</span>
	);
}

function ToolBtn({ children, active, onClick, style, title }: any) {
	return (
		<button
			onClick={onClick}
			title={title}
			style={{
				width: "var(--ctrl)",
				height: "var(--ctrl)",
				padding: 0,
				border: "none",
				borderRadius: "var(--radius-s)",
				background: active ? "var(--accent)" : "transparent",
				color: active ? "#fff" : "var(--label)",
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
	compact,
}: {
	value: number;
	options: number[];
	onChange: (v: number) => void;
	renderOption?: (v: number) => React.ReactNode;
	/** Icon-only 32×28 trigger + horizontal popup row — matches ShapePicker/ColorPicker. */
	compact?: boolean;
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
					width: compact ? 32 : undefined,
					minWidth: compact ? undefined : 40,
					borderRadius: "var(--radius-s)",
					border: "none",
					fontSize: 12,
					padding: compact ? 0 : "0 8px",
					cursor: "pointer",
					background: open ? "var(--accent)" : "var(--hover)",
					color: open ? "#fff" : "var(--label)",
					display: "flex",
					alignItems: "center",
					justifyContent: compact ? "center" : "flex-start",
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
						marginTop: 10,
						background: "var(--surface)",
						borderRadius: "var(--radius-m)",
						padding: "var(--pad)",
						boxShadow: "var(--shadow-pop)",
						zIndex: 200,
						display: "flex",
						flexDirection: compact ? "row" : "column",
						gap: "var(--gap)",
						minWidth: compact ? undefined : ref.current?.offsetWidth || 40,
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
								height: 28,
								width: compact ? 28 : undefined,
								border: "none",
								borderRadius: "var(--radius-s)",
								fontSize: 12,
								padding: compact ? 0 : "0 8px",
								background: v === value ? "var(--accent)" : "transparent",
								color: v === value ? "#fff" : "var(--label)",
								cursor: "pointer",
								fontFamily: "inherit",
								display: "flex",
								alignItems: "center",
								justifyContent: compact ? "center" : "flex-start",
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
 * Sloppiness selector (Excalidraw "hand-drawn" levels): smooth / artist /
 * cartoonist. Each option previews the roughness as a little squiggle.
 */
function SloppinessPicker({
	value,
	onChange,
}: {
	value: Sloppiness;
	onChange: (v: Sloppiness) => void;
}) {
	// Squiggle paths approximating each roughness level (viewBox 0 0 22 16).
	const PATHS: Record<Sloppiness, string> = {
		0: "M3 9 C 7 3, 10 3, 13 9 S 18 13, 19 7",
		1: "M3 9 q 2 -6 4 -1 q 2 5 4 -1 q 2 -5 4 1 q 1 3 3 0",
		2: "M3 8 l2 -4 l1 6 l3 -6 l1 5 l3 -5 l2 5 l3 -4",
	};
	const OPTIONS: { value: Sloppiness; title: string }[] = [
		{ value: 0, title: "Smooth" },
		{ value: 1, title: "Artist" },
		{ value: 2, title: "Cartoonist" },
	];
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
	const squiggle = (v: Sloppiness, on: boolean) => (
		<svg width="20" height="15" viewBox="0 0 22 16" fill="none">
			<path
				d={PATHS[v]}
				stroke={on ? "#fff" : "var(--label)"}
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
	return (
		<div ref={ref} style={{ position: "relative" }}>
			<button
				onClick={() => setOpen(!open)}
				title="Sloppiness"
				style={{
					width: 32,
					height: 28,
					padding: 0,
					borderRadius: "var(--radius-s)",
					border: "none",
					cursor: "pointer",
					background: open ? "var(--accent)" : "var(--hover)",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				}}
			>
				{squiggle(value, open)}
			</button>
			{open && (
				<div
					style={{
						position: "absolute",
						top: "100%",
						left: 0,
						marginTop: 10,
						background: "var(--surface)",
						borderRadius: "var(--radius-m)",
						padding: "var(--pad)",
						boxShadow: "var(--shadow-pop)",
						zIndex: 200,
						display: "flex",
						gap: "var(--gap)",
					}}
				>
					{OPTIONS.map((opt) => (
						<button
							key={opt.value}
							onClick={() => {
								onChange(opt.value);
								setOpen(false);
							}}
							title={opt.title}
							style={{
								width: 32,
								height: 28,
								padding: 0,
								border: "none",
								borderRadius: "var(--radius-s)",
								background:
									opt.value === value ? "var(--accent)" : "transparent",
								cursor: "pointer",
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
							}}
						>
							{squiggle(opt.value, opt.value === value)}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/**
 * Color selector: trigger shows the current swatch; the popover holds a
 * 4-column swatch grid. Replaces the inline strip of 8 swatches so the
 * options row stays compact (shape / stroke / color, three dropdowns).
 */
function ColorPicker({
	value,
	options,
	onChange,
}: {
	value: string;
	options: string[];
	onChange: (v: string) => void;
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
				title="Color"
				style={{
					width: 32,
					height: 28,
					padding: 0,
					borderRadius: "var(--radius-s)",
					border: "none",
					cursor: "pointer",
					background: open ? "var(--accent)" : "var(--hover)",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				}}
			>
				{/* Palette icon tinted with the current color — reads as "color"
				    and still shows the active swatch via the tint. */}
				<Palette size={17} color={open ? "#fff" : value} />
			</button>
			{open && (
				<div
					style={{
						position: "absolute",
						top: "100%",
						left: 0,
						marginTop: 10,
						background: "var(--surface)",
						borderRadius: "var(--radius-m)",
						padding: "var(--pad)",
						boxShadow: "var(--shadow-pop)",
						zIndex: 200,
						display: "grid",
						gridTemplateColumns: "repeat(4, 24px)",
						gap: "var(--gap)",
					}}
				>
					{options.map((color) => (
						<button
							key={color}
							onClick={() => {
								onChange(color);
								setOpen(false);
							}}
							style={{
								width: 24,
								height: 24,
								borderRadius: 5,
								background: color,
								border:
									color === value
										? "2px solid var(--accent)"
										: "1px solid rgba(0,0,0,0.12)",
								cursor: "pointer",
								padding: 0,
							}}
						/>
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
