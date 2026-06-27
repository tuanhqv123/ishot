import React from "react";
import ReactDOM from "react-dom/client";
import ClipboardHistory from "./ClipboardHistory";
import "./theme.css";
import "./clipboard-history.css";
import { initTheme } from "./theme";

initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ClipboardHistory />
  </React.StrictMode>,
);
