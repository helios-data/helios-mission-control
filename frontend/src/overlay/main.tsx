import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inconsolata/latin-400.css";
import "@fontsource/inconsolata/latin-700.css";
import "../styles/base.css";
import "./overlay.css";
import { App } from "./App";
import { initThemeEarly } from "../lib/theme";

initThemeEarly();

// ?transparent=1 -> keyed background for OBS browser-source compositing.
if (new URLSearchParams(location.search).get("transparent") === "1") {
  document.documentElement.classList.add("transparent");
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
