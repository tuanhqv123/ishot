import { useEffect, useState, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface Region { x: number; y: number; width: number; height: number; }
interface TextBlock { text: string; x: number; y: number; width: number; height: number; confidence: number; }

interface Annotation {
  id: number;
  type: "rect" | "oval" | "arrow" | "line" | "draw" | "blur";
  x: number; y: number;
  w?: number; h?: number;
  ex?: number; ey?: number;
  path?: { x: number; y: number }[];
  blurStrength?: number;
  blurMode?: "rect" | "draw";
  color?: string;
}

type Stage = "idle" | "selecting" | "editing";
type Tool = "rect" | "oval" | "arrow" | "line" | "draw" | "blur" | "text" | null;

let annotationId = 0;

function App() {
  const [stage, setStage] = useState<Stage>("idle");
  const [capturedImage, setCapturedImage] = useState("");
  const [imgDims, setImgDims] = useState({ w: 0, h: 0 });
  const [selection, setSelection] = useState<Region | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [currentPath, setCurrentPath] = useState<{ x: number; y: number }[]>([]);
  const [selectedAnnotation, setSelectedAnnotation] = useState<number | null>(null);
  const [blurStrength, setBlurStrength] = useState(10);
  const [tempBlur, setTempBlur] = useState<Region | null>(null);
  
  // Color picker
  const COLORS = ["#ff0000", "#ff9500", "#ffcc00", "#34c759", "#007aff", "#af52de", "#000000"];
  const [strokeColor, setStrokeColor] = useState(() => localStorage.getItem("ishot-color") || "#ff0000");
  const [showColorPicker, setShowColorPicker] = useState(false);
  
  // OCR
  const [textBlocks, setTextBlocks] = useState<TextBlock[]>([]);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [selectedText, setSelectedText] = useState("");
  const [selectedBlockIndices, setSelectedBlockIndices] = useState<Set<number>>(new Set());
  const [isSelectingText, setIsSelectingText] = useState(false);
  const textSelectionStart = useRef<{ x: number; y: number } | null>(null);
  const textSelectionRect = useRef<Region | null>(null);

  const cancelCapture = useCallback(async () => {
    setCapturedImage(""); setSelection(null); setStage("idle"); setIsDragging(false);
    setAnnotations([]); setTextBlocks([]); setSelectedText(""); setSelectedBlockIndices(new Set());
    setOcrLoading(false); setSelectedAnnotation(null); setTool(null); setTempBlur(null);
    setShowColorPicker(false);
    dragStartRef.current = null;
    try { await getCurrentWindow().hide(); } catch (e) { console.error(e); }
  }, []);

  // Simple box blur implementation
  const applyBoxBlur = (imageData: ImageData, radius: number) => {
    const data = imageData.data;
    const w = imageData.width, h = imageData.height;
    const copy = new Uint8ClampedArray(data);
    const passes = 3; // Multiple passes for smoother blur
    
    for (let pass = 0; pass < passes; pass++) {
      // Horizontal pass
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let r = 0, g = 0, b = 0, a = 0, count = 0;
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = Math.min(w - 1, Math.max(0, x + dx));
            const idx = (y * w + nx) * 4;
            r += copy[idx]; g += copy[idx + 1]; b += copy[idx + 2]; a += copy[idx + 3];
            count++;
          }
          const idx = (y * w + x) * 4;
          data[idx] = r / count; data[idx + 1] = g / count; data[idx + 2] = b / count; data[idx + 3] = a / count;
        }
      }
      copy.set(data);
      // Vertical pass
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let r = 0, g = 0, b = 0, a = 0, count = 0;
          for (let dy = -radius; dy <= radius; dy++) {
            const ny = Math.min(h - 1, Math.max(0, y + dy));
            const idx = (ny * w + x) * 4;
            r += copy[idx]; g += copy[idx + 1]; b += copy[idx + 2]; a += copy[idx + 3];
            count++;
          }
          const idx = (y * w + x) * 4;
          data[idx] = r / count; data[idx + 1] = g / count; data[idx + 2] = b / count; data[idx + 3] = a / count;
        }
      }
      copy.set(data);
    }
  };

  const renderFinalImage = useCallback(async (): Promise<Uint8Array | null> => {
    if (!capturedImage || !selection) return null;
    const canvas = document.createElement("canvas");
    const img = new Image(); img.src = capturedImage;
    await new Promise(r => img.onload = r);
    const scaleX = img.naturalWidth / window.innerWidth;
    const scaleY = img.naturalHeight / window.innerHeight;
    const sw = Math.round(selection.width * scaleX);
    const sh = Math.round(selection.height * scaleY);
    canvas.width = sw; canvas.height = sh;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, selection.x * scaleX, selection.y * scaleY, sw, sh, 0, 0, sw, sh);

    // Apply blur using box blur algorithm
    for (const ann of annotations) {
      if (ann.type === "blur" && ann.w && ann.h) {
        const strength = Math.round((ann.blurStrength || 10) * Math.max(scaleX, scaleY) / 2);
        const bx = Math.round(Math.min(ann.x, ann.x + ann.w) * scaleX);
        const by = Math.round(Math.min(ann.y, ann.y + ann.h) * scaleY);
        const bw = Math.round(Math.abs(ann.w) * scaleX);
        const bh = Math.round(Math.abs(ann.h) * scaleY);
        
        if (bw > 0 && bh > 0) {
          const imageData = ctx.getImageData(bx, by, bw, bh);
          applyBoxBlur(imageData, strength);
          ctx.putImageData(imageData, bx, by);
        }
      }
    }

    if (canvasRef.current) ctx.drawImage(canvasRef.current, 0, 0, selection.width, selection.height, 0, 0, sw, sh);
    const base64 = canvas.toDataURL("image/png").split(",")[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }, [capturedImage, selection, annotations]);

  const handleDone = useCallback(async () => {
    const bytes = await renderFinalImage();
    if (bytes) { await invoke("copy_to_clipboard", { imageBytes: Array.from(bytes) }); await cancelCapture(); }
  }, [renderFinalImage, cancelCapture]);

  const handleSave = useCallback(async () => {
    const bytes = await renderFinalImage();
    if (bytes) { try { await invoke("save_to_file", { imageBytes: Array.from(bytes) }); await cancelCapture(); } catch(e) { console.error(e); } }
  }, [renderFinalImage, cancelCapture]);

  const deleteSelectedAnnotation = useCallback(() => {
    if (selectedAnnotation !== null) {
      setAnnotations(prev => prev.filter(a => a.id !== selectedAnnotation));
      setSelectedAnnotation(null);
    }
  }, [selectedAnnotation]);

  const performOcr = useCallback(async () => {
    if (!capturedImage || !selection || ocrLoading) return;
    setOcrLoading(true);
    try {
      const canvas = document.createElement("canvas");
      const img = new Image(); img.src = capturedImage;
      await new Promise(r => img.onload = r);
      const scaleX = img.naturalWidth / window.innerWidth;
      const scaleY = img.naturalHeight / window.innerHeight;
      canvas.width = Math.round(selection.width * scaleX);
      canvas.height = Math.round(selection.height * scaleY);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, selection.x * scaleX, selection.y * scaleY, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      const base64 = canvas.toDataURL("image/png").split(",")[1];
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const result = await invoke<{blocks: TextBlock[]}>("perform_ocr", { pngData: Array.from(bytes) });
      setTextBlocks(result.blocks.map(b => ({ ...b, x: b.x / scaleX, y: b.y / scaleY, width: b.width / scaleX, height: b.height / scaleY })));
    } catch (e) { console.error(e); }
    finally { setOcrLoading(false); }
  }, [capturedImage, selection, ocrLoading]);

  const handleToolChange = useCallback((newTool: Tool) => {
    setTool(newTool); setSelectedAnnotation(null); setShowColorPicker(false);
    if (newTool === "text" && textBlocks.length === 0 && !ocrLoading) performOcr();
    if (newTool !== "text") { setSelectedText(""); setSelectedBlockIndices(new Set()); }
  }, [textBlocks.length, ocrLoading, performOcr]);

  useEffect(() => {
    const unlisten = listen<{ data: string, width: number, height: number }>("screenshot-ready", (event) => {
      const { data, width, height } = event.payload;
      setCapturedImage(`data:image/png;base64,${data}`);
      setImgDims({ w: width, h: height }); setStage("selecting"); setSelection(null);
      setAnnotations([]); setTextBlocks([]); setSelectedText(""); setSelectedBlockIndices(new Set());
      setTool(null); setSelectedAnnotation(null); setTempBlur(null);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelCapture();
      else if ((e.metaKey || e.ctrlKey) && e.key === "c" && selectedText) {
        e.preventDefault(); await navigator.clipboard.writeText(selectedText); cancelCapture();
      } else if ((e.key === "Backspace" || e.key === "Delete") && selectedAnnotation !== null) {
        e.preventDefault(); deleteSelectedAnnotation();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cancelCapture, selectedText, selectedAnnotation, deleteSelectedAnnotation]);

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
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    
    for (const ann of annotations) {
      if (ann.type === "blur") continue;
      const isSelected = ann.id === selectedAnnotation;
      ctx.strokeStyle = isSelected ? "#007aff" : (ann.color || "#ff0000");
      ctx.lineWidth = isSelected ? 3 : 2;
      
      if (ann.type === "rect" && ann.w !== undefined) {
        ctx.strokeRect(ann.x, ann.y, ann.w, ann.h!);
      } else if (ann.type === "oval" && ann.w !== undefined) {
        ctx.beginPath();
        ctx.ellipse(ann.x + ann.w / 2, ann.y + ann.h! / 2, Math.abs(ann.w / 2), Math.abs(ann.h! / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (ann.type === "arrow" && ann.ex !== undefined) {
        const headLen = 12, angle = Math.atan2(ann.ey! - ann.y, ann.ex - ann.x);
        ctx.beginPath(); ctx.moveTo(ann.x, ann.y); ctx.lineTo(ann.ex, ann.ey!); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(ann.ex, ann.ey!);
        ctx.lineTo(ann.ex - headLen * Math.cos(angle - Math.PI / 6), ann.ey! - headLen * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(ann.ex, ann.ey!);
        ctx.lineTo(ann.ex - headLen * Math.cos(angle + Math.PI / 6), ann.ey! - headLen * Math.sin(angle + Math.PI / 6));
        ctx.stroke();
      } else if (ann.type === "line" && ann.ex !== undefined) {
        ctx.beginPath(); ctx.moveTo(ann.x, ann.y); ctx.lineTo(ann.ex, ann.ey!); ctx.stroke();
      } else if (ann.type === "draw" && ann.path && ann.path.length > 1) {
        ctx.beginPath(); ctx.moveTo(ann.path[0].x, ann.path[0].y);
        for (let i = 1; i < ann.path.length; i++) ctx.lineTo(ann.path[i].x, ann.path[i].y);
        ctx.stroke();
      }
    }
  }, [annotations, selection, selectedAnnotation]);

  useEffect(() => { if (stage === "editing") redrawAnnotations(); }, [annotations, stage, redrawAnnotations, selectedAnnotation]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (stage === "selecting") {
      e.preventDefault(); setIsDragging(true);
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      setSelection(null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (stage === "selecting" && isDragging && dragStartRef.current) {
      e.preventDefault();
      const start = dragStartRef.current;
      setSelection({ x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY),
        width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y) });
    }
  };

  const handleMouseUp = () => {
    if (stage === "selecting" && isDragging) {
      setIsDragging(false); dragStartRef.current = null;
      if (selection && selection.width > 10 && selection.height > 10) { setStage("editing"); setTool(null); }
      else setSelection(null);
    }
  };

  const isPointInAnnotation = (ann: Annotation, x: number, y: number): boolean => {
    const tol = 12;
    if (ann.type === "blur" && ann.w !== undefined) {
      const minX = Math.min(ann.x, ann.x + ann.w), maxX = Math.max(ann.x, ann.x + ann.w);
      const minY = Math.min(ann.y, ann.y + ann.h!), maxY = Math.max(ann.y, ann.y + ann.h!);
      return x >= minX && x <= maxX && y >= minY && y <= maxY;
    }
    if (ann.type === "rect" && ann.w !== undefined) {
      const minX = Math.min(ann.x, ann.x + ann.w), maxX = Math.max(ann.x, ann.x + ann.w);
      const minY = Math.min(ann.y, ann.y + ann.h!), maxY = Math.max(ann.y, ann.y + ann.h!);
      return (Math.abs(x - minX) < tol || Math.abs(x - maxX) < tol) && y >= minY - tol && y <= maxY + tol ||
             (Math.abs(y - minY) < tol || Math.abs(y - maxY) < tol) && x >= minX - tol && x <= maxX + tol;
    }
    if (ann.type === "oval" && ann.w !== undefined) {
      const cx = ann.x + ann.w / 2, cy = ann.y + ann.h! / 2;
      const rx = Math.abs(ann.w / 2), ry = Math.abs(ann.h! / 2);
      if (rx < 5 || ry < 5) return false;
      const dist = Math.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2);
      return Math.abs(dist - 1) < 0.4;
    }
    if ((ann.type === "arrow" || ann.type === "line") && ann.ex !== undefined) {
      const A = x - ann.x, B = y - ann.y, C = ann.ex - ann.x, D = ann.ey! - ann.y;
      const lenSq = C * C + D * D;
      if (lenSq === 0) return Math.sqrt(A * A + B * B) < tol;
      const t = Math.max(0, Math.min(1, (A * C + B * D) / lenSq));
      const px = ann.x + t * C, py = ann.y + t * D;
      return Math.sqrt((x - px) ** 2 + (y - py) ** 2) < tol;
    }
    if (ann.type === "draw" && ann.path) {
      for (const p of ann.path) if (Math.sqrt((p.x - x) ** 2 + (p.y - y) ** 2) < tol) return true;
    }
    return false;
  };

  const rectsIntersect = (r1: Region, r2: Region): boolean => {
    return !(r2.x > r1.x + r1.width || r2.x + r2.width < r1.x || r2.y > r1.y + r1.height || r2.y + r2.height < r1.y);
  };

  // Text selection
  const handleTextMouseDown = (e: React.MouseEvent) => {
    if (tool !== "text" || !selection) return;
    e.preventDefault(); e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setIsSelectingText(true);
    textSelectionStart.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    textSelectionRect.current = { x: e.clientX - rect.left, y: e.clientY - rect.top, width: 0, height: 0 };
    setSelectedBlockIndices(new Set()); setSelectedText("");
  };

  const handleTextMouseMove = (e: React.MouseEvent) => {
    if (!isSelectingText || !textSelectionStart.current || !selection) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const start = textSelectionStart.current;
    const selRect: Region = { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
    textSelectionRect.current = selRect;
    const selectedIndices = new Set<number>();
    textBlocks.forEach((block, idx) => {
      if (rectsIntersect(selRect, { x: block.x, y: block.y, width: block.width, height: block.height })) selectedIndices.add(idx);
    });
    setSelectedBlockIndices(selectedIndices);
    const selectedBlocks = textBlocks.map((b, i) => ({ ...b, idx: i })).filter(b => selectedIndices.has(b.idx))
      .sort((a, b) => Math.abs(a.y - b.y) < 10 ? a.x - b.x : a.y - b.y);
    const lines: string[][] = []; let currentLine: string[] = []; let lastY = -1000;
    for (const block of selectedBlocks) {
      if (lastY === -1000 || Math.abs(block.y - lastY) < 10) currentLine.push(block.text);
      else { if (currentLine.length > 0) lines.push(currentLine); currentLine = [block.text]; }
      lastY = block.y;
    }
    if (currentLine.length > 0) lines.push(currentLine);
    setSelectedText(lines.map(l => l.join(" ")).join("\n"));
  };

  const handleTextMouseUp = () => { setIsSelectingText(false); textSelectionStart.current = null; textSelectionRect.current = null; };

  // Canvas handlers
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (stage !== "editing" || !selection) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    
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
    else if (tool === "blur") setTempBlur({ x, y, width: 0, height: 0 });
  };

  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    if (!isDrawing || !drawStart || !tool) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    
    if (tool === "blur") {
      setTempBlur({ x: Math.min(drawStart.x, x), y: Math.min(drawStart.y, y),
        width: Math.abs(x - drawStart.x), height: Math.abs(y - drawStart.y) });
      return;
    }
    
    if (tool === "draw") setCurrentPath(prev => [...prev, { x, y }]);
    
    redrawAnnotations();
    const ctx = canvasRef.current!.getContext("2d")!;
    ctx.strokeStyle = strokeColor; ctx.lineWidth = 2; ctx.lineCap = "round";
    
    if (tool === "rect") ctx.strokeRect(drawStart.x, drawStart.y, x - drawStart.x, y - drawStart.y);
    else if (tool === "oval") {
      ctx.beginPath();
      ctx.ellipse((drawStart.x + x) / 2, (drawStart.y + y) / 2, Math.abs(x - drawStart.x) / 2, Math.abs(y - drawStart.y) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (tool === "arrow") {
      const headLen = 12, angle = Math.atan2(y - drawStart.y, x - drawStart.x);
      ctx.beginPath(); ctx.moveTo(drawStart.x, drawStart.y); ctx.lineTo(x, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y);
      ctx.lineTo(x - headLen * Math.cos(angle - Math.PI / 6), y - headLen * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(x, y);
      ctx.lineTo(x - headLen * Math.cos(angle + Math.PI / 6), y - headLen * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    } else if (tool === "line") {
      ctx.beginPath(); ctx.moveTo(drawStart.x, drawStart.y); ctx.lineTo(x, y); ctx.stroke();
    } else if (tool === "draw" && currentPath.length > 0) {
      ctx.beginPath(); ctx.moveTo(currentPath[0].x, currentPath[0].y);
      for (const p of currentPath) ctx.lineTo(p.x, p.y);
      ctx.lineTo(x, y); ctx.stroke();
    }
  };

  const handleCanvasMouseUp = (e: React.MouseEvent) => {
    if (!isDrawing || !drawStart || !tool) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const id = ++annotationId;
    
    if (tool === "rect") setAnnotations(prev => [...prev, { id, type: "rect", x: drawStart.x, y: drawStart.y, w: x - drawStart.x, h: y - drawStart.y, color: strokeColor }]);
    else if (tool === "oval") setAnnotations(prev => [...prev, { id, type: "oval", x: drawStart.x, y: drawStart.y, w: x - drawStart.x, h: y - drawStart.y, color: strokeColor }]);
    else if (tool === "arrow") setAnnotations(prev => [...prev, { id, type: "arrow", x: drawStart.x, y: drawStart.y, ex: x, ey: y, color: strokeColor }]);
    else if (tool === "line") setAnnotations(prev => [...prev, { id, type: "line", x: drawStart.x, y: drawStart.y, ex: x, ey: y, color: strokeColor }]);
    else if (tool === "draw") setAnnotations(prev => [...prev, { id, type: "draw", x: 0, y: 0, path: [...currentPath, { x, y }], color: strokeColor }]);
    else if (tool === "blur" && tempBlur && tempBlur.width > 5 && tempBlur.height > 5) {
      setAnnotations(prev => [...prev, { id, type: "blur", x: tempBlur.x, y: tempBlur.y, w: tempBlur.width, h: tempBlur.height, blurStrength }]);
    }
    
    setTool(null);
    setIsDrawing(false); setDrawStart(null); setCurrentPath([]); setTempBlur(null);
  };

  const selectedBlurAnn = selectedAnnotation !== null ? annotations.find(a => a.id === selectedAnnotation && a.type === "blur") : null;

  const updateBlurStrength = (strength: number) => {
    setBlurStrength(strength);
    if (selectedAnnotation !== null) {
      setAnnotations(prev => prev.map(a => a.id === selectedAnnotation ? { ...a, blurStrength: strength } : a));
    }
  };

  if (stage === "idle") return <div style={{ width: "100vw", height: "100vh", background: "transparent" }} />;
  const scale = imgDims.w > 0 ? imgDims.w / window.innerWidth : 2;
  
  const getHintText = () => {
    if (selectedAnnotation !== null) return "Press ⌫ to delete";
    if (tool === "text" && !ocrLoading) {
      if (selectedText) return "⌘C to copy";
      if (textBlocks.length > 0) return "Drag to select text, then ⌘C to copy";
    }
    return null;
  };

  return (
    <div style={{ position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh",
      cursor: stage === "selecting" ? "crosshair" : (tool ? "crosshair" : "default"), userSelect: "none", overflow: "hidden" }}
      onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp}>
      
      {capturedImage && <img src={capturedImage} alt="" style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "top left", pointerEvents: "none" }} />}
      
      {stage === "selecting" && !selection && <div style={{ position: "absolute", top: 0, left: 0, width: "100vw", height: "100vh", background: "rgba(0,0,0,0.3)", pointerEvents: "none" }} />}
      
      {selection && selection.width > 0 && (
        <div style={{ position: "absolute", top: 0, left: 0, width: "100vw", height: "100vh", background: "rgba(0,0,0,0.5)", pointerEvents: "none",
          clipPath: `polygon(0% 0%, 0% 100%, ${selection.x}px 100%, ${selection.x}px ${selection.y}px, ${selection.x + selection.width}px ${selection.y}px, ${selection.x + selection.width}px ${selection.y + selection.height}px, ${selection.x}px ${selection.y + selection.height}px, ${selection.x}px 100%, 100% 100%, 100% 0%)` }} />
      )}

      {selection && selection.width > 0 && (
        <>
          <div style={{ position: "absolute", left: selection.x, top: selection.y, width: selection.width, height: selection.height, border: "1px solid #fff", boxShadow: "0 0 0 1px rgba(0,0,0,0.3)", pointerEvents: "none" }} />
          <div style={{ position: "absolute", left: selection.x, top: selection.y - 20, background: "rgba(0,0,0,0.7)", color: "#fff", padding: "1px 5px", borderRadius: 2, fontSize: 11, pointerEvents: "none" }}>
            {Math.round(selection.width * scale)} × {Math.round(selection.height * scale)}
          </div>
        </>
      )}

      {stage === "editing" && selection && (
        <>
          {/* Blur regions */}
          {annotations.filter(a => a.type === "blur").map(ann => (
            <div key={ann.id} onClick={() => setSelectedAnnotation(ann.id)} style={{
              position: "absolute",
              left: selection.x + Math.min(ann.x, ann.x + (ann.w || 0)),
              top: selection.y + Math.min(ann.y, ann.y + (ann.h || 0)),
              width: Math.abs(ann.w || 0), height: Math.abs(ann.h || 0),
              backdropFilter: `blur(${ann.blurStrength || 10}px)`,
              WebkitBackdropFilter: `blur(${ann.blurStrength || 10}px)`,
              border: ann.id === selectedAnnotation ? "2px solid #007aff" : "none",
              cursor: "pointer", zIndex: 4,
            }} />
          ))}
          
          {/* Temp blur while drawing */}
          {tempBlur && tempBlur.width > 0 && (
            <div style={{ position: "absolute", left: selection.x + tempBlur.x, top: selection.y + tempBlur.y,
              width: tempBlur.width, height: tempBlur.height,
              backdropFilter: `blur(${blurStrength}px)`, WebkitBackdropFilter: `blur(${blurStrength}px)`,
              border: "1px dashed #007aff", pointerEvents: "none", zIndex: 4 }} />
          )}

          {/* Text selection layer */}
          {tool === "text" && (
            <div style={{ position: "absolute", left: selection.x, top: selection.y, width: selection.width, height: selection.height, cursor: "text", zIndex: 15 }}
              onMouseDown={handleTextMouseDown} onMouseMove={handleTextMouseMove} onMouseUp={handleTextMouseUp}>
              {textBlocks.map((block, idx) => (
                <div key={idx} style={{ position: "absolute", left: block.x, top: block.y, width: block.width, height: block.height,
                  background: selectedBlockIndices.has(idx) ? "rgba(0, 122, 255, 0.4)" : "rgba(255, 255, 0, 0.15)",
                  border: selectedBlockIndices.has(idx) ? "1px solid rgba(0, 122, 255, 0.8)" : "1px dashed rgba(0, 122, 255, 0.3)",
                  borderRadius: 2, pointerEvents: "none" }} />
              ))}
              {isSelectingText && textSelectionRect.current && textSelectionRect.current.width > 0 && (
                <div style={{ position: "absolute", left: textSelectionRect.current.x, top: textSelectionRect.current.y,
                  width: textSelectionRect.current.width, height: textSelectionRect.current.height,
                  border: "1px dashed #007aff", background: "rgba(0, 122, 255, 0.1)", pointerEvents: "none" }} />
              )}
            </div>
          )}

          {/* Annotation canvas */}
          <canvas ref={canvasRef} style={{ position: "absolute", left: selection.x, top: selection.y, width: selection.width, height: selection.height,
            pointerEvents: tool !== "text" ? "auto" : "none", cursor: tool ? "crosshair" : "default", zIndex: 10 }}
            onMouseDown={handleCanvasMouseDown} onMouseMove={handleCanvasMouseMove} onMouseUp={handleCanvasMouseUp} />

          {/* Main Toolbar */}
          <div style={{ position: "absolute", left: Math.max(10, Math.min(selection.x + selection.width / 2 - 195, window.innerWidth - 400)),
            top: Math.min(selection.y + selection.height + 8, window.innerHeight - 50),
            background: "rgba(255,255,255,0.95)", borderRadius: 6, padding: 4, display: "flex", gap: 2, boxShadow: "0 2px 10px rgba(0,0,0,0.2)", zIndex: 100 }}>
            <ToolBtn active={tool === "rect"} onClick={() => handleToolChange("rect")} title="Rectangle">▢</ToolBtn>
            <ToolBtn active={tool === "oval"} onClick={() => handleToolChange("oval")} title="Oval">○</ToolBtn>
            <ToolBtn active={tool === "arrow"} onClick={() => handleToolChange("arrow")} title="Arrow">→</ToolBtn>
            <ToolBtn active={tool === "line"} onClick={() => handleToolChange("line")} title="Line">╱</ToolBtn>
            <ToolBtn active={tool === "draw"} onClick={() => handleToolChange("draw")} title="Draw">✎</ToolBtn>
            <div style={{ width: 1, background: "#ddd", margin: "0 2px" }} />
            <ToolBtn active={showColorPicker} onClick={() => setShowColorPicker(!showColorPicker)} title="Color">
              <div style={{ width: 14, height: 14, borderRadius: 3, background: strokeColor, border: "1px solid rgba(0,0,0,0.2)" }} />
            </ToolBtn>
            <div style={{ width: 1, background: "#ddd", margin: "0 2px" }} />
            <ToolBtn active={tool === "blur"} onClick={() => handleToolChange("blur")} title="Blur">▦</ToolBtn>
            <div style={{ width: 1, background: "#ddd", margin: "0 2px" }} />
            <ToolBtn active={tool === "text"} onClick={() => handleToolChange("text")} title="OCR" style={{ fontWeight: "bold" }}>{ocrLoading ? "..." : "T"}</ToolBtn>
            <div style={{ width: 1, background: "#ddd", margin: "0 2px" }} />
            <ToolBtn onClick={handleSave} title="Save">⬇</ToolBtn>
            <ToolBtn onClick={cancelCapture} style={{ color: "#e00" }} title="Cancel">✕</ToolBtn>
            <ToolBtn onClick={handleDone} style={{ color: "#007aff" }} title="Copy">✓</ToolBtn>
          </div>

          {/* Color picker popup */}
          {showColorPicker && (
            <div style={{ position: "absolute", left: Math.max(10, Math.min(selection.x + selection.width / 2 - 195 + 140, window.innerWidth - 200)),
              top: Math.min(selection.y + selection.height + 48, window.innerHeight - 90),
              background: "rgba(255,255,255,0.95)", borderRadius: 6, padding: 6, display: "flex", gap: 4,
              boxShadow: "0 2px 10px rgba(0,0,0,0.2)", zIndex: 101 }}>
              {COLORS.map(color => (
                <button key={color} onClick={() => { setStrokeColor(color); localStorage.setItem("ishot-color", color); setShowColorPicker(false); }}
                  style={{ width: 22, height: 22, borderRadius: 4, background: color, border: color === strokeColor ? "2px solid #007aff" : "1px solid rgba(0,0,0,0.15)",
                    cursor: "pointer", padding: 0 }} />
              ))}
            </div>
          )}

          {/* Blur strength slider */}
          {(tool === "blur" || selectedBlurAnn) && (
            <div style={{ position: "absolute", left: Math.max(10, Math.min(selection.x + selection.width / 2 - 80, window.innerWidth - 170)),
              top: Math.min(selection.y + selection.height + 48, window.innerHeight - 90),
              background: "rgba(255,255,255,0.95)", borderRadius: 6, padding: "4px 10px", display: "flex", gap: 8, alignItems: "center",
              boxShadow: "0 2px 10px rgba(0,0,0,0.2)", fontSize: 12, zIndex: 100 }}>
              <span style={{ color: "#666", fontSize: 11 }}>Blur:</span>
              <input type="range" min="3" max="20" value={selectedBlurAnn?.blurStrength || blurStrength}
                onChange={(e) => updateBlurStrength(Number(e.target.value))} style={{ width: 80, cursor: "pointer" }} />
            </div>
          )}

          {/* Hint */}
          {getHintText() && (
            <div style={{ position: "absolute", left: selection.x,
              top: selection.y + selection.height + ((tool === "blur" || selectedBlurAnn) ? 88 : 45),
              maxWidth: selection.width, background: "rgba(0,0,0,0.85)", color: "#fff", padding: "6px 10px", borderRadius: 4, fontSize: 12, zIndex: 100 }}>
              {selectedText ? (<><div style={{ marginBottom: 4, opacity: 0.7 }}>{getHintText()}</div>
                <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 100, overflow: "auto" }}>
                  {selectedText.slice(0, 200)}{selectedText.length > 200 ? "..." : ""}</div></>
              ) : <div style={{ opacity: 0.9 }}>{getHintText()}</div>}
            </div>
          )}

          {ocrLoading && tool === "text" && (
            <div style={{ position: "absolute", left: selection.x + selection.width / 2 - 15, top: selection.y + selection.height / 2 - 15,
              width: 30, height: 30, border: "3px solid rgba(255,255,255,0.3)", borderTop: "3px solid #fff",
              borderRadius: "50%", animation: "spin 0.8s linear infinite", zIndex: 20 }} />
          )}
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </>
      )}
    </div>
  );
}

function ToolBtn({ children, active, onClick, style, title }: any) {
  return (<button onClick={onClick} title={title} style={{ width: 28, height: 28, border: "none", borderRadius: 4,
    background: active ? "#007aff" : "transparent", color: active ? "#fff" : "#333",
    cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", ...style }}>{children}</button>);
}

export default App;
