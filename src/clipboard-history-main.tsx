import React from "react";
import ReactDOM from "react-dom/client";
import ClipboardHistory from "./ClipboardHistory";
import "./clipboard-history.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ClipboardHistory />
  </React.StrictMode>,
);
