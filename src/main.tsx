import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { OverlayErrorBoundary } from "./OverlayErrorBoundary";
import "./theme.css";
import "./styles.css";
import { initTheme } from "./theme";

initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <OverlayErrorBoundary>
      <App />
    </OverlayErrorBoundary>
  </React.StrictMode>,
);
