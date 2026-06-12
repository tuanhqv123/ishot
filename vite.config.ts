import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig(async () => ({
	plugins: [react()],

	build: {
		rollupOptions: {
			input: {
				main: path.resolve(__dirname, "index.html"),
				recorder: path.resolve(__dirname, "recorder.html"),
				"scroll-panel": path.resolve(__dirname, "scroll-panel.html"),
				"scroll-border": path.resolve(__dirname, "scroll-border.html"),
				hud: path.resolve(__dirname, "hud.html"),
				"clipboard-history": path.resolve(__dirname, "clipboard-history.html"),
				settings: path.resolve(__dirname, "settings.html"),
			},
		},
	},

	// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
	//
	// 1. prevent vite from obscuring rust errors
	clearScreen: false,
	// 2. tauri expects a fixed port, fail if that port is not available
	server: {
		port: 1420,
		strictPort: true,
	},
	// 3. to make use of `TAURI_DEBUG` and other env variables
	// https://tauri.app/v1/api/config#buildconfig.beforedevcommand
	envPrefix: ["VITE_", "TAURI_"],
}));
