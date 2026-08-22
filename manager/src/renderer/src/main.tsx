import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import type { ManagerApi } from "../../../shared/types";
import "./styles.css";

/**
 * De brug is hier één keer aan het venster geknoopt. ManagerApi beschrijft de
 * kern; de preload plakt er met een module-uitbreiding de rest aan vast, dus
 * `window.manager` kent alles zonder dat een scherm hoeft te casten.
 */
declare global {
  interface Window {
    manager: ManagerApi;
  }
}

const container = document.getElementById("root");
if (!container) throw new Error("Root-element ontbreekt in index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
