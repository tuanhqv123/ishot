// Central icon set — Phosphor Icons (https://phosphoricons.com).
//
// We migrated off lucide-react because its icons had uneven optical sizing and
// stroke weights in our dense toolbar. Phosphor is drawn on a uniform 256-unit
// grid with consistent weights, so everything lines up.
//
// Re-exported under the names the app already uses (the old lucide names) so the
// call sites don't all have to change — only the import path does. A couple are
// intentionally remapped to more characterful icons (Drop for blur, a paper
// plane for the AI send button, Shapes for the shapes entry, etc.).
export {
	ArrowRightIcon as ArrowRight,
	PaperPlaneTiltIcon as ArrowUp, // AI chat "send" button
	TextTIcon as CaseSensitive, // text tool
	CheckIcon as Check,
	CircleIcon as Circle,
	DownloadSimpleIcon as Download,
	DropIcon as Droplet, // blur tool
	CardsIcon as Cards, // scroll capture — stacked/overlapping frames
	TranslateIcon as Languages, // translate
	MicrophoneIcon as Mic,
	MicrophoneSlashIcon as MicOff,
	MinusIcon as Minus, // line tool
	PaletteIcon as Palette,
	ShapesIcon as PencilSparkles, // shapes entry button
	PencilSimpleIcon as Pencil, // draw tool
	ScanIcon as ScanText, // OCR
	CaretDownIcon as ChevronDown,
	SparkleIcon as Sparkles, // AI
	SquareIcon as Square,
	ArrowUUpLeftIcon as Undo2, // undo
	VideoCameraIcon as Video,
	VideoCameraSlashIcon as VideoOff,
	XIcon as X,
	PauseIcon as Pause,
	PlayIcon as Play,
	PushPinIcon as Pin, // pin-to-screen
	TextAlignLeftIcon as AlignLeft,
	TextAlignCenterIcon as AlignCenter,
	TextAlignRightIcon as AlignRight,
	EyeIcon as Eye,
	EyeSlashIcon as EyeOff,
	CheckCircleIcon as CheckCircle,
} from "@phosphor-icons/react";

// Component type for props that accept "any icon" (was lucide's LucideIcon).
export type { Icon as LucideIcon } from "@phosphor-icons/react";

// Scroll capture uses lucide's "image-down" (a picture with a down arrow) —
// Phosphor has no equivalent. ToolIcon reads each icon's viewBox, so a lucide
// glyph optically matches the Phosphor ones. Cast to the shared icon type.
import { ImageDown as LucideImageDown } from "lucide-react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
export const ImageDown = LucideImageDown as unknown as PhosphorIcon;
