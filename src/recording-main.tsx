import React from "react";
import ReactDOM from "react-dom/client";
import Recording from "./Recording";
// Use the app's design tokens (var(--surface), --label, --accent, …) so the
// record bar matches the capture toolbar exactly.
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<Recording />
	</React.StrictMode>,
);
