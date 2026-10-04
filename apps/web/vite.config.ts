import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The page the server serves from apps/web/dist (architecture/web.md). */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  // One local bundle; its size does not travel over a network.
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0, chunkSizeWarningLimit: 1500 },
});
