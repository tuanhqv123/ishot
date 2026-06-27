import React from "react";
import ReactDOM from "react-dom/client";
import Settings from "./Settings";
import "./theme.css";
import "./settings.css";
import { initTheme } from "./theme";

initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Settings />
  </React.StrictMode>,
);
