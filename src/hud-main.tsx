import React from "react";
import ReactDOM from "react-dom/client";
import Hud from "./Hud";
import "./tailwind.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Hud />
  </React.StrictMode>,
);
