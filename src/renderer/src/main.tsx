import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import type { JadeApi } from "../../preload/index";
import "./styles.css";

declare global {
  interface Window {
    jade: JadeApi;
  }
}

const container = document.getElementById("root");
if (!container) throw new Error("Root-element ontbreekt in index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
