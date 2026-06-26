import React from "react";
import ReactDOM from "react-dom/client";
import Camera from "./Camera";
import "./tailwind.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<Camera />
	</React.StrictMode>,
);
