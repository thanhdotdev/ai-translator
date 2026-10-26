import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Chrome content scripts run as classic scripts: bundle their UI independently.
export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: "src/content/index.tsx",
      name: "AITranslatorContent",
      formats: ["iife"],
      fileName: () => "content.js"
    }
  }
});
