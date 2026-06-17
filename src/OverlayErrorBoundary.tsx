import React from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Safety net for the capture overlay.
 *
 * The overlay is a transparent, always-on-top, full-screen window. If its React
 * tree throws (a bad render, an undefined component, etc.) it would otherwise
 * stay up rendering nothing — trapping the user's screen with no way to dismiss
 * it, since Esc/cancel live inside the now-dead React tree.
 *
 * This boundary catches any such error and immediately tears the overlay down
 * at the native level (hide the window, release the pushed cursor) so the screen
 * is never left frozen. It renders nothing.
 */
export class OverlayErrorBoundary extends React.Component<
	{ children: React.ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidCatch(error: unknown) {
		console.error("[overlay] crashed — dismissing to avoid a stuck screen:", error);
		// Free the screen no matter what; ignore errors from these calls.
		invoke("release_overlay_cursor").catch(() => {});
		invoke("hide_overlay").catch(() => {});
	}

	render() {
		return this.state.failed ? null : this.props.children;
	}
}
