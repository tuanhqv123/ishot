/**
 * Build all platform icons from `design/icon.svg` and `design/tray.svg`.
 *
 * Run: `bun run scripts/build-icons.ts`
 *
 * App icon: rasterizes to the PNG sizes Tauri / macOS expect, builds an
 * .icns bundle via `iconutil` (built-in on macOS).
 *
 * Tray icon: monochrome PNG at 22 / 44 / 66 px. macOS treats the @1x file
 * as a "template image" when the file name ends with `Template.png` OR when
 * the code explicitly marks it as such; here we wire the latter in main.rs.
 */
import { Resvg } from "@resvg/resvg-js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const ICONS_DIR = path.join(ROOT, "src-tauri", "icons");

async function rasterize(svgPath: string, outPath: string, size: number) {
	const svg = await readFile(svgPath);
	const resvg = new Resvg(svg, {
		fitTo: { mode: "width", value: size },
		background: "rgba(0,0,0,0)",
	});
	await writeFile(outPath, resvg.render().asPng());
	console.log(`  ${path.basename(outPath)} (${size}×${size})`);
}

async function buildApp() {
	const src = path.join(ROOT, "design", "icon.svg");
	console.log("App icon →");

	// Tauri standard names (referenced by tauri.conf.json bundle.icon).
	const tauriSizes: Array<[string, number]> = [
		["32x32.png", 32],
		["64x64.png", 64],
		["128x128.png", 128],
		["128x128@2x.png", 256],
		["512x512.png", 512],
		["icon.png", 1024],
	];
	for (const [name, size] of tauriSizes) {
		await rasterize(src, path.join(ICONS_DIR, name), size);
	}

	// Build .icns via iconutil (macOS-only). Uses a temporary .iconset folder
	// with Apple's required naming pattern.
	const iconset = path.join(ICONS_DIR, "icon.iconset");
	await rm(iconset, { recursive: true, force: true });
	await mkdir(iconset);
	const icnsSizes: Array<[string, number]> = [
		["icon_16x16.png", 16],
		["icon_16x16@2x.png", 32],
		["icon_32x32.png", 32],
		["icon_32x32@2x.png", 64],
		["icon_128x128.png", 128],
		["icon_128x128@2x.png", 256],
		["icon_256x256.png", 256],
		["icon_256x256@2x.png", 512],
		["icon_512x512.png", 512],
		["icon_512x512@2x.png", 1024],
	];
	for (const [name, size] of icnsSizes) {
		await rasterize(src, path.join(iconset, name), size);
	}
	execSync(
		`iconutil -c icns "${iconset}" -o "${path.join(ICONS_DIR, "icon.icns")}"`,
		{ stdio: "inherit" },
	);
	await rm(iconset, { recursive: true, force: true });
	console.log("  icon.icns");
}

async function buildFavicon() {
	const src = path.join(ROOT, "design", "favicon.svg");
	console.log("Favicon →");
	// Browser-tab favicons live at 16-32 px most of the time; 192 covers the
	// PWA / "Add to Home Screen" case. All three share the same fill-canvas
	// SVG (no Apple-HIG padding) so the mark stays readable at thumbnail size.
	const sizes: Array<[string, number]> = [
		["favicon-16.png", 16],
		["favicon-32.png", 32],
		["favicon-48.png", 48],
		["favicon-192.png", 192],
	];
	for (const [name, size] of sizes) {
		await rasterize(src, path.join(ICONS_DIR, name), size);
	}
}

async function buildTray() {
	const src = path.join(ROOT, "design", "tray.svg");
	console.log("Tray icon →");
	// 22pt × {1,2,3} retina scales. The base file (tray_icon.png) is what
	// main.rs loads; the @2x/@3x variants are read by macOS via the
	// `tray_icon` crate when present alongside.
	await rasterize(src, path.join(ICONS_DIR, "tray_icon.png"), 22);
	await rasterize(src, path.join(ICONS_DIR, "tray_icon@2x.png"), 44);
	await rasterize(src, path.join(ICONS_DIR, "tray_icon@3x.png"), 66);
}

await buildApp();
await buildFavicon();
await buildTray();
console.log("\nDone. Icons written to src-tauri/icons/");
