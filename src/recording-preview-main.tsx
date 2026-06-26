import React from "react";
import ReactDOM from "react-dom/client";
import RecordingPreview from "./RecordingPreview";
import "./tailwind.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<RecordingPreview />
	</React.StrictMode>,
);
