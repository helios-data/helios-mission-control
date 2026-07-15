import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inconsolata/latin-400.css";
import "@fontsource/inconsolata/latin-700.css";
import "../styles/base.css";
import "./admin.css";
import { App } from "./App";
import { initThemeEarly } from "../lib/theme";

initThemeEarly();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
