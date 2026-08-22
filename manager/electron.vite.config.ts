import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Buildopzet voor de Server Manager.
 *
 * Deze app woont in dezelfde repo als AllMid maar is er verder los van. Alles
 * gaat daarom naar manager/out: een build van de een overschrijft die van de
 * ander nooit, en beide kunnen naast elkaar draaien.
 *
 * Alle paden worden vanaf dit bestand berekend in plaats van vanaf de werkmap,
 * omdat electron-vite met --config vanuit de repo-root start terwijl de bronnen
 * hier onder manager/ liggen.
 */
const managerRoot = dirname(fileURLToPath(import.meta.url));
const here = (...parts: string[]): string => resolve(managerRoot, ...parts);

/**
 * electron-vite start Electron standaard met het "main"-veld uit package.json,
 * en dat wijst naar AllMid. Zonder deze regel opent `npm run manager:dev` dus de
 * verkeerde app. Zo hoeft er niets aan het gedeelde package.json te veranderen.
 */
process.env.ELECTRON_ENTRY ??= here("out", "main", "index.js");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: here("out", "main"),
      rollupOptions: { input: { index: here("src", "main", "index.ts") } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: here("out", "preload"),
      rollupOptions: { input: { index: here("src", "preload", "index.ts") } },
    },
  },
  renderer: {
    root: here("src", "renderer"),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: here("out", "renderer"),
      rollupOptions: { input: { index: here("src", "renderer", "index.html") } },
    },
  },
});
